// Mar7thClaw 的本地 MCP 服务（stdio，逐行 JSON-RPC）。由 Claude Code 在主人会话中启动，
// 让模型能管理定时任务。它只调用核心的 HTTP 接口，并固定绑定到发起调用的会话：
// 新任务的结果只会送回这个会话所在的地方，无法指定其他频道。
import { createInterface } from 'node:readline';

const { CLAW_URL, CLAW_TOKEN, CLAW_SESSION_ID } = process.env;
const VERSION = '0.1.0';

const TIME_HINT = '时间按这台电脑的本地时区理解；当前时间见每轮消息的 time 属性。';
const TOOLS = [
  {
    name: 'schedule_create',
    description: `创建定时任务。到点时 Claw 会把 prompt 作为一条【定时任务】消息发回当前这个会话，由你执行，结果会送到当前会话所在的地方（Discord 频道/私信或桌面面板）。适用于提醒、每日汇总、定期检查等。三种时间规则只能填一种：cron（重复，5 段：分 时 日 月 周）、at（一次性，如 "2026-09-28 09:00"）、every_minutes（固定间隔，至少 5 分钟）。${TIME_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简短标题，例如「早上九点提醒看邮件」' },
        prompt: { type: 'string', description: '到点时要做的事，写成给未来的自己的完整指令，包含必要的上下文（届时对话可能已经过去很久）' },
        cron: { type: 'string', description: '重复规则，例如 "0 9 * * *" = 每天 9:00，"30 18 * * 1-5" = 工作日 18:30' },
        at: { type: 'string', description: '一次性执行的本地时间，例如 "2026-09-28 09:00"' },
        every_minutes: { type: 'integer', minimum: 5, description: '固定间隔分钟数' },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'schedule_list',
    description: '列出所有定时任务及其下次运行时间、最近一次结果。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_update',
    description: `修改定时任务：可以暂停/恢复（enabled）、改标题、改内容或改时间规则（cron / at / every_minutes 三选一）。${TIME_HINT}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        enabled: { type: 'boolean' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        cron: { type: 'string' },
        at: { type: 'string' },
        every_minutes: { type: 'integer', minimum: 5 },
      },
      required: ['id'],
    },
  },
  {
    name: 'schedule_delete',
    description: '删除定时任务。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

async function api(method, path, body) {
  const res = await fetch(`${CLAW_URL}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-claw-token': CLAW_TOKEN, 'x-claw-session': CLAW_SESSION_ID || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function when(args) {
  const out = {};
  if (args.cron !== undefined) out.cron = args.cron;
  if (args.at !== undefined) out.at = args.at;
  if (args.every_minutes !== undefined) out.everyMinutes = args.every_minutes;
  return out;
}

function format(job) {
  const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  const last = job.lastResult ? `；上次 ${new Date(job.lastResult.at).toLocaleString('zh-CN', { hour12: false })} ${job.lastResult.ok ? '成功' : '失败'}` : '';
  return `[${job.id}] ${job.enabled ? '' : '（已暂停）'}${job.title} · ${job.description} · 下次 ${next}${last}\n    内容：${job.prompt.replace(/\s+/g, ' ').slice(0, 120)}`;
}

async function callTool(name, args = {}) {
  if (name === 'schedule_create') {
    const job = await api('POST', '/api/schedules', { title: args.title, prompt: args.prompt, ...when(args), sessionId: CLAW_SESSION_ID });
    return `已创建定时任务：\n${format(job)}`;
  }
  if (name === 'schedule_list') {
    const jobs = await api('GET', '/api/schedules');
    return jobs.length ? jobs.map(format).join('\n') : '目前没有定时任务。';
  }
  if (name === 'schedule_update') {
    const patch = { ...when(args) };
    for (const key of ['enabled', 'title', 'prompt']) if (args[key] !== undefined) patch[key] = args[key];
    const job = await api('PATCH', `/api/schedules/${encodeURIComponent(args.id)}`, patch);
    return `已更新：\n${format(job)}`;
  }
  if (name === 'schedule_delete') {
    await api('DELETE', `/api/schedules/${encodeURIComponent(args.id)}`);
    return `已删除定时任务 ${args.id}。`;
  }
  throw new Error(`未知工具：${name}`);
}

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // 通知无需回复
  try {
    if (method === 'initialize') {
      return send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'claw', version: VERSION } } });
    }
    if (method === 'ping') return send({ id, result: {} });
    if (method === 'tools/list') return send({ id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await callTool(params?.name, params?.arguments || {});
        return send({ id, result: { content: [{ type: 'text', text }] } });
      } catch (error) {
        return send({ id, result: { content: [{ type: 'text', text: `操作失败：${error.message}` }], isError: true } });
      }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    send({ id, error: { code: -32603, message: error.message } });
  }
});
