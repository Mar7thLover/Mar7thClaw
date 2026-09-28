// 自检：Claude Code 可执行文件与登录状态、角色卡、Discord 配置、端口。不打印令牌与账号信息。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadConfig, root, dataDir } from '../src/config.js';
import { CardStore } from '../src/persona/card.js';

const run = promisify(execFile);
const ok = text => console.log(`✓ ${text}`);
const bad = text => { console.log(`✗ ${text}`); process.exitCode = 1; };
const config = loadConfig();

try {
  const { stdout } = await run(config.claudeBin, ['--version'], { windowsHide: true, timeout: 20000 });
  ok(`Claude Code ${stdout.trim()}（${config.claudeBin}）`);
} catch (error) { bad(`无法运行 Claude Code：${error.message}`); }

try {
  const { stdout } = await run(config.claudeBin, ['auth', 'status'], { windowsHide: true, timeout: 20000 });
  const status = JSON.parse(stdout);
  if (status.loggedIn) ok(`Claude Code 已登录（${status.authMethod || '未知方式'}）`);
  else bad('Claude Code 未登录：在终端运行 claude auth login');
} catch { console.log('? 无法读取登录状态（旧版 CLI 可能不支持 claude auth status），首次对话时会看到结果'); }

try {
  const cards = new CardStore([path.join(dataDir, 'cards'), path.join(root, 'cards')]);
  const card = cards.get(config.card);
  ok(`角色卡「${card.data.name}」：世界书 ${card.data.character_book.entries.length} 条`);
} catch (error) { bad(`角色卡加载失败：${error.message}`); }

const d = config.discord;
if (!d.enabled) console.log('- Discord 已停用');
else if (!d.token) bad('Discord 未配置令牌：运行 npm run import-openclaw');
else ok(`Discord 令牌已配置；主人 ${d.owners.length} 人，白名单 ${d.allowFrom.length} 人，服务器 ${Object.keys(d.guilds).length} 个`);

try {
  const res = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(2000) });
  const body = await res.json();
  if (body.name === 'mar7thclaw') ok(`核心正在运行：http://127.0.0.1:${config.port}/`);
  else bad(`端口 ${config.port} 被其他程序占用`);
} catch { console.log(`- 核心未运行（端口 ${config.port} 空闲）`); }
ok(`默认工作目录 ${config.agent.cwd} · 权限模式 ${config.agent.permissionMode}`);
