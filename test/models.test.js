import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCatalog, effortLevelsFor, LEGACY_MODELS } from '../src/claude/models.js';
import { SessionManager } from '../src/sessions.js';
import { CardStore } from '../src/persona/card.js';
import { DEFAULTS, merge } from '../src/config.js';

const menu = {
  provider: 'firstParty',
  rows: [
    { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1[1m]', displayName: 'Fable', effortLevels: ['low', 'high'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', effortLevels: [] },
  ],
};

test('模型目录：菜单、别名、完整 ID（含 1M 版本）与旧版模型都列出，且不重复', () => {
  const list = buildCatalog(menu);
  const ids = list.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['default', 'opus', 'haiku', 'opus[1m]', 'fable', 'fable[1m]', 'best', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1', 'claude-haiku-4-5-20251001']) assert.ok(ids.includes(id), id);
  for (const [id] of LEGACY_MODELS) assert.equal(list.find(m => m.id === id).group, 'legacy');
  assert.equal(list.find(m => m.id === 'best').resolvedModel, 'claude-fable-5-1');
  assert.deepEqual(list.find(m => m.id === 'fable').effortLevels, ['low', 'high']);
  assert.deepEqual(list.find(m => m.id === 'haiku').effortLevels, []);
  assert.equal(list.find(m => m.id === 'opus').label, 'Opus → claude-opus-5-5');
});

test('模型目录：第三方提供商不补旧版模型；实测结果只在同一提供商下生效', () => {
  assert.ok(!buildCatalog({ ...menu, provider: 'bedrock' }).some(m => m.group === 'legacy'));
  const checks = { provider: 'firstParty', checks: [{ model: 'claude-fable-5', status: 'model-mismatch', actualModel: 'claude-opus-5', checkedAt: 't' }] };
  assert.equal(buildCatalog(menu, checks).find(m => m.id === 'claude-fable-5').actualModel, 'claude-opus-5');
  const refused = { provider: 'firstParty', checks: [{ model: 'claude-fable-5', status: 'refusal-fallback', actualModel: 'claude-opus-4-8', refusalCategory: 'cyber', checkedAt: 't' }] };
  assert.equal(buildCatalog(menu, refused).find(m => m.id === 'claude-fable-5').refusalCategory, 'cyber');
  assert.equal(buildCatalog(menu, { ...checks, provider: 'vertex' }).find(m => m.id === 'claude-fable-5').status, undefined);
  assert.deepEqual(effortLevelsFor('claude-sonnet-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(effortLevelsFor('claude-opus-4-5-20251101'), []);
});

test('会话：换到不支持当前强度的模型时自动清空强度；显式设置不支持的强度会报错', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalog = buildCatalog(menu);
  const models = { find: id => catalog.find(m => m.id === id) || null };
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') } });
  const sessions = new SessionManager({ config, cards: new CardStore([path.join(dir, 'cards'), path.join(import.meta.dirname, '..', 'cards')]), dataDir: dir, models });
  const meta = sessions.create({ model: 'opus', effort: 'max' });
  sessions.update(meta.id, { model: 'haiku' });
  assert.equal(sessions.get(meta.id).effort, '');
  assert.throws(() => sessions.update(meta.id, { effort: 'high' }), /haiku 支持的强度/);
  sessions.update(meta.id, { model: 'fable', effort: 'high' });
  assert.equal(sessions.get(meta.id).effort, 'high');
});


test('会话：安全防护拦下回复、Claude Code 换模型重试时，聊天记录里留下提示', async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { runTurn } = await import('../src/claude/runner.js');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = merge(DEFAULTS, { agent: { cwd: path.join(dir, 'ws') }, claudeBin: 'fake' });
  const cards = new CardStore([path.join(here, '..', 'cards')]);
  const sessions = new SessionManager({ config, cards, dataDir: dir, runTurn: (turn, io) => runTurn(turn, { ...io, spawnProcess: (bin, args, options) => spawn(process.execPath, [path.join(here, 'fake-claude.js'), ...args], { ...options, env: { ...options.env, FAKE_MODE: 'refusal' } }) }) });
  const meta = sessions.create({});
  const result = await sessions.send(meta.id, { text: '你好' });
  assert.equal(result.ok, true);
  const notice = sessions.transcript(meta.id).find(row => row.kind === 'notice');
  assert.equal(notice.text, 'claude-fable-5 的安全防护拦下了这次回复（cyber），Claude Code 已自动换用 claude-opus-4-8 重试。');
});
