// 从 OpenClaw 配置导入 Discord 令牌与访问策略到 data/config.json。不会打印令牌。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { saveUserConfig, configFile } from '../src/config.js';

const candidates = [
  process.argv[2],
  process.env.OPENCLAW_CONFIG_PATH,
  'D:/Claw/.openclaw/openclaw.json',
  'D:/OpenClawLocal/.openclaw/openclaw.json',
  path.join(homedir(), '.openclaw', 'openclaw.json'),
].filter(Boolean);

const source = candidates.find(file => {
  if (!existsSync(file)) return false;
  try { return Boolean(JSON.parse(readFileSync(file, 'utf8')).channels?.discord?.token); } catch { return false; }
});
if (!source) {
  console.error('没有找到含 Discord 令牌的 OpenClaw 配置。可以把路径作为参数传入：npm run import-openclaw -- <openclaw.json>');
  process.exit(1);
}

const oc = JSON.parse(readFileSync(source, 'utf8'));
const d = oc.channels.discord;
const ownerIds = new Set();
const collectOwners = bySender => {
  for (const [key, rule] of Object.entries(bySender || {})) {
    const id = /^id:(\d+)$/.exec(key)?.[1];
    if (id && Array.isArray(rule?.allow) && rule.allow.includes('*')) ownerIds.add(id);
  }
};
collectOwners(oc.tools?.toolsBySender);
const guilds = {};
for (const [guildId, guild] of Object.entries(d.guilds || {})) {
  collectOwners(guild.toolsBySender);
  const entry = {};
  for (const key of ['requireMention', 'ignoreOtherMentions', 'users', 'roles', 'enabled']) if (guild[key] !== undefined) entry[key] = guild[key];
  if (guild.channels) {
    entry.channels = {};
    for (const [channelId, channel] of Object.entries(guild.channels)) {
      entry.channels[channelId] = {};
      for (const key of ['requireMention', 'ignoreOtherMentions', 'users', 'roles', 'enabled']) if (channel[key] !== undefined) entry.channels[channelId][key] = channel[key];
    }
  }
  guilds[guildId] = entry;
}

const discord = {
  enabled: d.enabled !== false,
  token: d.token,
  allowFrom: (d.allowFrom || []).map(String),
  owners: [...ownerIds],
  dmPolicy: d.dmPolicy === 'pairing' ? 'allowlist' : (d.dmPolicy || 'allowlist'),
  groupPolicy: d.groupPolicy || 'allowlist',
  guilds,
  historyLimit: d.historyLimit ?? 20,
};
const patterns = oc.messages?.groupChat?.mentionPatterns;
if (Array.isArray(patterns) && patterns.length) discord.mentionPatterns = patterns;

saveUserConfig({ discord });
console.log(`已从 ${source} 导入 Discord 配置到 ${configFile}`);
console.log(`- 令牌：${d.token.length} 字符（未显示）`);
console.log(`- 白名单用户：${discord.allowFrom.length} 个；主人（完整工具权限）：${discord.owners.length} 个`);
console.log(`- 服务器：${Object.keys(guilds).length} 个；私信策略 ${discord.dmPolicy}；群组策略 ${discord.groupPolicy}；历史 ${discord.historyLimit} 条`);
console.log('OpenClaw 自身的配置没有被修改。两边同时用同一个令牌在线会重复回复，请只运行其中一个。');
