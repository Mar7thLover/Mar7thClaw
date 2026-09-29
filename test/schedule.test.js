import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCron, nextCronRun, describeCron } from '../src/cron.js';
import { Scheduler, normalizeSchedule, computeNextRun, parseLocalDateTime } from '../src/scheduler.js';
import { buildArgs } from '../src/claude/runner.js';
import { assemblePrompt } from '../src/persona/assembler.js';
import { normalizeCard } from '../src/persona/card.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

test('cron：常见表达式的下一次运行时间', () => {
  assert.deepEqual(nextCronRun('0 9 * * *', local(2026, 9, 27, 8, 59)), local(2026, 9, 27, 9, 0));
  assert.deepEqual(nextCronRun('0 9 * * *', local(2026, 9, 27, 9, 0)), local(2026, 9, 28, 9, 0));
  // 2026-09-27 是星期日，工作日规则应跳到周一
  assert.deepEqual(nextCronRun('30 18 * * 1-5', local(2026, 9, 27, 12)), local(2026, 9, 28, 18, 30));
  assert.deepEqual(nextCronRun('*/15 * * * *', local(2026, 9, 27, 10, 7)), local(2026, 9, 27, 10, 15));
  assert.deepEqual(nextCronRun('0 0 1 * *', local(2026, 12, 15)), local(2027, 1, 1));
  assert.deepEqual(nextCronRun('@weekly', local(2026, 9, 27, 1)), local(2026, 10, 4));
  assert.deepEqual(nextCronRun('0 12 * * 7', local(2026, 9, 26)), local(2026, 9, 27, 12));
  // 日期与星期都受限时满足其一即可
  assert.deepEqual(nextCronRun('0 8 15 * 1', local(2026, 9, 27)), local(2026, 9, 28, 8));
  assert.equal(nextCronRun('0 0 30 2 *', local(2026, 1, 1)), null);
  assert.throws(() => parseCron('0 9 * *'), /5 段/);
  assert.throws(() => parseCron('61 * * * *'), /超出范围/);
  assert.equal(describeCron('0 9 * * *'), '每天 09:00');
  assert.equal(describeCron('30 18 * * 1-5'), '工作日 18:30');
  assert.equal(describeCron('0 10 * * 1,3'), '每周一、三 10:00');
});

test('时间规则：三选一、本地时间解析与间隔下限', () => {
  assert.deepEqual(normalizeSchedule({ cron: '0 9 * * *' }), { type: 'cron', cron: '0 9 * * *' });
  assert.equal(normalizeSchedule({ at: '2026-09-28 09:00' }).at, local(2026, 9, 28, 9).toISOString());
  assert.equal(parseLocalDateTime('2026-09-28T09:30').getTime(), local(2026, 9, 28, 9, 30).getTime());
  assert.throws(() => normalizeSchedule({ cron: '0 9 * * *', at: '2026-09-28 09:00' }), /三选一/);
  assert.throws(() => normalizeSchedule({ everyMinutes: 1 }), /5 分钟/);
  assert.throws(() => normalizeSchedule({ at: '明天早上' }), /无法识别/);
  assert.equal(computeNextRun({ type: 'once', at: 'x' }, new Date(), '2026-01-01'), null);
  const from = local(2026, 9, 27, 10);
  assert.equal(computeNextRun({ type: 'interval', everyMinutes: 30 }, from, from.toISOString()), local(2026, 9, 27, 10, 30).toISOString());
});

function fakeSessions() {
  const sessions = new Map();
  let count = 0;
  const sent = [];
  return {
    sent,
    create: options => { const meta = { id: `s${++count}`, tier: options.tier || 'owner', origin: options.origin || 'panel', title: options.title }; sessions.set(meta.id, meta); return meta; },
    get: id => { if (!sessions.has(id)) throw Object.assign(new Error('会话不存在'), { status: 404 }); return sessions.get(id); },
    add: meta => sessions.set(meta.id, meta),
    send: async (id, message) => { sent.push({ id, text: message.text }); return { ok: true, entry: { text: `完成：${message.text.split('\n').at(-1)}` } }; },
  };
}

