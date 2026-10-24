import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { RunnerError } from './runner.js';

// 访客会话直接调用 Anthropic Messages API，不再启动 Claude Code：访客本来就只聊天（可选联网搜索），
// 用不到本机工具，也不该占用主人的 Claude Code 订阅额度。

// Claude Code 的家族别名 → API 模型 ID。面板选的是 CLI 菜单里的名字，会先经模型目录解析，这里只兜底。
const ALIASES = {
  default: 'claude-opus-5-5', opus: 'claude-opus-5-5', best: 'claude-fable-5-1',
  sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1',
};
export const DEFAULT_API_MODEL = 'claude-opus-5-5';

export function apiModelId(model) {
  const id = String(model || '').replace(/\[1m\]$/, '');
  return ALIASES[id] || id || DEFAULT_API_MODEL;
}

const matches = (model, families) => families.some(family => model === family || model.startsWith(`${family}-`));
// 动态过滤版的联网搜索只支持这些模型（Claude API 文档，2026-10），其余用基础版。
const DYNAMIC_SEARCH = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6'];
// 服务端压缩：对话接近上下文上限时由 API 自动总结早期内容。
const COMPACTION = ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5'];
// 安全防护拒答时由服务端按拒答类别换模型重试。
const FALLBACKS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];
// 这些模型的思考块绑定会话前缀；角色卡或表情目录一改，系统提示就变了，旧思考块改为丢弃而不是让请求 400。
const PRESERVED_THINKING = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5'];

// 美元 / 百万 token：[输入, 输出]。缓存写入按输入 1.25 倍、读取按 0.1 倍估算；联网搜索每千次 10 美元。
const PRICES = [
  [['claude-fable-5-1', 'claude-fable-5'], [10, 50]],
  [['claude-opus-5-5'], [4, 20]],
  [['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'], [5, 25]],
  [['claude-sonnet-5-5', 'claude-sonnet-5'], [2, 10]],
  [['claude-sonnet-4-6', 'claude-sonnet-4-5'], [3, 15]],
  [['claude-haiku-5-5'], [0.1, 0.5]],
  [['claude-haiku-4-5'], [1, 5]],
];

export function estimateCost(model, usage) {
  const price = PRICES.find(([families]) => matches(model, families))?.[1];
  if (!price || !usage) return null;
  const [input, output] = price;
  const tokens = (usage.input_tokens || 0) * input + (usage.cache_creation_input_tokens || 0) * input * 1.25
    + (usage.cache_read_input_tokens || 0) * input * 0.1 + (usage.output_tokens || 0) * output;
  return tokens / 1e6 + (usage.server_tool_use?.web_search_requests || 0) * 0.01;
}

export function buildRequest(turn, messages) {
  const model = apiModelId(turn.model);
  const betas = [];
  const request = {
    model, max_tokens: 32000, messages,
    // 系统提示在同一会话里基本不变，自动缓存最后一个可缓存块，每轮只为新消息付全价。
    system: turn.system, cache_control: { type: 'ephemeral' },
  };
  if (turn.effort) request.output_config = { effort: turn.effort };
  if (matches(model, PRESERVED_THINKING)) {
    request.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
    betas.push('thinking-binding-controls-2026-08-01');
  }
  if ((turn.guestTools || []).includes('WebSearch')) {
    request.tools = [{ type: matches(model, DYNAMIC_SEARCH) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }
  if (matches(model, COMPACTION)) {
    request.context_management = { edits: [{ type: 'compact_20260112' }] };
    betas.push('compact-2026-01-12');
  }
  if (matches(model, FALLBACKS)) {
    request.fallbacks = 'default';
    betas.push('server-side-fallback-2026-07-01');
  }
  if (betas.length) request.betas = betas;
  return request;
}

// 中途换模型后，回传历史时要去掉边界之前的思考块、工具调用和没有配对结果的服务端工具调用（API 文档的回传规则）。
export function echoContent(content) {
  const boundary = content.findLastIndex(block => block.type === 'fallback');
  if (boundary < 0) return content;
  const results = new Set(content.filter(block => block.tool_use_id).map(block => block.tool_use_id));
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    if (block.type === 'server_tool_use') return results.has(block.id);
    return block.type === 'text' || block.type.endsWith('_tool_result');
  });
}

function userContent(text, images = [], documents = []) {
  const blocks = [
    ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
    ...documents.map(doc => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: doc.data }, title: doc.name })),
  ];
  return blocks.length ? [...blocks, { type: 'text', text }] : text;
}

function searchSummary(block) {
  if (!Array.isArray(block.content)) return `搜索失败（${block.content?.error_code || 'error'}）`;
  return block.content.map(result => `${result.title || ''} ${result.url || ''}`.trim()).join('\n');
}

