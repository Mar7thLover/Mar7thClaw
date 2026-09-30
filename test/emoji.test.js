import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { annotateEmojis, customEmojisIn, resolveEmojiNames, extractReactions } from '../src/discord/reactions.js';
import { EmojiNotes, stickerImageUrl } from '../src/discord/emoji-notes.js';
import { DiscordBot } from '../src/discord/bot.js';
import { DEFAULTS, merge } from '../src/config.js';

function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-emoji-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const emoji = (id, name, animated = false) => ({ id, name, animated, available: true, toString: () => `<${animated ? 'a' : ''}:${name}:${id}>` });
const EMOJIS = [emoji('100000000000000001', 'emoji_52'), emoji('100000000000000002', 'Firefly', true), emoji('100000000000000003', 'emoji_52')];

test('表情文本：对方消息里的表情附上描述；:名字: 换成标签（代码里和完整标签不动）；[[react:名字]] 可用', () => {
  const notes = { '100000000000000001': '流萤捂脸害羞' };
  assert.equal(annotateEmojis('哈哈<:emoji_52:100000000000000001> <a:x:100000000000000009>', id => notes[id]), '哈哈<:emoji_52:100000000000000001>（表情：流萤捂脸害羞） <a:x:100000000000000009>');
  assert.deepEqual(customEmojisIn('<a:xx:100000000000000009>hi<:y_1:100000000000000008>'), [
    { id: '100000000000000009', name: 'xx', animated: true }, { id: '100000000000000008', name: 'y_1', animated: false }]);
  const lookup = name => EMOJIS.find(e => e.name === name)?.toString() || null;
  assert.equal(resolveEmojiNames('好耶 :Firefly: 和 :nope: 12:30:45 <:emoji_52:100000000000000001> `:Firefly:`\n```\n:Firefly:\n```', lookup),
    '好耶 <a:Firefly:100000000000000002> 和 :nope: 12:30:45 <:emoji_52:100000000000000001> `:Firefly:`\n```\n:Firefly:\n```');
  assert.deepEqual(extractReactions('嗯[[react::Firefly:]][[react:emoji_52]][[react:乱写]]', lookup).reactions, ['<a:Firefly:100000000000000002>', '<:emoji_52:100000000000000001>']);
});

test('上下文：表情目录带描述、不再截到 30 个；贴纸关联的自定义表情 ID 换成名字；:名字: 出现在最终回复里会变成表情', async t => {
  const dir = tempDir(t);
  const config = merge(DEFAULTS, { discord: { streamPreview: false } });
  const many = Array.from({ length: 40 }, (_, i) => emoji(String(200000000000000000n + BigInt(i)), `emoji_${i}`));
  const guild = {
    premiumTier: 0, emojis: { cache: new Map([...EMOJIS, ...many].map(e => [e.id, e])) },
    stickers: { cache: new Map([['300000000000000001', { id: '300000000000000001', name: '你蝶', description: '', tags: '100000000000000002', format: 1 }]]) },
  };
  const emojiNotes = { get: id => ({ '100000000000000001': '流萤捂脸害羞', '300000000000000001': '遐蝶探头' })[id] || '' };
  const sent = [];
  const sessions = { send: async () => ({ ok: true, entry: { text: '看我 :Firefly: [[react:emoji_52]]' }, files: [] }) };
  const bot = new DiscordBot({ config, sessions, dataDir: dir, log: () => {}, emojiNotes });
  const extras = bot.contextExtras(guild, {});
  const lines = extras.emojis.split('\n');
  assert.equal(lines.length, 43);
  assert.equal(lines[0], '<:emoji_52:100000000000000001> — 流萤捂脸害羞');
  assert.equal(lines[1], '<a:Firefly:100000000000000002>');
  assert.equal(extras.stickers, '你蝶 — 遐蝶探头（:Firefly:）');
  const channel = { guild, sendTyping: async () => {}, send: async p => sent.push(p) };
  const message = { channel, guild, react: async e => sent.push({ react: e }), reply: async p => { sent.push(p); return { edit: async () => {}, delete: async () => {} }; } };
  await bot.runAndReply(message, { id: 's' }, { text: 'x' });
  assert.deepEqual(sent.map(p => p.react || p.content), ['<:emoji_52:100000000000000001>', '看我 <a:Firefly:100000000000000002>']);
});

test('表情描述：后台下载图片、分批看图描述并缓存；失败的一天内不重试；手动写的不覆盖；贴纸 Lottie 跳过', async t => {
  const dir = tempDir(t);
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#f0f' } }).png().toBuffer();
  const config = merge(DEFAULTS, {});
  const calls = [];
  let reply = '{"1":"三月七比心","2":"流萤捂脸"}';
  const notes = new EmojiNotes({
    dataDir: dir, config, claudeBin: 'fake', log: () => {},
    fetchImpl: async url => url.includes('broken') ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => png },
    runOneShot: async options => { calls.push(options); return { text: `好的：${reply}` }; },
  });
  const idle = async () => { while (notes.working || notes.queue.length) await new Promise(r => setTimeout(r, 5)); };
  notes.describe([
    { id: '1', kind: 'emoji', name: 'emoji_2', url: 'https://x/1.png', context: 'G' },
    { id: '2', kind: 'emoji', name: 'emoji_3', url: 'https://x/2.png', context: 'G' },
    { id: '3', kind: 'emoji', name: 'bad', url: 'https://x/broken.png', context: 'G' },
    { id: '4', kind: 'sticker', name: 'lottie', url: stickerImageUrl({ id: '4', format: 3 }), context: 'G' },
  ]);
  await idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content.filter(b => b.type === 'image').length, 2);
  assert.match(calls[0].content[0].text, /服务器「G」/);
  assert.equal(notes.get('1'), '三月七比心');
  assert.equal(notes.get('2'), '流萤捂脸');
  assert.equal(notes.get('3'), '');
  assert.ok(JSON.parse(readFileSync(path.join(dir, 'emoji-notes.json'), 'utf8'))['3'].failedAt);
  // 已有描述和刚失败过的都不再排队。
  notes.describe([{ id: '1', kind: 'emoji', name: 'emoji_2', url: 'https://x/1.png', context: 'G' }, { id: '3', kind: 'emoji', name: 'bad', url: 'https://x/broken.png', context: 'G' }]);
  await idle();
  assert.equal(calls.length, 1);
  // 手动改过的描述不会被自动覆盖，重启后照样读得到。
  const file = path.join(dir, 'emoji-notes.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  saved['5'] = { kind: 'emoji', name: 'x', note: '手写', manual: true };
  writeFileSync(file, JSON.stringify(saved));
  const reloaded = new EmojiNotes({ dataDir: dir, config, claudeBin: 'fake', runOneShot: async () => { throw new Error('不该调用'); } });
  assert.equal(reloaded.get('5'), '手写');
  assert.equal(reloaded.get('1'), '三月七比心');
  // 关掉开关后不再描述。
  config.discord.emojiNotes.enabled = false;
  notes.describe([{ id: '9', kind: 'emoji', name: 'n', url: 'https://x/9.png', context: 'G' }]);
  assert.equal(notes.queue.length, 0);
});
