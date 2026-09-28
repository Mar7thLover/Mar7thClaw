import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// 一次性的后台小任务（如整理人物档案）：无工具、安全模式、不保存会话，stdin 传入提示词。
export async function runOneShot({ claudeBin, tmpDir, prompt, system = '', model = 'haiku', timeoutMs = 120000, spawnProcess = spawn }) {
  const dir = path.join(tmpDir, `oneshot-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  delete env.CLAUDECODE;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--disable-slash-commands', '--permission-mode', 'dontAsk'];
  if (model) args.push('--model', model);
  if (system) args.push('--system-prompt', system);
  let child;
  try {
    child = spawnProcess(claudeBin, args, { cwd: dir, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    const closed = new Promise(resolve => child.once('close', resolve));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let result = null;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stdin.end(prompt, 'utf8');
    for await (const line of lines) {
      try { const item = JSON.parse(line); if (item.type === 'result') result = item; } catch { /* 忽略非 JSON 行 */ }
    }
    await closed;
    clearTimeout(timer);
    if (!result || result.is_error || result.subtype !== 'success') throw new Error(`后台任务失败（${result?.subtype || '没有结果'}）`);
    return { text: String(result.result || ''), costUsd: result.total_cost_usd ?? null };
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