function readHistory(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

async function writeHistory(file, messages) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(messages), { encoding: 'utf8', mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

let sharedClient = null;
function clientFor({ apiKey, baseUrl }) {
  // 留空时交给 SDK 自己找凭据（ANTHROPIC_API_KEY 等环境变量或 ant auth login 的登录信息）。
  const options = { maxRetries: 2, ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseURL: baseUrl } : {}) };
  const key = JSON.stringify(options);
  if (sharedClient?.key !== key) sharedClient = { key, client: new Anthropic(options) };
  return sharedClient.client;
}

/**
 * 访客的一轮：与 runTurn 同样的入参和返回形状，SessionManager 可以直接替换使用。
 * 历史（含思考块、搜索结果、压缩块）按 claudeSessionId 存在 historyDir 里，只追加不改写；/new 换会话 ID 即开新对话。
 * 不支持插话：attachInput 始终收到 null，Discord 会把进行中的新消息排到下一轮。
 */
export async function runApiTurn(turn, { historyDir, api = {}, signal, onEvent = () => {}, attachInput = () => {}, client = null }) {
  attachInput(null);
  const file = path.join(historyDir, `${turn.claudeSessionId}.json`);
  const history = readHistory(file) || [];
  const messages = [...history, { role: 'user', content: userContent(turn.prompt, turn.images, turn.documents) }];
  const anthropic = client || clientFor(api);
  const started = Date.now();
  let final = null;
  let costUsd = 0;
  let numTurns = 0;
  const texts = [];
  try {
    // pause_turn：服务端搜索循环到了次数上限，把这一段回传让它接着做，不追加新的用户消息。
    for (let continuation = 0; continuation < 5; continuation++) {
      const request = buildRequest(turn, messages);
      const stream = anthropic.beta.messages.stream(request, { signal });
      stream.on('streamEvent', event => {
        if (event.type === 'message_start') {
          if (!numTurns) onEvent({ type: 'init', claudeSessionId: turn.claudeSessionId, model: event.message.model, cwd: '', permissionMode: 'api' });
          onEvent({ type: 'segment' });
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') onEvent({ type: 'text', text: event.delta.text });
          else if (event.delta.type === 'thinking_delta' && event.delta.thinking) onEvent({ type: 'thinking', text: event.delta.thinking });
        }
      });
      stream.on('contentBlock', block => {
        if (block.type === 'server_tool_use') onEvent({ type: 'tool_use', id: block.id, name: block.name === 'web_search' ? 'WebSearch' : block.name, input: block.input });
        else if (block.type === 'web_search_tool_result') onEvent({ type: 'tool_result', id: block.tool_use_id, isError: !Array.isArray(block.content), text: searchSummary(block).slice(0, 4000) });
        else if (block.type === 'fallback') onEvent({ type: 'model_fallback', from: block.from?.model || '', to: block.to?.model || '', category: '' });
      });
      final = await stream.finalMessage();
      numTurns++;
      costUsd += estimateCost(final.model, final.usage) || 0;
      messages.push({ role: 'assistant', content: echoContent(final.content) });
      texts.push(final.content.filter(block => block.type === 'text').map(block => block.text).join(''));
      if (final.stop_reason !== 'pause_turn') break;
    }
  } catch (error) {
    if (error instanceof Anthropic.APIUserAbortError || signal?.aborted) {
      return { ok: false, interrupted: true, started: numTurns > 0, text: texts.join('\n\n') };
    }
    if (error instanceof Anthropic.AuthenticationError) throw new RunnerError('Anthropic API 认证失败：请在面板「访客」里填写 API Key，或设置 ANTHROPIC_API_KEY', 'api_auth');
    if (error instanceof Anthropic.PermissionDeniedError) throw new RunnerError(`当前 API Key 无权使用该模型（${error.message}）`, 'api_permission');
    if (error instanceof Anthropic.RateLimitError) return { ok: false, started: numTurns > 0, text: texts.join('\n\n'), error: '触发了额度或速率限制，稍后再试', costUsd: costUsd || null };
    if (error instanceof Anthropic.BadRequestError) throw new RunnerError(`API 拒绝了请求：${error.message}`, 'api_bad_request');
    if (error instanceof Anthropic.APIError) throw new RunnerError(`Anthropic API 出错（${error.status ?? '网络'}）：${error.message}`, 'api_error');
    if (/credential|api ?key|auth/i.test(error.message)) throw new RunnerError('没有找到 Anthropic API 凭据：请在面板「访客」里填写 API Key，或设置 ANTHROPIC_API_KEY', 'api_auth');
    throw error;
  }
  const refused = final.stop_reason === 'refusal';
  // 拒答的这一轮不写进历史，否则下一轮会带着半截回复继续。
  if (!refused) await writeHistory(file, messages);
  const text = texts.filter(Boolean).join('\n\n');
  return {
    ok: !refused, started: true, text,
    error: refused ? `安全防护拦下了这次回复${final.stop_details?.category ? `（${final.stop_details.category}）` : ''}` : '',
    usage: final.usage || null, costUsd: Number(costUsd.toFixed(6)), durationMs: Date.now() - started,
    numTurns, claudeSessionId: turn.claudeSessionId, denials: [],
  };
}
