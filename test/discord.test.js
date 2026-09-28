import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMessage } from '../src/discord/chunk.js';
import { compileMentionPatterns, evaluateMessage, stripBotMention } from '../src/discord/gating.js';

test('提及正则：兼容 OpenClaw 的 (?i) 写法，统一不区分大小写，拒绝嵌套量词', () => {
  const patterns = compileMentionPatterns(['(?i)March7thClaw', '(?:三月七|小三月)', '(a+)+', '[']);
  assert.equal(patterns.length, 2);
  assert.ok(patterns[0].test('hey march7thclaw'));
  assert.ok(patterns[1].test('小三月在吗'));
});

const cfg = {
  owners: ['1'], allowFrom: ['1', '2'], dmPolicy: 'allowlist', groupPolicy: 'allowlist',
  guilds: { g1: { requireMention: true, ignoreOtherMentions: true, users: ['1', '2'], roles: [] }, g2: { requireMention: false, channels: { c9: {} } } },
};
const patterns = compileMentionPatterns(['(?:三月七|小三月)']);
const base = { authorId: '1', authorIsBot: false, isDM: false, guildId: 'g1', channelId: 'c1', parentId: null, text: '', mentionsBot: false, mentionsOthers: false, replyToBot: false, roleIds: [] };

test('门控：私信白名单与主人/访客分级', () => {
  assert.deepEqual(evaluateMessage({ ...base, isDM: true }, cfg, patterns), { accept: true, reason: 'dm', tier: 'owner' });
  assert.equal(evaluateMessage({ ...base, isDM: true, authorId: '2' }, cfg, patterns).tier, 'guest');
  assert.equal(evaluateMessage({ ...base, isDM: true, authorId: '3' }, cfg, patterns).accept, false);
  assert.equal(evaluateMessage({ ...base, isDM: true, authorId: '3' }, { ...cfg, dmPolicy: 'open' }, patterns).accept, true);
  assert.equal(evaluateMessage({ ...base, authorIsBot: true, isDM: true }, cfg, patterns).accept, false);
});

test('门控：服务器白名单、用户限制、requireMention、提及词、回复机器人', () => {
  assert.equal(evaluateMessage({ ...base, guildId: 'other', mentionsBot: true }, cfg, patterns).reason, 'guild-not-allowed');
  assert.equal(evaluateMessage({ ...base, authorId: '3', mentionsBot: true }, cfg, patterns).reason, 'user-not-allowed');
  const quiet = evaluateMessage({ ...base, text: '今天天气不错' }, cfg, patterns);
  assert.deepEqual([quiet.accept, quiet.record], [false, true]);
  assert.equal(evaluateMessage({ ...base, text: '三月七帮我看看' }, cfg, patterns).accept, true);
  assert.equal(evaluateMessage({ ...base, replyToBot: true }, cfg, patterns).accept, true);
  assert.equal(evaluateMessage({ ...base, text: '三​月七' }, cfg, patterns).accept, true);
});

test('门控：ignoreOtherMentions 与频道白名单', () => {
  assert.equal(evaluateMessage({ ...base, text: '三月七', mentionsOthers: true }, cfg, patterns).reason, 'other-mention');
  assert.equal(evaluateMessage({ ...base, mentionsBot: true, mentionsOthers: true }, cfg, patterns).accept, true);
  assert.equal(evaluateMessage({ ...base, guildId: 'g2', channelId: 'c1' }, cfg, patterns).reason, 'channel-not-allowed');
  assert.equal(evaluateMessage({ ...base, guildId: 'g2', channelId: 'c9' }, cfg, patterns).reason, 'open-channel');
  assert.equal(evaluateMessage({ ...base, guildId: 'g2', channelId: 't1', parentId: 'c9' }, cfg, patterns).accept, true);
  assert.equal(evaluateMessage({ ...base, mentionsBot: true }, { ...cfg, groupPolicy: 'disabled' }, patterns).accept, false);
});

test('去掉对机器人的 @', () => {
  assert.equal(stripBotMention('<@123> 你好 <@!123>', '123'), '你好');
});

test('分块：不超过 2000 字符与行数上限，代码块在块间保持闭合', () => {
  const code = ['```js', ...Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`), '```'].join('\n');
  const chunks = chunkMessage(`开头说明\n${code}\n结尾`, { maxChars: 2000, maxLines: 17 });
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2000);
    assert.equal((chunk.match(/^```/gm) || []).length % 2, 0, `未闭合：${chunk}`);
  }
  assert.ok(chunks[1].startsWith('```js'));
  assert.equal(chunks.join('\n').includes('const v39 = 39;'), true);
});

test('分块：超长单行优先在中文标点处断开，不劈开 emoji', () => {
  const line = '三月七，'.repeat(700);
  const chunks = chunkMessage(line, { maxChars: 2000, maxLines: 100 });
  assert.ok(chunks.every(c => c.length <= 2000));
  assert.ok(chunks[0].endsWith('，'));
  const emoji = '😀'.repeat(1500);
  for (const chunk of chunkMessage(emoji, { maxChars: 2000 })) assert.ok(!/[\ud800-\udbff]$/.test(chunk));
  assert.deepEqual(chunkMessage('  '), []);
});
