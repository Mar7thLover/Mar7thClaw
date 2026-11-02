import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { SessionManager } from '../src/sessions.js';
import { CardStore } from '../src/persona/card.js';
import { DiscordBot, linkedImages, discordMediaUrl } from '../src/discord/bot.js';
import { DEFAULTS, merge } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const embed = (type, field, url) => ({ data: { type }, [field]: { url: `https://media.tenor.com/x.${type === 'gifv' ? 'mp4' : 'png'}`, proxyURL: url } });

test('链接图片：只认 Discord 域名，取 GIF/图片预览、带图预览、转发消息与正文里的 Discord 图片链接', () => {
  assert.equal(discordMediaUrl('http://cdn.discordapp.com/a.png'), null);
  assert.equal(discordMediaUrl('https://127.0.0.1/a.png'), null);
  assert.equal(discordMediaUrl('https://cdn.discordapp.com.evil.com/a.png'), null);
  assert.ok(discordMediaUrl('https://images-ext-1.discordapp.net/external/abc/https/media.tenor.com/x.png'));
  const message = {
    content: '看 https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1 和 https://example.com/a.png',
    embeds: [
      embed('gifv', 'thumbnail', 'https://images-ext-1.discordapp.net/external/a/https/media.tenor.com/x.png'),
      embed('article', 'thumbnail', 'https://images-ext-1.discordapp.net/external/b/site-logo.png'),
      embed('rich', 'image', 'https://images-ext-2.discordapp.net/external/c/photo.jpg'),
      embed('image', 'thumbnail', 'http://10.0.0.1/secret.png'),
    ],
    messageSnapshots: new Map([['f', { attachments: new Map([['a', { name: 'fwd.jpg', contentType: 'image/jpeg', size: 10, url: 'https://cdn.discordapp.com/attachments/3/4/fwd.jpg' }]]), embeds: [] }]]),
  };
  const urls = linkedImages(message).map(item => item.url);
  assert.deepEqual(urls, [
    'https://images-ext-1.discordapp.net/external/a/https/media.tenor.com/x.png',
    'https://images-ext-2.discordapp.net/external/c/photo.jpg',
    'https://cdn.discordapp.com/attachments/3/4/fwd.jpg',
    'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1',
  ]);
});

test('访客：GIF 选择器发的动图（链接预览）也会作为图片内容块交给模型', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-linked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') }, discord: { owners: ['1'] } });
  const sessions = new SessionManager({ config, cards: new CardStore([path.join(here, '..', 'cards')]), dataDir: dir, runTurn: async () => ({ ok: true, text: 'ok' }) });
  const bot = new DiscordBot({ config, sessions, dataDir: dir, log: () => {} });
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f9c' } }).png().toBuffer();
  const fetched = [];
  bot.download = async item => { fetched.push(item.url); return png; };
  const message = { id: '9', guildId: 'g', channelId: 'c', author: { id: '2', username: 'u2' }, channel: { name: 'chat' }, member: null, content: 'https://tenor.com/view/x',
    attachments: new Map(), stickers: new Map(), embeds: [embed('gifv', 'thumbnail', 'https://images-ext-1.discordapp.net/external/a/https/media.tenor.com/x.png')] };
  const meta = bot.sessionFor(message, 'guest');
  const result = await bot.processAttachments(message, meta, null, 'guest');
  assert.equal(fetched.length, 1);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, 'image/png');
});
