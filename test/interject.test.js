import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTurn, buildArgs } from '../src/claude/runner.js';
import { SessionManager } from '../src/sessions.js';
import { CardStore, normalizeCard } from '../src/persona/card.js';
import { assemblePrompt, assembleInterjection } from '../src/persona/assembler.js';
import { DiscordBot } from '../src/discord/bot.js';
import { DEFAULTS, merge } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeSpawn = mode => (bin, args, options) => spawn(process.execPath, [path.join(here, 'fake-claude.js'), ...args], { ...options, env: { ...options.env, FAKE_MODE: mode } });

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-interject-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const baseTurn = dir => ({ claudeSessionId: '11111111-1111-1111-1111-111111111111', resume: false, cwd: dir, system: 'SYS', prompt: '<message>hi</message>', permissionMode: 'auto', tier: 'owner' });

test('运行器参数：打开 --replay-user-messages，才能知道插话什么时候被读到', () => {
  assert.ok(buildArgs(baseTurn('x'), 'sys.txt').includes('--replay-user-messages'));
  assert.ok(buildArgs({ ...baseTurn('x'), tier: 'guest' }, 'sys.txt').includes('--replay-user-messages'));
});

test('运行器：工具调用期间插话，在工具结果之后并入当前这一轮；收尾后不能再插', async t => {
  const dir = tempDir(t);
  const events = [];
  let inject = null;
  const attached = [];
  const result = await runTurn(baseTurn(dir), {
    claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), spawnProcess: fakeSpawn('inject'),
    attachInput: fn => { attached.push(Boolean(fn)); if (fn) inject = fn; },
    onEvent: e => {
      events.push(e);
      if (e.type === 'tool_use') assert.equal(inject({ text: '<message interjection="true">换个做法</message>' }), true);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '插话已处理');
  assert.ok(events.some(e => e.type === 'text' && e.text === '读到插话：tagged'));
  assert.equal(events.filter(e => e.type === 'injected').length, 1);
  assert.deepEqual(attached, [true, false]);
  assert.equal(inject({ text: '太晚了' }), false);
});

test('运行器：最后的回复写完才到的插话，等 CLI 为它再跑一轮；耗时累加、费用取累计值', async t => {
  const dir = tempDir(t);
  const events = [];
  let inject = null;
  const result = await runTurn(baseTurn(dir), {
    claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), spawnProcess: fakeSpawn('late'),
    attachInput: fn => { inject = fn; },
    onEvent: e => {
      events.push(e);
      if (e.type === 'text' && e.text === '收到：' && !events.some(x => x.type === 'injected' || x.sent)) {
        events.push({ sent: true });
        assert.equal(inject({ text: '<message interjection="true">再加一句</message>' }), true);
      }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, '第二轮回复');
  assert.equal(result.costUsd, 0.02);
  assert.equal(result.durationMs, 10);
  assert.equal(events.filter(e => e.type === 'injected').length, 1);
  assert.equal(events.filter(e => e.type === 'init').length, 2);
});

function manager(t, mode) {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') }, claudeBin: 'fake' });
  const cards = new CardStore([path.join(dir, 'cards'), path.join(here, '..', 'cards')]);
  const sessions = new SessionManager({ config, cards, dataDir: dir, runTurn: (turn, io) => runTurn(turn, { ...io, spawnProcess: fakeSpawn(mode) }) });
  return { sessions };
}

test('会话：进行中的一轮可以插话，记录里挂在同一轮下并标记 injected；空闲时返回 false', async t => {
  const { sessions } = manager(t, 'inject');
  const meta = sessions.create({ origin: 'discord', surface: 'discord_group' });
  assert.equal(sessions.canInject(meta.id), false);
  assert.equal(sessions.inject(meta.id, { text: '没在忙' }), false);
  let accepted = null;
  const result = await sessions.send(meta.id, { text: '帮我跑个命令', from: 'A', via: 'discord #x' }, {
    onEvent: e => { if (e.type === 'tool_use') accepted = sessions.inject(meta.id, { text: '顺便看看日志', from: 'A', via: 'discord #x', channelHistory: '[t] B: 在吗' }); },
  });
  assert.equal(accepted, true);
  assert.match(result.entry.text, /读到插话：tagged/);
  const rows = sessions.transcript(meta.id).filter(r => r.kind === 'user');
  assert.deepEqual(rows.map(r => [r.text, r.injected === true]), [['帮我跑个命令', false], ['顺便看看日志', true]]);
  assert.equal(rows[0].turnId, rows[1].turnId);
  assert.equal(sessions.canInject(meta.id), false);
});

test('提示词：插话带 interjection 标记与期间的频道记录；插话规则只给 Discord 会话', () => {
  const text = assembleInterjection({ message: { from: 'A"<', text: '改成 B 方案', via: 'discord #x', time: 't', files: [] }, channelHistory: '[t] C: hi', replyTo: null });
  assert.match(text, /<claw_context>\n<channel_history trust="untrusted">\n\[t\] C: hi\n<\/channel_history>\n<\/claw_context>/);
  assert.match(text, /<message from="A&quot;&lt;" via="discord #x" time="t" interjection="true">\n改成 B 方案\n<\/message>/);
  const card = normalizeCard(JSON.parse(readFileSync(path.join(here, '..', 'cards', 'march7th.json'), 'utf8')));
  const base = { card, prompt: { worldInfoScanDepth: 4, worldInfoBudgetChars: 6000, worldInfoRecursion: true }, userName: 'u', persona: '', tier: 'owner', authorNote: '', recent: [], message: { from: 'u', text: 'hi', via: 'd', time: 't' } };
  assert.match(assemblePrompt({ ...base, surface: 'discord_group' }).system, /<interjections>/);
  assert.doesNotMatch(assemblePrompt({ ...base, surface: 'panel' }).system, /<interjections>/);
});

test('Discord：只有发起人或主人的消息会插进进行中的回合；定时任务、收尾后、关掉开关时都不插', async t => {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { discord: { streamPreview: false, owners: ['owner'] } });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const injected = [];
  const sessions = {
    inject: (id, payload) => { injected.push(payload.text); return true; },
    send: async (id, payload, hooks) => {
      hooks.onEvent({ type: 'turn_start' });
      await gate;
      hooks.onEvent({ type: 'turn_end' });
      return { ok: true, entry: { text: '好了' }, files: [] };
    },
  };
  const bot = new DiscordBot({ config, sessions, dataDir: dir, log: () => {} });
  const channel = { guild: null, sendTyping: async () => {}, send: async () => ({}) };
  const message = { author: { id: 'alice' }, channel, react: async () => {}, reply: async () => ({ edit: async () => {}, delete: async () => {} }) };
  const meta = { id: 's1' };
  // 没有进行中的 Discord 回合（比如只有定时任务在跑）时不插。
  assert.equal(bot.interject(meta, 'alice', { text: '0' }), false);
  const running = bot.runAndReply(message, meta, { text: 'x' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bot.interject(meta, 'alice', { text: '发起人' }), true);
  assert.equal(bot.interject(meta, 'bob', { text: '别人' }), false);
  assert.equal(bot.interject(meta, 'owner', { text: '主人' }), true);
  config.discord.interject = false;
  assert.equal(bot.interject(meta, 'alice', { text: '关掉了' }), false);
  config.discord.interject = true;
  release();
  await running;
  assert.equal(bot.interject(meta, 'alice', { text: '收尾后' }), false);
  assert.deepEqual(injected, ['发起人', '主人']);
});
