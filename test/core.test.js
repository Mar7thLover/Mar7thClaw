import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn, buildArgs } from '../src/claude/runner.js';
import { SessionManager } from '../src/sessions.js';
import { CardStore } from '../src/persona/card.js';
import { createServer } from '../src/server.js';
import { DEFAULTS, merge } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = path.join(here, 'fake-claude.js');
const cardsDir = path.join(here, '..', 'cards');

function fakeSpawn(mode) {
  return (bin, args, options) => spawn(process.execPath, [fake, ...args], { ...options, env: { ...options.env, FAKE_MODE: mode } });
}

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const baseTurn = dir => ({ claudeSessionId: '11111111-1111-1111-1111-111111111111', resume: false, cwd: dir, system: 'SYS', prompt: '<message>hi</message>', permissionMode: 'auto', tier: 'owner' });

test('参数：主人会话使用宿主审批与追加系统提示；访客会话禁用工具并启用安全模式', () => {
  const owner = buildArgs({ ...baseTurn('x'), resume: true, model: 'opus', effort: 'high', disallowedTools: ['AskUserQuestion'] }, 'sys.txt');
  assert.ok(owner.includes('--resume') && !owner.includes('--session-id'));
  assert.deepEqual(owner.slice(owner.indexOf('--permission-prompt-tool'), owner.indexOf('--permission-prompt-tool') + 2), ['--permission-prompt-tool', 'stdio']);
  assert.ok(owner.includes('--append-system-prompt-file') && owner.includes('--disallowed-tools'));
  assert.ok(!owner.includes('--safe-mode'));
  const guest = buildArgs({ ...baseTurn('x'), tier: 'guest' }, 'sys.txt');
  assert.equal(guest[guest.indexOf('--tools') + 1], '');
  assert.ok(guest.includes('--safe-mode') && guest.includes('--strict-mcp-config'));
  // 访客会话替换掉 Claude Code 的默认系统提示，主人会话只是追加。
  assert.equal(guest[guest.indexOf('--system-prompt-file') + 1], 'sys.txt');
  assert.ok(!guest.includes('--append-system-prompt-file') && !owner.includes('--system-prompt-file'));
});

test('运行器：流式文本、结果与临时 system 文件清理', async t => {
  const dir = tempDir(t);
  const events = [];
  const result = await runTurn(baseTurn(dir), { claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), onEvent: e => events.push(e), spawnProcess: fakeSpawn('text') });
  assert.equal(result.ok, true);
  assert.equal(result.text, '最终回复');
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), '收到：wrapped');
  assert.ok(events.some(e => e.type === 'init'));
});

test('运行器：权限请求经宿主审批，"总是允许"改写为会话级规则', async t => {
  const dir = tempDir(t);
  const events = [];
  let seen;
  await runTurn(baseTurn(dir), {
    claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), onEvent: e => events.push(e), spawnProcess: fakeSpawn('permission'),
    canUseTool: async request => { seen = request; return { behavior: 'allow', always: true }; },
  });
  assert.equal(seen.toolName, 'Bash');
  assert.equal(seen.canAlwaysAllow, true);
  assert.ok(events.some(e => e.type === 'text' && e.text === '允许(always)'));
  assert.ok(events.some(e => e.type === 'tool_result' && e.text === 'hi'));

  const denied = [];
  await runTurn(baseTurn(dir), { claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), onEvent: e => denied.push(e), spawnProcess: fakeSpawn('permission'), canUseTool: async () => ({ behavior: 'deny' }) });
  assert.ok(denied.some(e => e.type === 'text' && e.text === '拒绝'));
});

test('运行器：中断会发送 interrupt 控制请求并返回 interrupted', async t => {
  const dir = tempDir(t);
  const controller = new AbortController();
  const promise = runTurn(baseTurn(dir), { claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), signal: controller.signal, spawnProcess: fakeSpawn('hang'), onEvent: e => { if (e.type === 'text') controller.abort(); } });
  const result = await promise;
  assert.equal(result.interrupted, true);
});

function manager(t, mode, overrides = {}) {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws'), approvalTimeoutSec: 1 }, claudeBin: 'fake', ...overrides });
  const cards = new CardStore([path.join(dir, 'cards'), cardsDir]);
  const runTurnWithFake = (turn, io) => runTurn(turn, { ...io, spawnProcess: fakeSpawn(typeof mode === 'function' ? mode() : mode) });
  return { dir, config, cards, sessions: new SessionManager({ config, cards, dataDir: dir, runTurn: runTurnWithFake }) };
}

test('会话：开场白写入记录、首轮带上开场白、之后改用 --resume，并持久化', async t => {
  const { sessions, dir, config, cards } = manager(t, 'text');
  const turns = [];
  sessions.runTurn = async (turn, io) => { turns.push(turn); return runTurn(turn, { ...io, spawnProcess: fakeSpawn('text') }); };
  const meta = sessions.create({ title: '测试' });
  assert.equal(sessions.transcript(meta.id)[0].greeting, true);
  await sessions.send(meta.id, { text: '你好' });
  await sessions.send(meta.id, { text: '再来' });
  assert.equal(turns[0].resume, false);
  assert.match(turns[0].prompt, /<greeting_already_shown>/);
  assert.equal(turns[1].resume, true);
  assert.doesNotMatch(turns[1].prompt, /<greeting_already_shown>/);
  assert.equal(turns[0].claudeSessionId, turns[1].claudeSessionId);
  const rows = sessions.transcript(meta.id);
  assert.deepEqual(rows.map(r => r.kind), ['assistant', 'user', 'assistant', 'user', 'assistant']);
  const reloaded = new SessionManager({ config, cards, dataDir: dir });
  assert.equal(reloaded.get(meta.id).stats.turns, 2);
});

