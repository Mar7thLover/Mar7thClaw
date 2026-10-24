import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApiTurn, buildRequest, echoContent, apiModelId, estimateCost } from '../src/claude/api-runner.js';
import { SessionManager } from '../src/sessions.js';
import { CardStore } from '../src/persona/card.js';
import { DEFAULTS, merge } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 按顺序回放预先写好的回复（{ message } 或 { error }），并记录收到的请求。
function fakeClient(replies) {
  const requests = [];
  const stream = (request, options) => {
    requests.push({ request: structuredClone(request), options });
    const reply = replies.shift();
    const emitter = new EventEmitter();
    const done = (async () => {
      await new Promise(resolve => setImmediate(resolve));
      if (reply.error) throw reply.error;
      emitter.emit('streamEvent', { type: 'message_start', message: { model: reply.message.model } });
      for (const block of reply.message.content) {
        if (block.type === 'text') emitter.emit('streamEvent', { type: 'content_block_delta', delta: { type: 'text_delta', text: block.text } });
        emitter.emit('contentBlock', block);
      }
      return reply.message;
    })();
    return { on: (name, fn) => { emitter.on(name, fn); }, finalMessage: () => done };
  };
  return { requests, beta: { messages: { stream } } };
}

const msg = (content, extra = {}) => ({ model: 'claude-opus-5-5', content, stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 }, ...extra });
const baseTurn = { claudeSessionId: 'aaaa', system: 'SYS', prompt: '<message>hi</message>', model: 'sonnet', tier: 'guest', guestTools: ['WebSearch'] };

test('API 请求：别名解析、联网搜索、压缩、拒答换模型、思考块绑定', () => {
  assert.equal(apiModelId('opus[1m]'), 'claude-opus-5-5');
  assert.equal(apiModelId(''), 'claude-opus-5-5');
  assert.equal(apiModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
  const req = buildRequest({ ...baseTurn, effort: 'low' }, []);
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.deepEqual(req.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.deepEqual([...req.betas].sort(), ['compact-2026-01-12', 'server-side-fallback-2026-07-01', 'thinking-binding-controls-2026-08-01']);
  assert.equal(req.thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
  const old = buildRequest({ ...baseTurn, model: 'claude-haiku-4-5-20251001', guestTools: [] }, []);
  assert.equal(old.betas, undefined);
  assert.equal(old.tools, undefined);
  assert.equal(old.thinking, undefined);
  assert.ok(Math.abs(estimateCost('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }) - 24) < 1e-9);
});

test('API 回传：换模型边界之前只保留文字和配对的搜索结果', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 's' },
    { type: 'server_tool_use', id: 'a', name: 'web_search', input: {} },
    { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
    { type: 'server_tool_use', id: 'b', name: 'web_search', input: {} },
    { type: 'text', text: '前半' },
    { type: 'fallback', from: { model: 'x' }, to: { model: 'y' } },
    { type: 'thinking', thinking: '', signature: 't' },
    { type: 'text', text: '后半' },
  ];
  assert.deepEqual(echoContent(content).map(block => block.id || block.type), ['a', 'web_search_tool_result', 'text', 'fallback', 'thinking', 'text']);
  const plain = [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'x' }];
  assert.equal(echoContent(plain), plain);
});

test('API 访客轮：流式文字、搜索事件、历史只追加、pause_turn 续跑', async t => {
  const dir = tempDir(t);
  const search = { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '天气' } };
  const client = fakeClient([
    { message: msg([search], { stop_reason: 'pause_turn' }) },
    { message: msg([{ type: 'web_search_tool_result', tool_use_id: 's1', content: [{ title: '晴', url: 'https://w' }] }, { type: 'text', text: '今天晴~' }]) },
    { message: msg([{ type: 'text', text: '第二轮' }]) },
  ]);
  const events = [];
  const result = await runApiTurn(baseTurn, { historyDir: dir, client, onEvent: event => events.push(event) });
  assert.equal(result.ok, true);
  assert.equal(result.text, '今天晴~');
  assert.equal(result.numTurns, 2);
  assert.ok(result.costUsd > 0);
  assert.equal(events.filter(e => e.type === 'init').length, 1);
  assert.equal(events.find(e => e.type === 'tool_use').name, 'WebSearch');
  assert.match(events.find(e => e.type === 'tool_result').text, /晴 https:\/\/w/);
  // 续跑时把暂停的那段回传，不追加新的用户消息。
  assert.deepEqual(client.requests[1].request.messages.map(m => m.role), ['user', 'assistant']);
  await runApiTurn({ ...baseTurn, prompt: '<message>再来</message>' }, { historyDir: dir, client });
  const sent = client.requests[2].request.messages;
  assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'assistant', 'user']);
  // 上一轮的历史原样排在前面（只追加，不改写）。
  assert.deepEqual(sent.slice(0, 2), client.requests[1].request.messages);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'aaaa.json'), 'utf8')).length, 5);
});

