// 入站消息门控，对齐 OpenClaw Discord 插件的 preflight 行为：
// 私信/群组白名单、服务器与频道匹配、users/roles 限制、requireMention、提及正则、ignoreOtherMentions。

// OpenClaw 配置里常见 "(?i)xxx"，JS 正则不支持内联标志；去掉它并统一不区分大小写。
export function compileMentionPatterns(patterns = []) {
  return patterns.flatMap(pattern => {
    const source = String(pattern).replace(/^\(\?[a-z]+\)/i, '').trim();
    // 粗略拒绝嵌套量词，避免灾难性回溯。
    if (!source || /\([^)]*[+*][^)]*\)[+*{]/.test(source)) return [];
    try { return [new RegExp(source, 'i')]; } catch { return []; }
  });
}

export function normalizeForMatch(text) {
  return String(text || '').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
}

function listed(list, id) {
  return Array.isArray(list) && list.some(entry => {
    const value = String(entry).replace(/^(discord:|user:)/, '').replace(/^<@!?(\d+)>$/, '$1');
    return value === '*' || value === id;
  });
}

/**
 * @param {object} msg 从 discord.js 消息抽取的纯数据：
 *   { authorId, authorIsBot, isDM, guildId, channelId, parentId, text, mentionsBot, mentionsOthers, replyToBot, roleIds[] }
 * @param {object} cfg config.discord
 * @param {RegExp[]} patterns compileMentionPatterns 的结果
 * @returns {{accept: boolean, reason: string, record?: boolean, tier?: 'owner'|'guest'}}
 *   record=true 表示虽然不回复，但应记入频道历史供下次回复参考。
 */
export function evaluateMessage(msg, cfg, patterns) {
  if (msg.authorIsBot) return { accept: false, reason: 'bot' };
  const tier = listed(cfg.owners, msg.authorId) ? 'owner' : 'guest';
  if (msg.isDM) {
    // 私信没有身份组，访客私信仍按 allowFrom 判断。
    if (cfg.dmPolicy === 'disabled') return { accept: false, reason: 'dm-disabled' };
    if (cfg.dmPolicy !== 'open' && !listed(cfg.allowFrom, msg.authorId) && tier !== 'owner') return { accept: false, reason: 'dm-not-allowed' };
    return { accept: true, reason: 'dm', tier };
  }
  if (cfg.groupPolicy === 'disabled') return { accept: false, reason: 'group-disabled' };
  const guilds = cfg.guilds || {};
  const guild = guilds[msg.guildId] || guilds['*'] || null;
  if (!guild && (cfg.groupPolicy === 'allowlist' || Object.keys(guilds).length)) return { accept: false, reason: 'guild-not-allowed' };
  const channels = guild?.channels;
  let channel = null;
  if (channels && Object.keys(channels).length) {
    channel = channels[msg.channelId] || (msg.parentId && channels[msg.parentId]) || channels['*'] || null;
    if (!channel) return { accept: false, reason: 'channel-not-allowed' };
  }
  if (channel?.enabled === false || guild?.enabled === false) return { accept: false, reason: 'disabled' };
  const users = channel?.users ?? guild?.users ?? [];
  const roles = channel?.roles ?? guild?.roles ?? [];
  const guestRoles = (cfg.guest?.roles || []).map(String);
  // @everyone 身份组的 ID 就是服务器 ID；直接比对，不依赖成员身份组缓存里是否带着它。
  const hasRole = list => list.includes(String(msg.guildId)) || (msg.roleIds || []).some(id => list.includes(id));
  // 主人不受名单限制；拥有访客身份组的成员在名单之外额外放行。
  if (tier !== 'owner' && (users.length || roles.length) && !listed(users, msg.authorId) && !hasRole(roles.map(String)) && !hasRole(guestRoles)) {
    return { accept: false, reason: 'user-not-allowed', record: true };
  }
  const requireMention = channel?.requireMention ?? guild?.requireMention ?? true;
  const text = normalizeForMatch(msg.text);
  const mentioned = msg.mentionsBot || msg.replyToBot || patterns.some(re => re.test(text));
  if (requireMention && !mentioned) return { accept: false, reason: 'no-mention', record: true };
  const ignoreOthers = channel?.ignoreOtherMentions ?? guild?.ignoreOtherMentions ?? false;
  if (ignoreOthers && msg.mentionsOthers && !msg.mentionsBot && !msg.replyToBot) return { accept: false, reason: 'other-mention', record: true };
  return { accept: true, reason: mentioned ? 'mention' : 'open-channel', tier };
}

// 发给模型前去掉对机器人自己的 @，避免模型把 <@123> 当成正文。
export function stripBotMention(text, botId) {
  return String(text || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
}

// 该消息所在的服务器/频道是否在配置范围内（用于人物记忆：只观察已配置的地方）。
export function inConfiguredGuild(msg, cfg) {
  if (msg.isDM || msg.authorIsBot || cfg.groupPolicy === 'disabled') return false;
  const guilds = cfg.guilds || {};
  const guild = guilds[msg.guildId] || guilds['*'];
  if (!guild || guild.enabled === false) return cfg.groupPolicy === 'open' && !Object.keys(guilds).length;
  const channels = guild.channels;
  if (channels && Object.keys(channels).length) {
    const channel = channels[msg.channelId] || (msg.parentId && channels[msg.parentId]) || channels['*'];
    return Boolean(channel) && channel.enabled !== false;
  }
  return true;
}