test('会话：Claude Code 会话丢失时自动换新会话重试', async t => {
  const { sessions } = manager(t, 'resume-missing');
  const meta = sessions.create({});
  await sessions.send(meta.id, { text: '一' });
  const firstId = sessions.get(meta.id).claudeSessionId;
  const result = await sessions.send(meta.id, { text: '二' });
  assert.equal(result.ok, true);
  assert.notEqual(sessions.get(meta.id).claudeSessionId, firstId);
  assert.ok(sessions.transcript(meta.id).some(r => r.kind === 'notice'));
});

test('会话：同一会话串行排队；权限可由外部审批，超时自动拒绝', async t => {
  const { sessions } = manager(t, 'permission');
  const meta = sessions.create({});
  const opened = [];
  sessions.on('event', e => { if (e.type === 'permission_open') { opened.push(e.request.requestId); sessions.resolvePermission(e.request.requestId, { behavior: 'allow', by: 'test' }); } });
  const [a, b] = await Promise.all([sessions.send(meta.id, { text: '1' }), sessions.send(meta.id, { text: '2' })]);
  assert.equal(opened.length, 2);
  assert.match(a.entry.text, /允许/);
  assert.match(b.entry.text, /允许/);
  sessions.removeAllListeners('event');
  const timedOut = await sessions.send(meta.id, { text: '3' });
  assert.match(timedOut.entry.text, /拒绝/);
});

test('会话：访客会话不能提升权限模式；reset 生成新的 Claude 会话 ID', async t => {
  const { sessions } = manager(t, 'text');
  const guest = sessions.create({ tier: 'guest', permissionMode: 'auto' });
  sessions.update(guest.id, { permissionMode: 'bypassPermissions' });
  assert.equal(sessions.get(guest.id).permissionMode, 'auto');
  assert.throws(() => sessions.update(guest.id, { effort: 'ultra' }), /effort/);
  const before = sessions.get(guest.id).claudeSessionId;
  sessions.reset(guest.id);
  assert.notEqual(sessions.get(guest.id).claudeSessionId, before);
  assert.ok(sessions.transcript(guest.id).some(r => r.kind === 'divider'));
});

test('HTTP：页面注入令牌，API 校验令牌与 Host，事件流推送会话更新', async t => {
  const { sessions, cards, config } = manager(t, 'text');
  const server = createServer({ config, sessions, cards, discord: null, token: 'tok' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeClients(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /content="tok"/);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const headers = { 'x-claw-token': 'tok', 'content-type': 'application/json' };
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(state.activeCard, 'march7th');
  const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: '{}' })).json();
  assert.equal(created.tier, 'owner');
  const done = new Promise(resolve => sessions.on('event', e => { if (e.type === 'turn_end') resolve(e); }));
  const sent = await fetch(`${base}/api/sessions/${created.id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text: '你好' }) });
  assert.equal(sent.status, 200);
  assert.equal((await done).ok, true);
  const preview = await (await fetch(`${base}/api/sessions/${created.id}/preview?text=${encodeURIComponent('仙舟')}`, { headers })).json();
  assert.match(preview.turn, /两位小师父/);
  // fetch 会忽略自定义 Host，DNS 重绑定场景用原生 http 请求模拟。
  const rebindStatus = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/state', headers: { ...headers, host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(rebindStatus, 403);
  const traversal = await fetch(`${base}/panel/..%2f..%2fdata%2fconfig.json`);
  assert.equal(traversal.status, 404);
});

test('卡片 JSON 保持可被酒馆导入的 v3 结构', () => {
  const raw = JSON.parse(readFileSync(path.join(cardsDir, 'march7th.json'), 'utf8'));
  assert.equal(raw.spec, 'chara_card_v3');
  assert.equal(raw.data.name, '三月七');
  assert.ok(Array.isArray(raw.data.character_book.entries));
});

test('入口依赖可以正常实例化（DiscordBot、调度器、人物记忆），不连接 Discord', async t => {
  const { sessions, dir, config } = manager(t, 'text');
  const { DiscordBot } = await import('../src/discord/bot.js');
  const { PeopleMemory } = await import('../src/people.js');
  const { GuestUsage } = await import('../src/guest.js');
  const { Scheduler } = await import('../src/scheduler.js');
  const people = new PeopleMemory({ dataDir: dir, config, claudeBin: 'x' });
  const bot = new DiscordBot({ config, sessions, dataDir: dir, people, guestUsage: new GuestUsage({ dataDir: dir, config }) });
  assert.equal(bot.status().state, 'stopped');
  assert.deepEqual(bot.guildsInfo(), []);
  const scheduler = new Scheduler({ sessions, dataDir: dir, hooksFor: meta => bot.hooksFor(meta) });
  scheduler.stop();
  await bot.start(); // 配置里没有令牌：应当安静地进入 disabled，而不是抛错
  assert.equal(bot.status().state, 'disabled');
});