test('API 访客轮：拒答不写入历史，中断返回 interrupted', async t => {
  const dir = tempDir(t);
  const refused = fakeClient([{ message: msg([], { stop_reason: 'refusal', stop_details: { category: 'cyber' } }) }]);
  const result = await runApiTurn(baseTurn, { historyDir: dir, client: refused });
  assert.equal(result.ok, false);
  assert.match(result.error, /cyber/);
  assert.equal(existsSync(path.join(dir, 'aaaa.json')), false);
  const controller = new AbortController();
  controller.abort();
  const aborted = await runApiTurn(baseTurn, { historyDir: dir, signal: controller.signal, client: fakeClient([{ error: new Error('aborted') }]) });
  assert.equal(aborted.interrupted, true);
});

test('会话：打开 useApi 后访客走 API、主人走 Claude Code，/new 清掉访客的 API 历史', async t => {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') }, discord: { guest: { useApi: true } } });
  const cards = new CardStore([path.join(here, '..', 'cards')]);
  const calls = [];
  const fake = kind => async (turn, io) => {
    calls.push({ kind, model: turn.model, historyDir: io.historyDir });
    io.onEvent({ type: 'init' });
    io.onEvent({ type: 'text', text: 'ok' });
    return { ok: true, text: 'ok', costUsd: 0.01 };
  };
  const sessions = new SessionManager({ config, cards, dataDir: dir, runTurn: fake('cli'), runApiTurn: fake('api') });
  const guest = sessions.create({ tier: 'guest' });
  const owner = sessions.create({});
  await sessions.send(guest.id, { text: '你好' });
  await sessions.send(owner.id, { text: '你好' });
  assert.deepEqual(calls.map(c => c.kind), ['api', 'cli']);
  assert.equal(calls[0].model, 'claude-sonnet-5-5');
  const historyFile = path.join(dir, 'api-history', `${guest.claudeSessionId}.json`);
  mkdirSync(path.dirname(historyFile), { recursive: true });
  writeFileSync(historyFile, '[]');
  sessions.reset(guest.id);
  assert.equal(existsSync(historyFile), false);
});

test('会话：访客关闭 useApi 时走 Claude Code；中途切换调用方式会开新对话', async t => {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') } });
  const cards = new CardStore([path.join(here, '..', 'cards')]);
  const calls = [];
  const fake = kind => async (turn, io) => {
    calls.push({ kind, model: turn.model, resume: turn.resume, session: turn.claudeSessionId });
    if (kind === 'api') {
      mkdirSync(io.historyDir, { recursive: true });
      writeFileSync(path.join(io.historyDir, `${turn.claudeSessionId}.json`), '[]');
    }
    io.onEvent({ type: 'init' });
    return { ok: true, text: 'ok' };
  };
  const sessions = new SessionManager({ config, cards, dataDir: dir, runTurn: fake('cli'), runApiTurn: fake('api') });
  const guest = sessions.create({ tier: 'guest' });
  await sessions.send(guest.id, { text: '一' });
  await sessions.send(guest.id, { text: '二' });
  assert.deepEqual(calls.map(c => [c.kind, c.model, c.resume]), [['cli', 'sonnet', false], ['cli', 'sonnet', true]]);
  config.discord.guest.useApi = true;
  await sessions.send(guest.id, { text: '三' });
  assert.equal(calls[2].kind, 'api');
  assert.equal(calls[2].resume, false, 'Claude Code 的历史接不到 API 上，应当开新对话');
  assert.notEqual(calls[2].session, calls[1].session);
  const apiFile = path.join(dir, 'api-history', `${calls[2].session}.json`);
  assert.ok(existsSync(apiFile));
  config.discord.guest.useApi = false;
  await sessions.send(guest.id, { text: '四' });
  assert.deepEqual([calls[3].kind, calls[3].resume], ['cli', false]);
  assert.equal(existsSync(apiFile), false, '切回 Claude Code 时丢掉用不上的 API 历史');
  assert.equal(sessions.transcript(guest.id).filter(row => row.kind === 'notice').length, 2);
});
