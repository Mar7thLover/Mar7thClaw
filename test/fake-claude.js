// 模拟 Claude Code 的 stream-json 协议，供运行器测试使用。行为由 FAKE_MODE 控制。
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE || 'text';
const sessionId = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1];
const out = value => process.stdout.write(JSON.stringify(value) + '\n');

if (mode === 'resume-missing' && args.includes('--resume')) {
  process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });
let waiting = null;
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response') { waiting?.(msg.response); return; }
  if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (msg.type !== 'user') return;
  run(msg.message.content).catch(error => { process.stderr.write(String(error)); process.exit(2); });
});
rl.on('close', () => process.exit(0));

async function run(prompt) {
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd(), permissionMode: args[args.indexOf('--permission-mode') + 1] });
  out({ type: 'stream_event', event: { type: 'message_start' } });
  const text = Array.isArray(prompt) ? prompt.filter(b => b.type === 'text').map(b => b.text).join('') : prompt;
  const imageCount = Array.isArray(prompt) ? prompt.filter(b => b.type === 'image' && b.source?.data).length : 0;
  const echo = mode === 'images' ? `图片${imageCount}张，首块${Array.isArray(prompt) ? prompt[0].type : 'text'}` : `收到：${text.includes('<message') ? 'wrapped' : 'raw'}`;
  for (const piece of [echo.slice(0, 3), echo.slice(3)]) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
  if (mode === 'permission') {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'echo hi' } }] } });
    const response = await new Promise(resolve => {
      waiting = resolve;
      out({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo hi' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }] } });
    });
    const allowed = response.response.behavior === 'allow';
    const always = Boolean(response.response.updatedPermissions?.every(rule => rule.destination === 'session'));
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: allowed ? 'hi' : 'denied', is_error: !allowed }] } });
    out({ type: 'stream_event', event: { type: 'message_start' } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: allowed ? `允许${always ? '(always)' : ''}` : '拒绝' } } });
  }
  if (mode === 'hang') return; // 等待中断
  out({ type: 'result', subtype: 'success', is_error: false, result: '最终回复', session_id: sessionId, total_cost_usd: 0.01, duration_ms: 5, num_turns: 1, usage: {} });
}
