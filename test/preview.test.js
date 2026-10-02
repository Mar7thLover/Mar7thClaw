import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiscordBot } from '../src/discord/bot.js';
import { DEFAULTS, merge } from '../src/config.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('流式预览：预览消息还在发送途中本轮就结束时，不会多出一条残留的预览', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-preview-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = merge(DEFAULTS, { discord: { streamPreview: true } });
  const full = '这是一段足够长、会触发流式预览的回复内容，后面还有更多的字。';
  const sessions = {
    send: async (id, payload, hooks) => {
      hooks.onEvent({ type: 'turn_start' });
      hooks.onEvent({ type: 'text', text: full });
      await sleep(10);
      hooks.onEvent({ type: 'turn_end', ok: true });
      return { ok: true, entry: { text: full }, files: [] };
    },
  };
  const bot = new DiscordBot({ config, sessions, dataDir: dir, log: () => {} });
  // 频道里实际可见的消息：发送有延迟，编辑和删除直接生效。
  const visible = [];
  const post = async payload => {
    await sleep(80);
    const msg = { content: payload.content, edit: async p => { msg.content = p.content; return msg; }, delete: async () => { visible.splice(visible.indexOf(msg), 1); } };
    visible.push(msg);
    return msg;
  };
  const channel = { guild: null, sendTyping: async () => {}, send: post };
  const message = { channel, author: { id: 'u' }, react: async () => {}, reply: post };
  await bot.runAndReply(message, { id: 's' }, { text: 'x' });
  await sleep(200);
  assert.deepEqual(visible.map(m => m.content), [full]);
});
