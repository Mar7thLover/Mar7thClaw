import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStickers, resolveStickers, stripReactionTags } from '../src/discord/reactions.js';
import { assemblePrompt } from '../src/persona/assembler.js';
import { normalizeCard } from '../src/persona/card.js';
import { DiscordBot } from '../src/discord/bot.js';
import { DEFAULTS, merge } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STICKERS = [
  { id: '111111111111111111', name: '三月七比心', description: '比心', tags: '❤️' },
  { id: '222222222222222222', name: 'Wow', description: '', tags: '😮' },
  { id: '333333333333333333', name: '下架了', available: false, tags: '' },
];

test('贴纸标记：提取、去重限量，按名字 / ID / 关联表情解析，预览隐藏半截标记', () => {
  const r = extractStickers('好耶[[sticker:三月七比心]] [[sticker: :wow: ]][[sticker:三月七比心]][[sticker:a]][[sticker:b]]');
  assert.deepEqual(r.stickers, ['三月七比心', 'wow', 'a']);
  assert.equal(r.text, '好耶');
  assert.deepEqual(extractStickers('[[sticker：Wow]]'), { text: '', stickers: ['Wow'] });
  assert.deepEqual(resolveStickers(['wow', '111111111111111111', '😮', '没有这张'], STICKERS), { ids: ['222222222222222222', '111111111111111111'], missing: ['没有这张'] });
  assert.equal(stripReactionTags('看我 [[sticker:Wow]] 还有[[stic'), '看我  还有');
  assert.equal(stripReactionTags('嗯[[sticker:三月'), '嗯');
});

test('提示词：有贴纸列表时才说明用法并注入 server_stickers', () => {
  const card = normalizeCard(JSON.parse(readFileSync(path.join(here, '..', 'cards', 'march7th.json'), 'utf8')));
  const base = { card, prompt: { worldInfoScanDepth: 4, worldInfoBudgetChars: 6000, worldInfoRecursion: true }, userName: 'u', persona: '', surface: 'discord_group', tier: 'guest', authorNote: '', recent: [], message: { from: 'u', text: 'hi', via: 'd', time: 't' } };
  const withStickers = assemblePrompt({ ...base, stickers: '三月七比心 — 比心（❤️）' });
  assert.match(withStickers.system, /\[\[sticker:贴纸名\]\]/);
  assert.match(withStickers.turn, /<server_stickers note="[^"]+">\n三月七比心 — 比心（❤️）\n<\/server_stickers>/);
  const without = assemblePrompt(base);
  assert.doesNotMatch(without.system + without.turn, /sticker/);
});

function fakeDiscord(t, { replyText, failStickers = false, stickersEnabled = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-sticker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = merge(DEFAULTS, { discord: { streamPreview: false, stickers: stickersEnabled } });
  const sent = [];
  const guild = { premiumTier: 0, stickers: { cache: new Map(STICKERS.map(s => [s.id, s])) }, emojis: { cache: new Map() } };
  const record = kind => async payload => {
    if (failStickers && payload.stickers) throw new Error('Unknown Sticker');
    sent.push({ kind, ...payload });
    return { edit: async () => {}, delete: async () => {} };
  };
  const channel = { guild, sendTyping: async () => {}, send: record('send') };
  const message = { channel, guild, react: async emoji => sent.push({ kind: 'react', emoji }), reply: record('reply') };
  const sessions = { send: async () => ({ ok: true, entry: { text: replyText }, files: [] }) };
  const bot = new DiscordBot({ config, sessions, dataDir: dir, log: () => {} });
  return { bot, message, sent };
}

test('Discord 发送：贴纸附在最后一条回复上；只有贴纸时正文为空；贴纸失败时退回只发文字', async t => {
  const a = fakeDiscord(t, { replyText: '收到啦 [[sticker:三月七比心]][[react:👍]]' });
  await a.bot.runAndReply(a.message, { id: 's' }, { text: 'x' });
  assert.deepEqual(a.sent.map(m => m.kind), ['react', 'reply']);
  assert.equal(a.sent[1].content, '收到啦');
  assert.deepEqual(a.sent[1].stickers, ['111111111111111111']);

  const b = fakeDiscord(t, { replyText: '[[sticker:wow]]' });
  await b.bot.runAndReply(b.message, { id: 's' }, { text: 'x' });
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].content, '');
  assert.deepEqual(b.sent[0].stickers, ['222222222222222222']);

  const c = fakeDiscord(t, { replyText: '好哦[[sticker:三月七比心]]', failStickers: true });
  await c.bot.runAndReply(c.message, { id: 's' }, { text: 'x' });
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].content, '好哦');
  assert.equal(c.sent[0].stickers, undefined);

  // 下架的贴纸、关掉开关后都不会发，标记照样从正文里去掉。
  const d = fakeDiscord(t, { replyText: '嗯[[sticker:下架了]]' });
  await d.bot.runAndReply(d.message, { id: 's' }, { text: 'x' });
  assert.deepEqual(d.sent.map(m => [m.content, m.stickers]), [['嗯', undefined]]);
  const e = fakeDiscord(t, { replyText: '嗯[[sticker:Wow]]', stickersEnabled: false });
  await e.bot.runAndReply(e.message, { id: 's' }, { text: 'x' });
  assert.deepEqual(e.sent.map(m => [m.content, m.stickers]), [['嗯', undefined]]);
  assert.equal(e.bot.contextExtras(e.message.guild, {}).stickers, undefined);
  assert.match(a.bot.contextExtras(a.message.guild, {}).stickers, /^三月七比心 — 比心（❤️）\nWow（😮）$/);
});