function makeScheduler(t, clock, sessions, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-sched-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const delivered = [];
  const scheduler = new Scheduler({ sessions, dataDir: dir, now: () => clock.now, deliver: async payload => delivered.push(payload), ...extra });
  t.after(() => scheduler.stop());
  return { scheduler, delivered, dir };
}

test('调度器：到点运行、推进下次时间、一次性任务运行后停用、结果投递', async t => {
  const clock = { now: local(2026, 9, 27, 8, 0) };
  const sessions = fakeSessions();
  const { scheduler, delivered } = makeScheduler(t, clock, sessions);
  const daily = scheduler.create({ title: '早报', prompt: '汇总昨天的提交', cron: '0 9 * * *' });
  const once = scheduler.create({ title: '提醒', prompt: '提醒喝水', at: '2026-09-27 08:30' });
  assert.equal(daily.nextRunAt, local(2026, 9, 27, 9).toISOString());
  clock.now = local(2026, 9, 27, 8, 31);
  scheduler.tick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(sessions.sent.length, 1);
  assert.match(sessions.sent[0].text, /【定时任务「提醒」到点触发/);
  assert.equal(scheduler.get(once.id).enabled, false);
  assert.equal(scheduler.get(once.id).sessionId, 's1'); // 自动建了专用会话
  assert.equal(delivered[0].text, '完成：提醒喝水');
  clock.now = local(2026, 9, 27, 9, 0);
  scheduler.tick();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(scheduler.get(daily.id).nextRunAt, local(2026, 9, 28, 9).toISOString());
  assert.equal(scheduler.get(daily.id).runs, 1);
});

test('调度器：启动时补跑 12 小时内错过的任务，更早的跳过；持久化后可重新加载', async t => {
  const clock = { now: local(2026, 9, 27, 8, 0) };
  const sessions = fakeSessions();
  const { scheduler, dir } = makeScheduler(t, clock, sessions);
  const recent = scheduler.create({ title: '近', prompt: 'a', cron: '0 9 * * *' });
  const old = scheduler.create({ title: '远', prompt: 'b', at: '2026-09-27 08:10' });
  scheduler.stop();
  clock.now = local(2026, 9, 27, 21, 0); // 关机 13 小时后重新启动
  const reloaded = new Scheduler({ sessions, dataDir: dir, now: () => clock.now });
  t.after(() => reloaded.stop());
  reloaded.start();
  assert.equal(reloaded.get(old.id).enabled, false);
  assert.match(reloaded.get(old.id).lastResult.text, /错过/);
  reloaded.tick();
  await new Promise(r => setTimeout(r, 20));
  assert.match(sessions.sent[0].text, /原定.*现在补上/);
  assert.equal(reloaded.get(recent.id).nextRunAt, local(2026, 9, 28, 9).toISOString());
});

test('调度器：访客会话不能挂任务；过去的时间与空内容被拒绝', t => {
  const clock = { now: local(2026, 9, 27, 8, 0) };
  const sessions = fakeSessions();
  sessions.add({ id: 'guest', tier: 'guest', origin: 'discord' });
  const { scheduler } = makeScheduler(t, clock, sessions);
  assert.throws(() => scheduler.create({ title: 'x', prompt: 'y', cron: '0 9 * * *', sessionId: 'guest' }), /主人/);
  assert.throws(() => scheduler.create({ title: 'x', prompt: 'y', at: '2026-09-27 07:00' }), /过去/);
  assert.throws(() => scheduler.create({ title: 'x', prompt: ' ', cron: '0 9 * * *' }), /prompt/);
  const job = scheduler.create({ title: 'x', prompt: 'y', everyMinutes: 30 });
  assert.equal(scheduler.update(job.id, { enabled: false }).nextRunAt, null);
  scheduler.remove(job.id);
  assert.equal(scheduler.list().length, 0);
});

