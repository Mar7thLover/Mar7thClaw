import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class RunnerError extends Error {
  constructor(message, code = 'claude_error') {
    super(message);
    this.code = code;
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Bash/PowerShell 工具会派生子进程；Windows 上必须按进程树结束，否则会遗留孤儿进程。
  if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else child.kill('SIGKILL');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part.type === 'text' ? part.text : `[${part.type}]`).join('\n');
  return '';
}

export function buildArgs(turn, systemFile, mcpFile = null) {
  const args = [
    '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages',
    '--permission-prompt-tool', 'stdio', '--permission-mode', turn.permissionMode || 'auto',
    '--append-system-prompt-file', systemFile,
    // 角色卡修改后立刻作用于已有会话，而不是沿用首轮快照。
    '--system-prompt-snapshot', 'off',
  ];
  args.push(...(turn.resume ? ['--resume', turn.claudeSessionId] : ['--session-id', turn.claudeSessionId]));
  if (turn.model) args.push('--model', turn.model);
  if (turn.effort) args.push('--effort', turn.effort);
  if (turn.name && !turn.resume) args.push('--name', turn.name);
  if (turn.tier === 'guest') {
    // 访客：不加载本机 CLAUDE.md/技能/MCP；工具最多只有 WebSearch（WebFetch 能访问内网，不开放）。
    const tools = (turn.guestTools || []).filter(tool => tool === 'WebSearch');
    args.push('--tools', tools.join(','), '--safe-mode', '--strict-mcp-config', '--disable-slash-commands');
    if (tools.length) args.push('--allowed-tools', tools.join(','));
  } else {
    for (const dir of turn.addDirs || []) args.push('--add-dir', dir);
    // Claw 自己的 MCP 工具（定时任务）：追加到用户已有的 MCP 配置之上，并预先放行。
    if (mcpFile) args.push('--mcp-config', mcpFile, '--allowed-tools', 'mcp__claw');
    if (turn.disallowedTools?.length) args.push('--disallowed-tools', turn.disallowedTools.join(','));
  }
  return args;
}

/**
 * 运行一轮 Claude Code。
 * @param {object} turn { claudeSessionId, resume, cwd, system, prompt, model, effort, permissionMode, tier, addDirs, disallowedTools, name }
 * @param {object} io { claudeBin, tmpDir, signal, onEvent(event), canUseTool(request) => Promise<decision> }
 */
