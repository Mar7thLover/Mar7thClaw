import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// 仍在服务的旧版模型（Anthropic 官方停用表，2026-09-24 核对，与 ClaudeBridge 一致）。
// CLI 菜单只列最新模型，这些需要手动补充；能否在当前账号使用以 data/model-checks.json 的实测为准。
export const LEGACY_MODELS = [
  ['claude-fable-5', 'Fable 5'],
  ['claude-opus-5', 'Opus 5'],
  ['claude-opus-4-8', 'Opus 4.8'],
  ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-6', 'Opus 4.6'],
  ['claude-opus-4-5-20251101', 'Opus 4.5'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'],
  ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
];

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FALLBACK_MENU = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Default (Opus 5.5)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
];
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}(?:\[1m\])?$/.test(value);
const stripContext = value => value.replace(/\[1m\]$/, '');

// CLI 菜单没有给出档位时按官方文档推断（Claude Code model-config，2026-09-24）。
export function effortLevelsFor(id) {
  const base = stripContext(id);
  if (/^claude-(?:fable-5|mythos-5|opus-(?:5|4-[78])|sonnet-5)(?:-|$)/.test(base)) return [...EFFORTS];
  if (/^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(base)) return ['low', 'medium', 'high', 'max'];
  return [];
}

// 用 SDK initialize 控制消息读取当前账号的模型菜单：不生成回复、不消耗额度、不保存账号身份。
export async function discoverMenu(claudeBin, tmpDir, { timeoutMs = 20000, spawnProcess = spawn } = {}) {
  const dir = path.join(tmpDir, `models-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  delete env.CLAUDECODE;
  let child;
  let timer;
  try {
    child = spawnProcess(claudeBin, ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'],
    { cwd: dir, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    return await new Promise((resolve, reject) => {
      let buffer = '';
      child.once('error', error => reject(new Error(`无法启动 Claude Code（${error.code || 'spawn 失败'}）`)));
      child.once('close', () => reject(new Error('Claude Code 在返回模型菜单前退出')));
      timer = setTimeout(() => reject(new Error('读取模型菜单超时')), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          let item;
          try { item = JSON.parse(line); } catch { continue; }
          if (item.type !== 'control_response' || item.response?.request_id !== 'claw-models') continue;
          const result = item.response.response;
          const rows = (result?.models || []).filter(row => validId(row.value) && validId(row.resolvedModel)).map(row => ({
            value: row.value, resolvedModel: row.resolvedModel, displayName: row.displayName || row.value, description: row.description || '',
            effortLevels: row.supportsEffort === false ? [] : (row.supportedEffortLevels || []).filter(level => EFFORTS.includes(level)),
          }));
          if (!rows.length) reject(new Error('Claude Code 没有返回可用的模型菜单'));
          else resolve({ rows, provider: result.account?.apiProvider || 'unknown' });
        }
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'claw-models', request: { subtype: 'initialize' } }) + '\n');
    });
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * 把菜单整理成面板与 Discord 用的列表。每项：
 * { id, label, group: 'menu'|'alias'|'full'|'legacy', resolvedModel, effortLevels, status?, checkedAt? }
 */
export function buildCatalog({ rows, provider }, checks = null) {
  const list = [];
  const seen = new Set();
  const add = (id, label, group, resolvedModel, effortLevels) => {
    if (!validId(id) || seen.has(id)) return;
    seen.add(id);
    list.push({ id, label, group, resolvedModel, effortLevels: effortLevels?.length ? effortLevels : effortLevelsFor(resolvedModel) });
  };
  for (const row of rows) add(row.value, row.value === row.resolvedModel ? row.displayName : `${row.displayName} → ${row.resolvedModel}`, 'menu', row.resolvedModel, row.effortLevels);
  // 家族别名始终指向该家族的最新版本；sonnet/opus 在支持时另给 1M 上下文版本。
  for (const family of ['opus', 'sonnet', 'haiku', 'fable']) {
    const row = rows.find(r => stripContext(r.resolvedModel).startsWith(`claude-${family}-`));
    if (!row) continue;
    const resolved = stripContext(row.resolvedModel);
    add(family, `${family} → ${resolved}`, 'alias', resolved, row.effortLevels);
    if (family !== 'haiku' && /^claude-(?:fable-5|sonnet-5|opus-(?:5|4-[78]))/.test(resolved)) add(`${family}[1m]`, `${family}[1m] → ${resolved}（1M 上下文）`, 'alias', `${resolved}[1m]`, row.effortLevels);
  }
  const best = rows.find(r => stripContext(r.resolvedModel).startsWith('claude-fable-')) || rows.find(r => stripContext(r.resolvedModel).startsWith('claude-opus-'));
  if (best) add('best', `best → ${stripContext(best.resolvedModel)}`, 'alias', stripContext(best.resolvedModel), best.effortLevels);
  for (const row of rows) {
    const full = stripContext(row.resolvedModel);
    add(full, full, 'full', full, row.effortLevels);
    if (/^claude-(?:fable-5|sonnet-5|opus-(?:5|4-[78]))/.test(full)) add(`${full}[1m]`, `${full}[1m]（1M 上下文）`, 'full', `${full}[1m]`, row.effortLevels);
  }
  if (provider === 'firstParty' || provider === 'unknown') {
    for (const [id, name] of LEGACY_MODELS) add(id, `${name}（${id}）`, 'legacy', id, effortLevelsFor(id));
  }
  if (checks?.provider === provider) {
    for (const item of list) {
      const check = checks.checks?.find(c => c.model === item.id);
      if (check) Object.assign(item, { status: check.status, checkedAt: check.checkedAt, actualModel: check.actualModel || null });
    }
  }
  return list;
}

export class ModelCatalog {
  constructor({ claudeBin, dataDir, log = () => {} }) {
    this.claudeBin = claudeBin;
    this.tmpDir = path.join(dataDir, 'tmp');
    this.cacheFile = path.join(dataDir, 'models.json');
    this.checksFile = path.join(dataDir, 'model-checks.json');
    this.log = log;
    this.state = { models: buildCatalog({ rows: FALLBACK_MENU, provider: 'unknown' }), provider: 'unknown', source: 'fallback', discoveredAt: null, error: '' };
  }

  async readJson(file) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  }

  // 先用上次缓存立即可用，再后台刷新。
  async load() {
    const cached = await this.readJson(this.cacheFile);
    if (cached?.rows?.length) await this.apply(cached, 'cache');
    return this.refresh().catch(() => this.state);
  }

  async apply(discovery, source) {
    const checks = await this.readJson(this.checksFile);
    this.state = { models: buildCatalog(discovery, checks), provider: discovery.provider, source, discoveredAt: discovery.discoveredAt, error: '' };
    return this.state;
  }

  async refresh() {
    try {
      const discovery = { ...(await discoverMenu(this.claudeBin, this.tmpDir)), discoveredAt: new Date().toISOString() };
      await writeFile(this.cacheFile, JSON.stringify(discovery, null, 2), 'utf8');
      await this.apply(discovery, 'cli');
      this.log(`[models] 从 Claude Code 读取到 ${discovery.rows.length} 个菜单项，共 ${this.state.models.length} 个可选模型`);
    } catch (error) {
      this.state.error = error.message;
      this.log(`[models] 读取模型菜单失败，使用${this.state.source === 'cache' ? '缓存' : '内置'}列表：${error.message}`);
    }
    return this.state;
  }

  async reloadChecks() {
    const cached = await this.readJson(this.cacheFile);
    if (cached?.rows?.length) await this.apply(cached, this.state.source);
    return this.state;
  }

  find(id) {
    return this.state.models.find(model => model.id === id) || null;
  }
}
