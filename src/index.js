import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, root, dataDir } from './config.js';
import { CardStore } from './persona/card.js';
import { SessionManager } from './sessions.js';
import { DiscordBot } from './discord/bot.js';
import { createServer } from './server.js';
import { ModelCatalog } from './claude/models.js';
import { Scheduler } from './scheduler.js';
import { PeopleMemory } from './people.js';
import { GuestUsage } from './guest.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
mkdirSync(dataDir, { recursive: true });
const config = loadConfig();
const cards = new CardStore([path.join(dataDir, 'cards'), path.join(root, 'cards')]);
cards.get(config.card); // 默认角色卡缺失时启动即报错，而不是等到第一条消息
const models = new ModelCatalog({ claudeBin: config.claudeBin, dataDir, log });
const token = randomBytes(24).toString('hex');
const mcp = { url: `http://127.0.0.1:${config.port}`, token, script: path.join(root, 'src', 'mcp', 'claw-server.js') };
const people = new PeopleMemory({ dataDir, config, claudeBin: config.claudeBin, log });
const guestUsage = new GuestUsage({ dataDir, config });
const sessions = new SessionManager({ config, cards, dataDir, models, mcp, people });
const discord = new DiscordBot({ config, sessions, dataDir, log, models, people, guestUsage });
const scheduler = new Scheduler({
  sessions, dataDir, log,
  hooksFor: meta => discord.hooksFor(meta),
  // 面板总会通过事件流收到结果；Discord 会话额外把结果发回原频道/私信。
  deliver: async ({ job, session, text, ok, error, files }) => {
    if (session?.origin === 'discord') await discord.deliverSchedule(session, job, text, ok, error, files);
  },
});
const server = createServer({ config, sessions, cards, discord, models, scheduler, people, guestUsage, token, onShutdown: reason => shutdown(reason) });
const pidFile = path.join(dataDir, 'core.pid');

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`[core] 正在退出（${reason}）`);
  scheduler.stop();
  for (const session of sessions.list()) if (session.busy) sessions.interrupt(session.id);
  server.closeClients();
  server.close();
  await discord.stop().catch(() => {});
  // 给中断中的 Claude Code 进程一点时间写完会话记录。
  const deadline = Date.now() + 6000;
  while (sessions.list().some(session => session.busy) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  rmSync(pidFile, { force: true });
  process.exit(0);
}

server.on('error', error => {
  if (error.code === 'EADDRINUSE') log(`[core] 端口 ${config.port} 已被占用：Mar7thClaw 可能已经在运行`);
  else log(`[core] ${error.message}`);
  process.exit(1);
});
server.listen(config.port, config.host, () => {
  writeFileSync(pidFile, String(process.pid));
  log(`[core] 面板 http://${config.host}:${config.port}/`);
  log(`[core] Claude Code: ${config.claudeBin}`);
  log(`[core] 角色卡: ${config.card} · 默认工作目录: ${config.agent.cwd} · 权限模式: ${config.agent.permissionMode}`);
  discord.start().catch(error => log(`[discord] 启动失败：${error.message}`));
  scheduler.start();
  log(`[schedule] ${scheduler.list().filter(job => job.enabled).length} 个定时任务已启用`);
  models.load().then(() => server.broadcast({ kind: 'models', models: models.state }));
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => shutdown(signal));
