import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const dataDir = path.join(root, 'data');
export const configFile = path.join(dataDir, 'config.json');

// 仅 data/config.json 中出现的字段覆盖默认值；该文件含令牌，不要提交。
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 18790,
  claudeBin: '',
  card: 'march7th',
  user: {
    name: '开拓者',
    persona: '',
  },
  agent: {
    model: '',
    effort: '',
    permissionMode: 'auto',
    cwd: path.join(root, 'workspace'),
    maxConcurrent: 3,
    approvalTimeoutSec: 600,
    disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
  },
  desktop: {
    // 回复完成、定时任务完成、需要审批时是否弹 Windows 系统通知（面板内提示不受影响）。
    notifications: true,
  },
  prompt: {
    mainPrompt: '',
    authorNote: '',
    authorNoteDepth: 0,
    worldInfoScanDepth: 4,
    worldInfoBudgetChars: 6000,
    worldInfoRecursion: true,
  },
  discord: {
    enabled: true,
    token: '',
    owners: [],
    allowFrom: [],
    dmPolicy: 'allowlist',
    groupPolicy: 'allowlist',
    guilds: {},
    mentionPatterns: ['(?i)March7thClaw', '(?:三月七|小三月)'],
    historyLimit: 20,
    streamPreview: true,
    // 允许她在回复里用 [[react:😀]] 给触发消息加表情反应。
    reactions: true,
    // 允许她用 [[sticker:名字]] 发当前服务器的贴纸。
    stickers: true,
    guest: {
      model: 'sonnet',
      effort: '',
      // 访客唯一可以开放的工具；其余工具（尤其能访问内网的 WebFetch）一律不给。
      webSearch: true,
      quota: { limit: 20, period: 'day' },
      // 每位用户单独的上限：{ "<用户 ID>": 次数 }，0 表示禁止。
      userLimits: {},
      // 拥有这些身份组的成员可以以访客身份使用（在服务器的 users/roles 白名单之外追加）。
      roles: [],
    },
    peopleMemory: {
      enabled: true,
      // haiku 整理档案时容易把专有名词写错（实测把「星铁」写成不存在的名字），默认用 sonnet。
      model: 'sonnet',
      digestEvery: 12,
      maxNotes: 8,
      maxPeoplePerTurn: 6,
    },
  },
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function merge(base, patch) {
  if (!isObject(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(out[key]) ? merge(out[key], value) : structuredClone(value);
  }
  return out;
}

export function findClaude(configured) {
  if (configured) return configured;
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const native = path.join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(native) ? native : 'claude';
}

export function readUserConfig(file = configFile) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function loadConfig(file = configFile) {
  const config = merge(DEFAULTS, readUserConfig(file));
  if (process.env.CLAW_PORT) config.port = Number(process.env.CLAW_PORT);
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('port 必须是 1-65535 的整数');
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('面板只允许监听本机回环地址');
  config.claudeBin = findClaude(config.claudeBin);
  // owners 未单独配置时沿用 OpenClaw 的 allowFrom：这些人拥有完整工具权限。
  if (!config.discord.owners.length) config.discord.owners = [...config.discord.allowFrom];
  return config;
}

// 只写入调用方给出的补丁，保留用户文件中其余字段。
export function saveUserConfig(patch, file = configFile) {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = merge(readUserConfig(file), patch);
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(temp, file);
  return next;
}

// 整体替换某个键（不与旧值深合并），用于可以删除条目的映射，例如访客单独上限。
export function replaceUserConfigValue(keys, value, file = configFile) {
  mkdirSync(path.dirname(file), { recursive: true });
  const next = readUserConfig(file);
  let node = next;
  for (const key of keys.slice(0, -1)) node = node[key] = isObject(node[key]) ? node[key] : {};
  node[keys.at(-1)] = structuredClone(value);
  writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf8');
  renameSync(`${file}.tmp`, file);
}

export function publicConfig(config) {
  const copy = structuredClone(config);
  copy.discord.token = config.discord.token ? `已配置（${config.discord.token.length} 字符）` : '';
  return copy;
}
