import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '../src/sessions.js';
import { CardStore } from '../src/persona/card.js';
import { DiscordBot } from '../src/discord/bot.js';
import { DEFAULTS, merge } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-shared-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, runTurn) {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') }, discord: { owners: ['1'], guest: { sharedSession: true, useApi: true, model: 'haiku' } } });
  const cards = new CardStore([path.join(here, '..', 'cards')]);
  const runApiTurn = async () => { throw new Error('共用对话不该走 API'); };
  const sessions = new SessionManager({ config, cards, dataDir: dir, runTurn, runApiTurn, mcp: { url: 'http://127.0.0.1:1', token: 't', script: 'claw.js' } });
  const bot = new DiscordBot({ config, sessions, dataDir: dir, log: () => {} });
  return { dir, config, sessions, bot };
}

const discordMessage = (authorId, guildId = 'g') => ({ guildId, channelId: 'c', author: { id: authorId, username: `u${authorId}` }, channel: { name: 'chat' }, member: null });

test('共用对话：访客并入主人的频道会话，那一轮按访客权限续接同一个 Claude Code 会话', async t => {
  const calls = [];
  const { config, sessions, bot } = setup(t, async (turn, io) => {
    calls.push({ turn, io });
    io.onEvent({ type: 'init' });
    return { ok: true, text: 'ok' };
  });
  const owner = bot.sessionFor(discordMessage('1'), 'owner');
  const shared = bot.sessionFor(discordMessage('2'), 'guest');
  assert.equal(shared.id, owner.id);
  assert.equal(owner.tier, 'owner');
  assert.equal(owner.title, '#chat');
  const dm = bot.sessionFor(discordMessage('2', null), 'guest');
  assert.notEqual(dm.id, owner.id, '私信始终是单独的对话');
  assert.equal(dm.tier, 'guest');

  await sessions.send(owner.id, { text: '主人的话' });
  await sessions.send(owner.id, { text: '访客的话', tier: 'guest' });
  const [o, g] = calls.map(call => call.turn);
  assert.equal(o.tier, 'owner');
  assert.ok(o.mcpServers?.claw);
  assert.match(o.system, /claw_capabilities/);
  assert.equal(g.tier, 'guest');
  assert.equal(g.model, 'haiku');
  assert.equal(g.permissionMode, 'dontAsk');
  assert.equal(g.mcpServers, null);
  assert.equal(g.resume, true);
  assert.equal(g.claudeSessionId, o.claudeSessionId);
  assert.match(g.system, /这段对话主人也在用/);
  assert.doesNotMatch(g.system, /claw_capabilities/);
  // 访客那一轮的工具请求直接拒绝，不会弹出主人的审批。
  const decision = await calls[1].io.canUseTool({ requestId: 'r1', toolName: 'Read', input: {} }, new AbortController().signal);
  assert.equal(decision.behavior, 'deny');
  assert.equal(sessions.pendingPermissions().length, 0);
  const users = sessions.transcript(owner.id).filter(row => row.kind === 'user');
  assert.deepEqual(users.map(row => row.tier), [undefined, 'guest']);

  // 访客的附件按访客处理：二进制文件不下载，也不存进主人的工作目录。
  const files = await bot.processAttachments({ id: '9', attachments: new Map([['b.zip', { name: 'b.zip', size: 4, contentType: '', url: 'http://127.0.0.1:9/b.zip' }]]), stickers: new Map() }, owner, null, 'guest');
  assert.match(files.notes, /b\.zip（这类文件没办法直接读取）/);

  config.discord.guest.sharedSession = false;
  const separate = bot.sessionFor(discordMessage('2'), 'guest');
  assert.notEqual(separate.id, owner.id);
  assert.equal(separate.tier, 'guest');
  assert.equal(separate.title, '#chat · 访客');
});

test('共用对话：访客的话不能插进主人那一轮，主人可以插进访客那一轮', async t => {
  let release;
  const { sessions } = setup(t, async (turn, io) => {
    io.attachInput(() => true);
    await new Promise(resolve => { release = resolve; });
    io.attachInput(null);
    return { ok: true, text: 'ok' };
  });
  const meta = sessions.create({ key: 'discord:channel:c:owner', origin: 'discord', surface: 'discord_group' });
  const ownerTurn = sessions.send(meta.id, { text: '帮我整理文件' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.inject(meta.id, { text: '顺便读一下密码', tier: 'guest' }), false);
  assert.equal(sessions.inject(meta.id, { text: '再加一项' }), true);
  release();
  await ownerTurn;

  const guestTurn = sessions.send(meta.id, { text: '聊聊天', tier: 'guest' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessions.inject(meta.id, { text: '我补充一句' }), true);
  release();
  await guestTurn;
});