export async function runTurn(turn, { claudeBin, tmpDir, signal, onEvent = () => {}, canUseTool, spawnProcess = spawn }) {
  await mkdir(tmpDir, { recursive: true });
  const systemFile = path.join(tmpDir, `system-${randomUUID()}.txt`);
  await writeFile(systemFile, turn.system, { encoding: 'utf8', mode: 0o600 });
  // 令牌放在临时文件里而不是命令行参数中，避免出现在进程列表。
  const mcpFile = turn.tier !== 'guest' && turn.mcpServers ? path.join(tmpDir, `mcp-${randomUUID()}.json`) : null;
  if (mcpFile) await writeFile(mcpFile, JSON.stringify({ mcpServers: turn.mcpServers }), { encoding: 'utf8', mode: 0o600 });
  await mkdir(turn.cwd, { recursive: true });
  const env = { ...process.env };
  // 若面板本身从 Claude Code 里启动，去掉嵌套标记，子进程才会作为独立会话运行。
  delete env.CLAUDECODE;
  if (turn.tier === 'guest') env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  let child;
  let lines;
  let closed;
  let interruptTimer;
  const pendingPermissions = new Map();
  const onAbort = () => {
    // 先请求 CLI 优雅中断（会话记录保持完整），5 秒内没退出再强杀进程树。
    try { child?.stdin.write(JSON.stringify({ type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } }) + '\n'); } catch { /* stdin 已关闭 */ }
    for (const controller of pendingPermissions.values()) controller.abort();
    interruptTimer = setTimeout(() => killTree(child), 5000);
  };
  try {
    child = spawnProcess(claudeBin, buildArgs(turn, systemFile, mcpFile), { cwd: turn.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    child.stdin.on('error', () => {});
    closed = new Promise(resolve => child.once('close', code => resolve(code)));
    signal?.addEventListener('abort', onAbort, { once: true });
    const send = value => { if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(JSON.stringify(value) + '\n'); };
    // 图片作为内容块直接交给模型（不依赖 Read 工具，访客也能看图），放在文字之前。
    const content = turn.images?.length
      ? [...turn.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })), { type: 'text', text: turn.prompt }]
      : turn.prompt;
    send({ type: 'user', message: { role: 'user', content } });
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let result;
    let started = false;
    let streamedText = false;
    const finalTexts = [];
    for await (const line of lines) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (item.type === 'control_request' && item.request?.subtype === 'can_use_tool') {
        const request = item.request;
        const controller = new AbortController();
        pendingPermissions.set(item.request_id, controller);
        const answer = decision => {
          pendingPermissions.delete(item.request_id);
          send({ type: 'control_response', response: { subtype: 'success', request_id: item.request_id, response: decision } });
        };
        const event = {
          type: 'permission', requestId: item.request_id, toolName: request.tool_name, displayName: request.display_name || request.tool_name,
          input: request.input, description: request.description || '', reason: request.decision_reason || '', blockedPath: request.blocked_path || '',
          canAlwaysAllow: request.suppress_always_allow_rule !== true && Array.isArray(request.permission_suggestions) && request.permission_suggestions.length > 0,
        };
        onEvent(event);
        Promise.resolve(canUseTool ? canUseTool(event, controller.signal) : { behavior: 'deny', message: 'Claw 没有配置权限审批' })
          .then(decision => {
            if (decision.behavior === 'allow') {
              const response = { behavior: 'allow', updatedInput: request.input };
              if (decision.always && event.canAlwaysAllow) {
                response.updatedPermissions = request.permission_suggestions.map(rule => ({ ...rule, destination: 'session' }));
              }
              answer(response);
            } else answer({ behavior: 'deny', message: decision.message || '用户拒绝了这次操作。' });
            onEvent({ type: 'permission_resolved', requestId: item.request_id, behavior: decision.behavior, by: decision.by || '' });
          })
          .catch(() => answer({ behavior: 'deny', message: '权限审批失败或已取消。' }));
        continue;
      }
      if (item.type === 'control_request' && item.request?.subtype === 'hook_callback') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: item.request_id, response: {} } });
        continue;
      }
      if (item.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'error', request_id: item.request_id, error: 'Claw 不支持该控制请求' } });
        continue;
      }
      if (item.parent_tool_use_id) continue; // 子代理内部过程不展示
      if (item.type === 'system' && item.subtype === 'init') {
        started = true;
        onEvent({ type: 'init', claudeSessionId: item.session_id, model: item.model, cwd: item.cwd, permissionMode: item.permissionMode });
      } else if (item.type === 'stream_event') {
        const ev = item.event;
        if (ev?.type === 'message_start') onEvent({ type: 'segment' });
        else if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') { streamedText = true; onEvent({ type: 'text', text: ev.delta.text }); }
          else if (ev.delta?.type === 'thinking_delta') onEvent({ type: 'thinking', text: ev.delta.thinking });
        }
      } else if (item.type === 'assistant') {
        if (item.error) {
          const detail = (item.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
          onEvent({ type: 'error', message: detail || 'Claude Code 返回了错误' });
        }
        for (const block of item.message?.content || []) {
          if (block.type === 'tool_use') onEvent({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          else if (block.type === 'text' && block.text) {
            finalTexts.push(block.text);
            if (!streamedText) onEvent({ type: 'text', text: block.text });
          }
        }
      } else if (item.type === 'user' && Array.isArray(item.message?.content)) {
        for (const block of item.message.content) {
          if (block.type === 'tool_result') onEvent({ type: 'tool_result', id: block.tool_use_id, isError: block.is_error === true, text: toolResultText(block.content).slice(0, 4000) });
        }
      } else if (item.type === 'result') {
        result = item;
        // 结果出来后关闭 stdin，CLI 才会结束进程。
        child.stdin.end();
      }
    }
    const code = await closed;
    if (spawnError) throw new RunnerError(`无法启动 Claude Code（${spawnError.code || 'spawn 失败'}），请检查 claudeBin 配置`, 'cli_unavailable');
    if (signal?.aborted) return { ok: false, interrupted: true, started, text: result?.result || finalTexts.at(-1) || '' };
    if (!result) {
      if (/No conversation found|not found.*session|session.*not found/i.test(stderr)) throw new RunnerError('找不到要续接的 Claude Code 会话', 'resume_failed');
      if (/already in use/i.test(stderr)) throw new RunnerError('会话 ID 已被占用', 'session_in_use');
      if (/unknown option|unknown argument/i.test(stderr)) throw new RunnerError('当前 Claude Code 版本不支持所需参数，请升级（claude update）', 'cli_outdated');
      throw new RunnerError(`Claude Code 在给出结果前退出（exit ${code}）${started ? '' : '，可运行 npm run doctor 检查登录状态'}`, 'cli_failed');
    }
    const ok = !result.is_error && result.subtype === 'success';
    return {
      ok, started,
      text: typeof result.result === 'string' ? result.result : finalTexts.at(-1) || '',
      error: ok ? '' : (result.api_error_status === 429 ? '触发了额度或速率限制，稍后再试' : `生成失败（${result.subtype || 'error'}）`),
      usage: result.usage || null, costUsd: result.total_cost_usd ?? null, durationMs: result.duration_ms ?? null,
      numTurns: result.num_turns ?? null, claudeSessionId: result.session_id, denials: result.permission_denials || [],
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    clearTimeout(interruptTimer);
    for (const controller of pendingPermissions.values()) controller.abort();
    killTree(child);
    lines?.close();
    if (closed) await closed;
    await rm(systemFile, { force: true });
    if (mcpFile) await rm(mcpFile, { force: true });
  }
}
