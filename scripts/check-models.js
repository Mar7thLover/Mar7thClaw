// 逐个真实调用模型，确认当前账号能否使用（会消耗少量额度）。
// 用法：npm run models:check            只校验旧版模型
//       npm run models:check -- --all   校验列表中所有完整模型 ID
//       npm run models:check -- claude-opus-4-8 claude-sonnet-4-6
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig, dataDir } from '../src/config.js';
import { ModelCatalog } from '../src/claude/models.js';

const config = loadConfig();
const catalog = new ModelCatalog({ claudeBin: config.claudeBin, dataDir, log: console.log });
await catalog.load();
const args = process.argv.slice(2);
const targets = args.includes('--all')
  ? catalog.state.models.filter(m => m.group === 'full' || m.group === 'legacy').map(m => m.id)
  : args.length ? args : catalog.state.models.filter(m => m.group === 'legacy').map(m => m.id);

function check(model) {
  return new Promise(resolve => {
    const dir = path.join(dataDir, 'tmp', `check-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    delete env.CLAUDECODE;
    const child = spawn(config.claudeBin, ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--safe-mode', '--tools', '',
      '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands'], { cwd: dir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    let actualModel = null;
    let result = null;
    const timer = setTimeout(() => child.kill(), 90000);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const item = JSON.parse(line);
        if (item.type === 'assistant' && item.message?.model) actualModel = item.message.model;
        if (item.type === 'result') result = item;
      } catch { /* 忽略非 JSON 行 */ }
    });
    child.stdin.end('只回复 OK 两个字母。');
    child.on('close', () => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      const ok = result && !result.is_error && result.subtype === 'success';
      const base = model.replace(/\[1m\]$/, '');
      const status = !ok ? 'failed' : actualModel && !actualModel.startsWith(base) ? 'model-mismatch' : 'verified';
      resolve({ model, checkedAt: new Date().toISOString(), actualModel, status, ...(ok ? {} : { error: result?.api_error_status ? `HTTP ${result.api_error_status}` : result?.subtype || 'no result' }) });
    });
  });
}

const file = path.join(dataDir, 'model-checks.json');
const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { checks: [] };
const checks = previous.provider === catalog.state.provider ? previous.checks.filter(c => !targets.includes(c.model)) : [];
for (const model of targets) {
  const row = await check(model);
  const mark = { verified: '✓', failed: '✗', 'model-mismatch': '≠' }[row.status];
  console.log(`${mark} ${model}${row.actualModel && row.actualModel !== model ? ` → ${row.actualModel}` : ''}${row.error ? `（${row.error}）` : ''}`);
  checks.push(row);
}
writeFileSync(file, JSON.stringify({ provider: catalog.state.provider, checks }, null, 2), 'utf8');
console.log(`结果已写入 ${file}；运行中的核心会在面板点「刷新模型」或重启后读取。`);