test('运行器参数：主人会话挂载 Claw MCP 并预先放行，访客不挂', () => {
  const turn = { claudeSessionId: 'x', resume: false, cwd: '.', permissionMode: 'auto', tier: 'owner' };
  const args = buildArgs(turn, 'sys.txt', 'mcp.json');
  assert.deepEqual(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 4), ['--mcp-config', 'mcp.json', '--allowed-tools', 'mcp__claw']);
  assert.ok(!buildArgs({ ...turn, tier: 'guest' }, 'sys.txt', 'mcp.json').includes('--mcp-config'));
});

test('提示词：主人会话说明长期记忆与定时任务用法，访客没有', async () => {
  const { readFileSync } = await import('node:fs');
  const card = normalizeCard(JSON.parse(readFileSync(path.join(here, '..', 'cards', 'march7th.json'), 'utf8')));
  const base = { card, prompt: { worldInfoScanDepth: 4, worldInfoBudgetChars: 6000, worldInfoRecursion: true }, userName: 'u', persona: '', surface: 'panel', authorNote: '', recent: [], message: { from: 'u', text: 'hi', via: 'panel', time: 't' } };
  assert.match(assemblePrompt({ ...base, tier: 'owner' }).system, /schedule_create[\s\S]*长期记忆|长期记忆[\s\S]*schedule_create/);
  assert.doesNotMatch(assemblePrompt({ ...base, tier: 'guest' }).system, /schedule_create/);
});

test('MCP 服务：握手、列出工具、调用时绑定会话并转发到核心接口', async t => {
  const calls = [];
  const api = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, token: req.headers['x-claw-token'], session: req.headers['x-claw-session'], body: body ? JSON.parse(body) : null });
      res.writeHead(req.url.endsWith('/nope') ? 404 : 200, { 'content-type': 'application/json' });
      if (req.url.endsWith('/nope')) return res.end(JSON.stringify({ error: '定时任务不存在' }));
      if (req.url === '/api/outbox') return res.end(JSON.stringify({ name: 'report.pdf', size: 2048, file: 'sess-1/out/1.pdf' }));
      const job = { id: 'j1', title: '早报', description: '每天 09:00', enabled: true, nextRunAt: new Date().toISOString(), prompt: '汇总', lastResult: null };
      res.end(JSON.stringify(req.method === 'GET' ? [job] : job));
    });
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  t.after(() => api.close());
  const child = spawn(process.execPath, [path.join(here, '..', 'src', 'mcp', 'claw-server.js')], {
    env: { ...process.env, CLAW_URL: `http://127.0.0.1:${api.address().port}`, CLAW_TOKEN: 'tok', CLAW_SESSION_ID: 'sess-1' }, stdio: ['pipe', 'pipe', 'inherit'],
  });
  t.after(() => child.kill());
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); });
  let nextId = 0;
  const rpc = (method, params) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'claw');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await rpc('tools/list', {});
  assert.deepEqual(tools.result.tools.map(tool => tool.name), ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete', 'send_file']);
  const created = await rpc('tools/call', { name: 'schedule_create', arguments: { title: '早报', prompt: '汇总', cron: '0 9 * * *' } });
  assert.match(created.result.content[0].text, /已创建/);
  assert.deepEqual(calls[0], { method: 'POST', url: '/api/schedules', token: 'tok', session: 'sess-1', body: { title: '早报', prompt: '汇总', cron: '0 9 * * *', sessionId: 'sess-1' } });
  const failed = await rpc('tools/call', { name: 'schedule_delete', arguments: { id: 'nope' } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /不存在/);
  const sent = await rpc('tools/call', { name: 'send_file', arguments: { path: 'out/report.pdf' } });
  assert.match(sent.result.content[0].text, /已附上「report.pdf」（2KB）/);
  assert.deepEqual(calls.at(-1), { method: 'POST', url: '/api/outbox', token: 'tok', session: 'sess-1', body: { path: 'out/report.pdf' } });
  const unknown = await rpc('resources/list', {});
  assert.equal(unknown.error.code, -32601);
});
