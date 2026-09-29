import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  Client, GatewayIntentBits, Partials, Events, ActivityType, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, AttachmentBuilder,
} from 'discord.js';
import { chunkMessage } from './chunk.js';
import { compileMentionPatterns, evaluateMessage, stripBotMention, inConfiguredGuild } from './gating.js';
import { extractReactions, extractStickers, resolveStickers, stripReactionTags } from './reactions.js';
import { ingestImages, looksLikeImage, MAX_IMAGES } from '../images.js';
import { ingestFiles, guessKind, formatSize, uploadPath, MAX_FILES, MAX_GUEST_TEXT_BYTES, MAX_PDF_BYTES } from '../attachments.js';

const TOOL_LABELS = { ToolSearch: '加载工具', mcp__claw__schedule_create: '登记定时任务', mcp__claw__schedule_list: '查看定时任务', mcp__claw__schedule_update: '修改定时任务', mcp__claw__schedule_delete: '删除定时任务', mcp__claw__send_file: '发送文件', Bash: '运行命令', PowerShell: '运行命令', Read: '读取文件', Write: '写入文件', Edit: '修改文件', Glob: '查找文件', Grep: '搜索内容', WebFetch: '读取网页', WebSearch: '上网搜索', Task: '派出帮手', Agent: '派出帮手', TodoWrite: '整理待办' };
const PERMISSION_CHOICES = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions'];
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Bot 能上传的单个文件大小取决于服务器加成等级；私信与未加成服务器是 10MB。
function uploadLimit(channel) {
  const tier = channel?.guild?.premiumTier ?? 0;
  return (tier >= 3 ? 100 : tier === 2 ? 50 : 10) * 1024 * 1024;
}

function speakerLabel(message) {
  const name = message.member?.displayName || message.author.globalName || message.author.username;
  return name === message.author.username ? name : `${name}(${message.author.username})`;
}

function displayName(message) {
  return message.member?.displayName || message.author.globalName || message.author.username;
}

function toolSummary(name, input = {}) {
  const label = TOOL_LABELS[name] || name;
  const detail = input.title || input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || '';
  return detail ? `${label}：${String(detail).replace(/\s+/g, ' ').slice(0, 80)}` : label;
}

function describeInput(input) {
  const text = input?.command || input?.file_path || JSON.stringify(input ?? {}, null, 1);
  return String(text).slice(0, 900);
}

export class DiscordBot extends EventEmitter {
  constructor({ config, sessions, dataDir, log = console.log, models = null, people = null, guestUsage = null }) {
    super();
    this.models = models;
    this.people = people;
    this.guestUsage = guestUsage;
    this.quotaNotified = new Map();
    this.config = config;
    this.sessions = sessions;
    this.dataDir = dataDir;
    this.log = log;
    this.client = null;
    this.state = 'stopped';
    this.error = '';
    this.histories = new Map();
    this.seeded = new Set();
  }

  get cfg() { return this.config.discord; }

  status() {
    return { state: this.state, error: this.error, user: this.client?.user ? { id: this.client.user.id, tag: this.client.user.tag } : null, guilds: this.client?.guilds?.cache?.size ?? 0 };
  }

  setState(state, error = '') {
    this.state = state;
    this.error = error;
    this.emit('status', this.status());
  }

  async start() {
    if (!this.cfg.enabled) return this.setState('disabled');
    if (!this.cfg.token) return this.setState('disabled', '未配置 Discord 令牌（运行 npm run import-openclaw 导入）');
    this.patterns = compileMentionPatterns(this.cfg.mentionPatterns);
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel, Partials.Message],
      allowedMentions: { parse: ['users'], repliedUser: false },
    });
    this.client.once(Events.ClientReady, client => {
      this.log(`[discord] 已登录 ${client.user.tag}，服务器 ${client.guilds.cache.size} 个`);
      client.user.setActivity('今天也是三月七~', { type: ActivityType.Custom });
      this.setState('ready');
      this.deployCommands().catch(error => this.log(`[discord] 斜杠命令注册失败：${error.message}`));
    });
    this.client.on(Events.ShardDisconnect, () => this.setState('reconnecting'));
    this.client.on(Events.ShardResume, () => this.setState('ready'));
    this.client.on(Events.Error, error => this.log(`[discord] ${error.message}`));
    this.client.on(Events.MessageCreate, message => this.onMessage(message).catch(error => this.log(`[discord] 处理消息失败：${error.stack || error.message}`)));
    this.client.on(Events.InteractionCreate, interaction => this.onInteraction(interaction).catch(error => this.log(`[discord] 交互失败：${error.message}`)));
    this.setState('connecting');
    try {
      await this.client.login(this.cfg.token);
    } catch (error) {
      const hint = /disallowed intents/i.test(error.message) ? '：请在 Discord 开发者后台开启 Message Content Intent' : '';
      this.setState('error', `${error.message}${hint}`);
      this.client.destroy();
      this.client = null;
    }
  }

  async stop() {
    await this.client?.destroy();
    this.client = null;
    this.setState('stopped');
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  // ---- 频道历史：自上次回复以来别人说的话，回复后清空（对齐 OpenClaw） ----
  remember(channelId, entry) {
    if (!this.cfg.historyLimit) return;
    const list = this.histories.get(channelId) || [];
    list.push(entry);
    while (list.length > this.cfg.historyLimit) list.shift();
    this.histories.delete(channelId);
    this.histories.set(channelId, list);
    while (this.histories.size > 1000) this.histories.delete(this.histories.keys().next().value);
  }

  // 进程重启后内存历史为空：首次在该频道回复前从 Discord 拉取最近消息补上。
  async seedHistory(message) {
    if (this.seeded.has(message.channelId) || !this.cfg.historyLimit || !message.guildId) return;
    this.seeded.add(message.channelId);
    try {
      const fetched = await message.channel.messages.fetch({ limit: Math.min(this.cfg.historyLimit, 50), before: message.id });
      const rows = [...fetched.values()].reverse();
      // 只保留机器人最后一次发言之后的消息。
      const lastBot = rows.findLastIndex(row => row.author.id === this.client.user.id);
      const existing = this.histories.get(message.channelId) || [];
      const known = new Set(existing.map(entry => entry.id));
      const seeded = rows.slice(lastBot + 1).filter(row => !row.author.bot && row.content && !known.has(row.id))
        .map(row => ({ id: row.id, authorId: row.author.id, label: speakerLabel(row), text: row.content, ts: row.createdAt }));
      this.histories.set(message.channelId, [...seeded, ...existing].slice(-this.cfg.historyLimit));
    } catch { /* 没有读取历史权限时直接跳过 */ }
  }

  historyBlock(channelId) {
    const list = this.histories.get(channelId) || [];
    return list.map(entry => `[${entry.ts.toLocaleString('zh-CN', { hour12: false })}] ${entry.label}: ${entry.text}`).join('\n');
  }

  extract(message) {
    const botId = this.client.user.id;
    const isDM = !message.guildId;
    const mentionsOthers = message.mentions.users.some(user => user.id !== botId) || message.mentions.roles.size > 0;
    return {
      authorId: message.author.id, authorIsBot: message.author.bot || message.author.id === botId, isDM,
      guildId: message.guildId, channelId: message.channelId, parentId: message.channel.isThread?.() ? message.channel.parentId : null,
      text: message.content, mentionsBot: message.mentions.users.has(botId),
      mentionsOthers, replyToBot: message.mentions.repliedUser?.id === botId,
      roleIds: message.member ? [...message.member.roles.cache.keys()] : [],
    };
  }

  sessionFor(message, tier) {
    const isDM = !message.guildId;
    // 同一频道里主人与访客分成两个会话：访客会话没有工具，也不会继承主人会话里的文件内容。
    const key = isDM ? `discord:dm:${message.author.id}` : `discord:channel:${message.channelId}:${tier}`;
    const existing = this.sessions.findByKey(key);
    if (existing) return existing;
    const label = isDM ? `DM · ${displayName(message)}` : `#${message.channel.name || message.channelId}${tier === 'guest' ? ' · 访客' : ''}`;
    return this.sessions.create({
      key, title: label, origin: 'discord', surface: isDM ? 'discord_dm' : 'discord_group', tier,
      userName: isDM ? displayName(message) : '开拓者',
      discord: { channelId: message.channelId, guildId: message.guildId || null, dm: isDM, label },
    });
  }

  async download(attachment, limit = MAX_ATTACHMENT_BYTES) {
    if (attachment.size > limit) throw new Error(`超过 ${formatSize(limit)}`);
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * 处理附件（含被回复消息里的附件）：
   * - 图片以图片内容块、PDF 以文档块直接交给模型，文本类文件解码后内联，所有人都能用；
   * - 主人的附件另存到会话工作目录，其他格式由她用工具处理；访客的其他格式只保留占位符，也不下载。
   */
  async processAttachments(message, meta, referenced = null) {
    const notes = [];
    const imageItems = [];
    const fileItems = [];
    const owner = meta.tier === 'owner';
    const sources = [...message.attachments.values()].map(a => ({ a, fromReply: false }));
    if (referenced) sources.push(...[...referenced.attachments.values()].map(a => ({ a, fromReply: true })));
    const ownerDir = path.join(meta.cwd, '.claw-attachments');
    for (const { a, fromReply } of sources) {
      const label = fromReply ? `被回复消息中的 ${a.name}` : a.name;
      const isImage = looksLikeImage(a.name, a.contentType);
      const kind = isImage ? 'image' : guessKind(a.name, a.contentType);
      if (!owner && kind === 'binary') { notes.push(`<附件:${label}（这类文件没办法直接读取）>`); continue; }
      if (isImage && imageItems.length >= MAX_IMAGES) { notes.push(`<图片 ${label} 超出单条消息上限，未发送>`); continue; }
      if (!isImage && fileItems.length >= MAX_FILES) { notes.push(`<附件 ${label} 超出单条消息上限，未接收>`); continue; }
      // 访客的文本类附件只取前面一部分（超出的也不会内联），PDF 超过内联上限就不下载了。
      const limit = owner ? MAX_ATTACHMENT_BYTES : kind === 'pdf' ? MAX_PDF_BYTES : kind === 'image' ? MAX_ATTACHMENT_BYTES : MAX_GUEST_TEXT_BYTES;
      let buffer;
      try { buffer = await this.download(a, limit); } catch (error) { notes.push(`<附件 ${label} 下载失败：${error.message}>`); continue; }
      if (!isImage) { fileItems.push({ name: a.name, label, buffer }); continue; }
      imageItems.push({ name: label, buffer });
      if (owner) {
        mkdirSync(ownerDir, { recursive: true });
        const file = path.join(ownerDir, `${message.id}-${a.name.replace(/[^\w.\u4e00-\u9fff-]/g, '_')}`);
        writeFileSync(file, buffer);
        notes.push(`<图片已保存：${file}>`);
      }
    }
    for (const sticker of message.stickers?.values?.() || []) notes.push(`<贴纸:${sticker.name}${sticker.description ? `（${sticker.description}）` : ''}>`);
    const { images, notes: imageNotes } = await ingestImages(this.dataDir, meta.id, imageItems);
    const { files, documents, notes: fileNotes } = await ingestFiles(this.dataDir, meta.id, fileItems, { saveDir: owner ? ownerDir : null, prefix: message.id });
    if (referenced && [...images, ...files].some(item => (item.label || item.name).startsWith('被回复消息'))) notes.push('<部分附件来自被回复的那条消息>');
    return { notes: [...notes, ...imageNotes, ...fileNotes].join('\n'), images, files, documents };
  }

  async onMessage(message) {
    if (!this.client?.user || message.author.id === this.client.user.id) return;
    if (message.system) return;
    const facts = this.extract(message);
    // 人物记忆：已配置服务器里所有人的发言都观察（包括不在白名单、不会被回复的人）。
    const observed = [stripBotMention(message.content, this.client.user.id), message.attachments.size ? `[发了 ${message.attachments.size} 个附件]` : ''].filter(Boolean).join(' ');
    if (this.people && inConfiguredGuild(facts, this.cfg) && observed) {
      this.people.observe({ id: message.author.id, username: message.author.username, displayName: displayName(message) }, observed, message.channel.name || '');
    }
    const verdict = evaluateMessage(facts, this.cfg, this.patterns);
    if (!verdict.accept) {
      if (verdict.record && message.content) this.remember(message.channelId, { id: message.id, authorId: message.author.id, label: speakerLabel(message), text: message.content, ts: message.createdAt });
      return;
    }
    if (verdict.tier === 'guest' && !(await this.checkQuota(message.author, displayName(message), text => message.reply({ content: text, allowedMentions: { repliedUser: false } }), message))) return;
    await this.seedHistory(message);
    const meta = this.sessionFor(message, verdict.tier);
    this.sessions.noteDiscordUser(meta.id, message.author.id);
    let replyTo = null;
    let referenced = null;
    if (message.reference?.messageId) {
      try {
        referenced = await message.fetchReference();
        if (!facts.replyToBot) replyTo = { from: speakerLabel(referenced), text: referenced.content.slice(0, 2000) };
      } catch { /* 被引用的消息可能已删除 */ }
    }
    const typingEarly = message.attachments.size || referenced?.attachments?.size ? message.channel.sendTyping().catch(() => {}) : null;
    const { notes, images, files, documents } = await this.processAttachments(message, meta, referenced);
    await typingEarly;
    const text = [stripBotMention(message.content, this.client.user.id), notes].filter(Boolean).join('\n');
    if (!text.trim() && !images.length && !files.length) return;
    const historyEntries = !message.guildId ? [] : this.histories.get(message.channelId) || [];
    const channelHistory = !message.guildId ? '' : this.historyBlock(message.channelId);
    this.histories.delete(message.channelId);
    const via = !message.guildId ? 'discord 私信' : `discord #${message.channel.name || message.channelId}`;
    const extras = this.contextExtras(message.guild, {
      speakerId: message.author.id,
      mentionedIds: [...message.mentions.users.keys()].filter(id => id !== this.client.user.id),
      historyAuthorIds: historyEntries.map(entry => entry.authorId),
      text: [text, replyTo?.text || '', channelHistory].join('\n'),
    });
    await this.runAndReply(message, meta, { text, images, files, documents, from: displayName(message), via, channelHistory, replyTo, ...extras });
  }

  // 访客额度：用完时回一句（每个周期只提示一次，之后只加 ⏳ 反应），返回是否放行。
  async checkQuota(user, name, reply, message = null) {
    if (!this.guestUsage) return true;
    const usage = this.guestUsage.consume(user.id, { name });
    if (usage.allowed) return true;
    const key = `${user.id}:${usage.period}`;
    const notified = this.quotaNotified.get(key);
    const periodKey = new Date().toDateString();
    if (notified !== periodKey) {
      this.quotaNotified.set(key, periodKey);
      const text = usage.limit === 0 ? '呜…主人没有给你开放和本姑娘聊天的次数哦。' : `呜，${usage.periodName}找本姑娘的次数用完啦（${usage.limit} 次）${usage.period === 'total' ? '' : '，下个周期再来吧'}~`;
      await reply(text).catch(() => {});
    } else if (message) await message.react('⏳').catch(() => {});
    return false;
  }

  contextExtras(guild, activation) {
    const extras = { reactions: this.cfg.reactions !== false };
    if (this.people) extras.people = this.people.activate(activation);
    if (guild && extras.reactions) {
      const emojis = [...guild.emojis.cache.values()].filter(e => e.available !== false).slice(0, 30);
      extras.emojis = emojis.map(e => `:${e.name}: → ${e.toString()}`).join('\n');
    }
    // 贴纸只能用当前服务器自己的（bot 没有 Nitro，不能跨服务器用，私信里也没有服务器贴纸）。
    const stickers = this.availableStickers(guild);
    if (stickers.length) extras.stickers = stickers.slice(0, 60).map(s => `${s.name}${s.description ? ` — ${s.description}` : ''}${s.tags ? `（${s.tags}）` : ''}`).join('\n');
    return extras;
  }

  availableStickers(guild) {
    if (!guild || this.cfg.stickers === false) return [];
    return [...(guild.stickers?.cache?.values?.() || [])].filter(s => s.available !== false);
  }

  async runAndReply(message, meta, payload, interaction = null) {
    const channel = message?.channel || interaction.channel;
    const typing = () => channel.sendTyping().catch(() => {});
    typing();
    const typingTimer = setInterval(typing, 8000);
    let preview = null;
    let previewText = '';
    let toolLine = '';
    let lastEdit = 0;
    let editTimer = null;
    const renderPreview = () => {
      const visible = stripReactionTags(previewText);
      const body = visible.length > 1800 ? `…${visible.slice(-1800)}` : visible;
      return [body, toolLine ? `-# 🔧 ${toolLine}` : ''].filter(Boolean).join('\n') || '-# …';
    };
    const flushPreview = async () => {
      editTimer = null;
      lastEdit = Date.now();
      const content = renderPreview();
      try {
        if (!preview) {
          if (stripReactionTags(previewText).length < 30 && !toolLine) return;
          preview = interaction
            ? await interaction.editReply({ content, allowedMentions: { parse: [] } })
            : await message.reply({ content, allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds });
        } else await preview.edit({ content, allowedMentions: { parse: [] } });
      } catch { /* 预览失败不影响最终回复 */ }
    };
    const schedule = () => {
      if (!this.cfg.streamPreview || editTimer) return;
      editTimer = setTimeout(flushPreview, Math.max(0, 1200 - (Date.now() - lastEdit)));
    };
    const hooks = {
      onEvent: event => {
        if (event.type === 'segment' && previewText && !previewText.endsWith('\n\n')) previewText += '\n\n';
        if (event.type === 'text') { previewText += event.text; schedule(); }
        if (event.type === 'tool_use') { toolLine = toolSummary(event.name, event.input); schedule(); }
        if (event.type === 'tool_result') { toolLine = ''; }
      },
      onPermission: (request, resolve) => this.askPermission(channel, meta, request, resolve),
    };
    let result;
    try {
      result = await this.sessions.send(meta.id, payload, hooks);
    } catch (error) {
      result = { ok: false, error: error.code === 'cancelled' ? '已取消' : error.message, entry: { text: previewText }, files: error.files || [] };
    } finally {
      clearInterval(typingTimer);
      clearTimeout(editTimer);
    }
    const extracted = extractReactions((result.entry?.text || result.text || '').trim());
    const stickerTags = extractStickers(extracted.text);
    let finalText = stickerTags.text;
    if (message && this.cfg.reactions !== false) {
      for (const emoji of extracted.reactions) await message.react(emoji).catch(error => this.log(`[discord] 表情反应失败 ${emoji}：${error.message}`));
    }
    const { ids: stickerIds, missing } = resolveStickers(stickerTags.stickers, this.availableStickers(channel?.guild));
    if (missing.length) this.log(`[discord] 找不到贴纸：${missing.join('、')}`);
    const { attachments, skipped } = this.outgoingAttachments(channel, result.files || []);
    if (skipped.length) finalText = `${finalText}\n-# 📎 ${skipped.join('；')}`.trim();
    // 只有表情没有文字：不发消息，删掉预览即可。
    if (result.ok && !finalText && !attachments.length && !stickerIds.length && extracted.reactions.length && !interaction) {
      if (preview) await preview.delete().catch(() => {});
      return;
    }
    if (!result.ok) {
      const reason = result.interrupted ? '（这次被中断了）' : `（出错了：${result.error || '未知错误'}）`;
      finalText = finalText ? `${finalText}\n\n-# ${reason}` : `呜…${reason}`;
    }
    const chunks = chunkMessage(finalText);
    // 只发贴纸时正文可以为空。
    if (!chunks.length) chunks.push(attachments.length ? '📎' : stickerIds.length ? '' : '……');
    const last = chunks.length - 1;
    // 文件和贴纸附在最后一块上；带附件发送失败（比如超过服务器上限）时退回只发文字并说明。
    const withFiles = async (send, content, index, extra = {}) => {
      if (index !== last || !attachments.length) return send({ content, ...extra });
      try { return await send({ content, files: attachments, ...extra }); } catch (error) {
        this.log(`[discord] 发送附件失败：${error.message}`);
        return send({ content: `${content}\n-# 📎 附件发送失败（${error.message.slice(0, 120)}），可以在面板里下载`.slice(0, 2000), ...extra });
      }
    };
    // 贴纸发送失败（被删掉、权限不足）时去掉贴纸重发，不能让正文也丢掉。
    const withExtras = async (send, content, index, extra = {}) => {
      if (index !== last || !stickerIds.length) return withFiles(send, content, index, extra);
      try { return await withFiles(send, content, index, { ...extra, stickers: stickerIds }); } catch (error) {
        this.log(`[discord] 发送贴纸失败：${error.message}`);
        if (!content && !attachments.length) return null;
        return withFiles(send, content, index, extra);
      }
    };
    if (interaction) {
      // 交互回复（webhook）不能带贴纸，贴纸单独发到频道里。
      await withFiles(payload => interaction.editReply(payload), chunks[0] || '👇', 0, { allowedMentions: { parse: ['users'] } }).catch(() => channel?.send(chunks[0] || '……'));
      for (const [index, chunk] of chunks.entries()) if (index > 0) await withFiles(payload => interaction.followUp(payload), chunk, index, { allowedMentions: { parse: ['users'] } }).catch(() => {});
      if (stickerIds.length && channel) await channel.send({ stickers: stickerIds }).catch(error => this.log(`[discord] 发送贴纸失败：${error.message}`));
      return;
    }
    // 单块、不含提及、也没有附件或贴纸时直接把预览改成最终回复；否则删掉预览重新发送（编辑不会触发提及通知，也加不了贴纸）。
    if (preview && chunks.length === 1 && !attachments.length && !stickerIds.length && !/<@[!&]?\d+>/.test(chunks[0])) {
      await preview.edit({ content: chunks[0], allowedMentions: { parse: ['users'] } }).catch(() => {});
      return;
    }
    if (preview) await preview.delete().catch(() => {});
    for (const [index, chunk] of chunks.entries()) {
      if (index === 0) await withExtras(payload => message.reply(payload), chunk, index, { allowedMentions: { parse: ['users'], repliedUser: false } }).catch(() => chunk && channel.send(chunk));
      else await withExtras(payload => channel.send(payload), chunk, index, { allowedMentions: { parse: ['users'] } });
    }
  }

  // 她用 send_file 交付的文件：超过本频道上传上限的跳过并说明（面板里仍可下载），一条消息最多 10 个附件。
  outgoingAttachments(channel, files) {
    const limit = uploadLimit(channel);
    const attachments = [];
    const skipped = [];
    for (const file of files) {
      if (file.size > limit) skipped.push(`「${file.name}」${formatSize(file.size)}，超过这里 ${formatSize(limit)} 的上传上限，可以在面板里下载`);
      else if (attachments.length >= 10) skipped.push(`「${file.name}」超出单条消息 10 个附件的上限`);
      else attachments.push(new AttachmentBuilder(uploadPath(this.dataDir, file.file), { name: file.name }));
    }
    return { attachments, skipped };
  }

  async askPermission(channel, meta, request, resolve) {
    if (meta.tier !== 'owner') return resolve({ behavior: 'deny', message: '访客会话不允许使用工具。', by: 'policy' });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${request.requestId}`).setLabel('允许').setStyle(ButtonStyle.Success),
      ...(request.canAlwaysAllow ? [new ButtonBuilder().setCustomId(`perm:always:${request.requestId}`).setLabel('本会话都允许').setStyle(ButtonStyle.Primary)] : []),
      new ButtonBuilder().setCustomId(`perm:deny:${request.requestId}`).setLabel('拒绝').setStyle(ButtonStyle.Danger),
    );
    const body = [
      `**需要确认：${request.displayName}**${request.description ? ` — ${request.description}` : ''}`,
      '```', describeInput(request.input).replace(/```/g, 'ˋˋˋ'), '```',
      request.reason ? `-# ${request.reason.slice(0, 300)}` : '',
      `-# 只有主人可以点按钮；${Math.round(this.config.agent.approvalTimeoutSec / 60)} 分钟内无人处理会自动拒绝，面板上也可以审批。`,
    ].filter(Boolean).join('\n');
    const prompt = await channel.send({ content: body, components: [row], allowedMentions: { parse: [] } }).catch(() => null);
    if (!prompt) return;
    const onEvent = event => {
      if (event.type !== 'permission_closed' || event.requestId !== request.requestId) return;
      this.sessions.off('event', onEvent);
      const verdict = event.behavior === 'allow' ? '✅ 已允许' : event.by === 'timeout' ? '⌛ 超时，已拒绝' : '❌ 已拒绝';
      prompt.edit({ content: `${body.split('\n-# 只有主人')[0]}\n-# ${verdict}${event.by ? `（${event.by}）` : ''}`, components: [] }).catch(() => {});
    };
    this.sessions.on('event', onEvent);
  }

  async channelFor(meta) {
    if (!this.client?.isReady() || !meta?.discord?.channelId) return null;
    return this.client.channels.fetch(meta.discord.channelId).catch(() => null);
  }

  // 定时任务在 Discord 会话里运行时，权限审批按钮发到该频道。
  hooksFor(meta) {
    if (meta.origin !== 'discord') return {};
    return {
      onPermission: async (request, resolve) => {
        const channel = await this.channelFor(meta);
        if (channel) await this.askPermission(channel, meta, request, resolve);
      },
    };
  }

  async deliverSchedule(meta, job, text, ok, error, files = []) {
    const channel = await this.channelFor(meta);
    if (!channel) throw new Error('Discord 未连接或频道不可用');
    const mention = !meta.discord.dm && job.notifyUserId ? `<@${job.notifyUserId}> ` : '';
    const header = `${mention}-# ⏰ 定时任务「${job.title}」`;
    const { attachments, skipped } = this.outgoingAttachments(channel, files);
    const body = [ok ? text || (attachments.length ? '' : '（完成了，但没有输出）') : `呜…这次没做成：${error || '未知错误'}`, skipped.length ? `-# 📎 ${skipped.join('；')}` : ''].filter(Boolean).join('\n');
    const chunks = chunkMessage(`${header}
${body}`);
    const allowedMentions = { users: job.notifyUserId ? [job.notifyUserId] : [] };
    for (const [index, chunk] of chunks.entries()) {
      if (index < chunks.length - 1 || !attachments.length) { await channel.send({ content: chunk, allowedMentions }); continue; }
      await channel.send({ content: chunk, files: attachments, allowedMentions })
        .catch(sendError => channel.send({ content: `${chunk}\n-# 📎 附件发送失败（${sendError.message.slice(0, 120)}），可以在面板里下载`.slice(0, 2000), allowedMentions }));
    }
  }

  // 面板白名单页用：把用户 ID 解析成 Discord 名字（查不到的标记为未知）。
  async resolveUsers(ids) {
    if (!this.client?.isReady()) return ids.map(id => ({ id, name: null }));
    return Promise.all(ids.map(async id => {
      try {
        const user = await this.client.users.fetch(id);
        return { id, name: user.globalName || user.username, username: user.username, avatar: user.displayAvatarURL({ size: 64 }), bot: user.bot };
      } catch { return { id, name: null }; }
    }));
  }

  guildsInfo() {
    if (!this.client?.isReady()) return [];
    return [...this.client.guilds.cache.values()].map(guild => ({
      id: guild.id, name: guild.name, configured: Boolean(this.cfg.guilds?.[guild.id] || this.cfg.guilds?.['*']),
      everyone: { id: guild.id, name: '@everyone', memberCount: guild.memberCount ?? null },
      roles: [...guild.roles.cache.values()].filter(role => role.id !== guild.id && !role.managed)
        .sort((a, b) => b.position - a.position).map(role => ({ id: role.id, name: role.name, color: role.hexColor })),
    }));
  }

  isOwner(userId) {
    return this.cfg.owners.map(String).includes(userId);
  }

  // ---- 斜杠命令 ----
  commandDefinitions() {
    return [
      new SlashCommandBuilder().setName('ask').setDescription('不用 @ 直接问三月七').addStringOption(o => o.setName('内容').setDescription('想说的话或要做的事').setRequired(true)),
      new SlashCommandBuilder().setName('new').setDescription('开始新的对话（清空本频道的上下文）'),
      new SlashCommandBuilder().setName('stop').setDescription('中断正在进行的任务'),
      new SlashCommandBuilder().setName('status').setDescription('查看本频道会话状态'),
      new SlashCommandBuilder().setName('model').setDescription('切换模型（仅主人），不填则查看可用模型').addStringOption(o => o.setName('模型').setDescription('输入以筛选，例如 opus、sonnet-4-6、1m；填 default 恢复默认').setAutocomplete(true)),
      new SlashCommandBuilder().setName('mode').setDescription('切换权限模式（仅主人）').addStringOption(o => o.setName('模式').setDescription('权限模式').setRequired(true)
        .addChoices(...PERMISSION_CHOICES.map(value => ({ name: value, value })))),
      new SlashCommandBuilder().setName('note').setDescription('设置本频道的作者注释（仅主人，留空清除）').addStringOption(o => o.setName('内容').setDescription('每轮都会注入的提示')),
    ].map(command => command.toJSON());
  }

  async deployCommands() {
    const definitions = this.commandDefinitions();
    const hash = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
    const cacheFile = path.join(this.dataDir, 'discord-commands.json');
    const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
    const key = `global:${this.client.user.id}`;
    if (cache[key] === hash) return;
    await this.client.application.commands.set(definitions);
    cache[key] = hash;
    writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
    this.log(`[discord] 已注册 ${definitions.length} 个斜杠命令`);
  }

  modelChoices(query) {
    const q = String(query || '').toLowerCase();
    const mark = m => m.status === 'verified' ? ' ✓' : m.status === 'model-mismatch' ? ` ≠ 实际为 ${m.actualModel}` : m.status === 'failed' ? ' ✗' : '';
    return (this.models?.state.models || [])
      .filter(m => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
      .slice(0, 25)
      .map(m => ({ name: `${m.label}${mark(m)}`.slice(0, 100), value: m.id }));
  }

  modelListText() {
    const groups = [['menu', '当前账号菜单'], ['alias', '别名'], ['full', '完整模型 ID'], ['legacy', '旧版模型']];
    const models = this.models?.state.models || [];
    const mark = m => m.status === 'verified' ? ' ✓' : m.status === 'model-mismatch' ? ` ≠ 实际为 ${m.actualModel}` : m.status === 'failed' ? ' ✗' : '';
    return groups.map(([group, title]) => {
      const items = models.filter(m => m.group === group);
      return items.length ? `**${title}**\n${items.map(m => `\`${m.id}\`${mark(m)}`).join('、')}` : '';
    }).filter(Boolean).join('\n') + '\n-# ✓ = 已在本账号实测可用；≠ = 请求会被替换成其他模型';
  }

  async onInteraction(interaction) {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'model') return interaction.respond(this.modelChoices(interaction.options.getFocused())).catch(() => {});
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith('perm:')) {
      const [, action, requestId] = interaction.customId.split(':');
      if (!this.isOwner(interaction.user.id)) return interaction.reply({ content: '只有主人可以审批哦。', flags: MessageFlags.Ephemeral });
      const decision = action === 'deny'
        ? { behavior: 'deny', message: '主人在 Discord 上拒绝了这次操作。', by: interaction.user.username }
        : { behavior: 'allow', always: action === 'always', by: interaction.user.username };
      const ok = this.sessions.resolvePermission(requestId, decision);
      return interaction.reply({ content: ok ? '收到！' : '这个请求已经处理过了。', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.isChatInputCommand()) return;
    const isDM = !interaction.guildId;
    // 斜杠命令同样走门控：只把"是否被提及"视为已满足。
    const verdict = evaluateMessage({
      authorId: interaction.user.id, authorIsBot: false, isDM, guildId: interaction.guildId, channelId: interaction.channelId,
      parentId: interaction.channel?.isThread?.() ? interaction.channel.parentId : null, text: '', mentionsBot: true,
      mentionsOthers: false, replyToBot: false, roleIds: interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [],
    }, this.cfg, this.patterns);
    if (!verdict.accept) return interaction.reply({ content: '这里还没有开放给你哦。', flags: MessageFlags.Ephemeral });
    const tier = verdict.tier;
    const key = isDM ? `discord:dm:${interaction.user.id}` : `discord:channel:${interaction.channelId}:${tier}`;
    const pseudo = { channel: interaction.channel, channelId: interaction.channelId, guildId: interaction.guildId, author: interaction.user, member: interaction.member, id: interaction.id };
    const name = interaction.commandName;
    if (name === 'ask') {
      if (!interaction.channel) return interaction.reply({ content: '无法在这里使用。', flags: MessageFlags.Ephemeral });
      const from = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
      if (tier === 'guest' && !(await this.checkQuota(interaction.user, from, text => interaction.reply({ content: text, flags: MessageFlags.Ephemeral })))) return;
      await interaction.deferReply();
      const meta = this.sessionFor(pseudo, tier);
      this.sessions.noteDiscordUser(meta.id, interaction.user.id);
      const via = isDM ? 'discord 私信' : `discord #${interaction.channel.name || interaction.channelId}`;
      const historyEntries = isDM ? [] : this.histories.get(interaction.channelId) || [];
      const channelHistory = isDM ? '' : this.historyBlock(interaction.channelId);
      this.histories.delete(interaction.channelId);
      const text = interaction.options.getString('内容', true);
      if (this.people && !isDM) this.people.observe({ id: interaction.user.id, username: interaction.user.username, displayName: from }, text, interaction.channel.name || '');
      const extras = this.contextExtras(interaction.guild, { speakerId: interaction.user.id, historyAuthorIds: historyEntries.map(entry => entry.authorId), text: [text, channelHistory].join('\n') });
      return this.runAndReply(null, meta, { text, from, via, channelHistory, ...extras }, interaction);
    }
    const meta = this.sessions.findByKey(key);
    if (name === 'new') {
      if (meta) this.sessions.reset(meta.id);
      return interaction.reply({ content: meta ? '好啦，重新开始~ 之前的话咱就当没听过啦！' : '这里还没有对话，直接叫我就好~', flags: MessageFlags.Ephemeral });
    }
    if (name === 'stop') {
      if (meta) this.sessions.interrupt(meta.id);
      return interaction.reply({ content: meta ? '收到，马上停手！' : '现在没有在做的事哦。', flags: MessageFlags.Ephemeral });
    }
    if (name === 'status') {
      if (tier === 'guest' && this.guestUsage) {
        const usage = this.guestUsage.status(interaction.user.id);
        const policy = this.cfg.guest;
        return interaction.reply({ content: `你是访客：${usage.periodName}已用 ${usage.used}/${usage.limit} 次 · 模型 \`${policy.model || '默认'}\` · ${policy.webSearch ? '可以上网搜索' : '只能聊天'}`, flags: MessageFlags.Ephemeral });
      }
      if (!meta) return interaction.reply({ content: '这里还没有会话。', flags: MessageFlags.Ephemeral });
      const s = this.sessions.summary(meta);
      const lines = [
        `**${s.title}**`, `权限：${s.tier === 'owner' ? '主人（可用工具）' : '访客（仅聊天）'} · 模式 \`${s.permissionMode}\``,
        `模型：\`${s.model || '默认'}\`${s.effort ? ` · effort \`${s.effort}\`` : ''}`, `工作目录：\`${s.cwd}\``,
        `轮数 ${s.stats.turns} · 累计 $${s.stats.costUsd.toFixed(4)} · ${s.busy ? '正在忙' : '空闲'}${s.queued ? `，排队 ${s.queued}` : ''}`,
      ];
      return interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
    }
    if (!this.isOwner(interaction.user.id)) return interaction.reply({ content: '这个命令只有主人能用哦。', flags: MessageFlags.Ephemeral });
    const target = meta || this.sessionFor(pseudo, tier);
    try {
      if (name === 'model') {
        const value = interaction.options.getString('模型');
        if (!value) return interaction.reply({ content: `当前模型：\`${target.model || '默认'}\`\n${this.modelListText()}`.slice(0, 2000), flags: MessageFlags.Ephemeral });
        this.sessions.update(target.id, { model: value === 'default' ? '' : value });
        const known = this.models?.find(value);
        return interaction.reply({ content: `换成 \`${value}\` 啦！${known ? '' : '（这个 ID 不在已知列表里，如果用不了会在下一轮报错）'}`, flags: MessageFlags.Ephemeral });
      }
      if (name === 'mode') this.sessions.update(target.id, { permissionMode: interaction.options.getString('模式', true) });
      if (name === 'note') this.sessions.update(target.id, { authorNote: interaction.options.getString('内容') || '' });
      return interaction.reply({ content: '设置好啦！', flags: MessageFlags.Ephemeral });
    } catch (error) {
      return interaction.reply({ content: `设置失败：${error.message}`, flags: MessageFlags.Ephemeral });
    }
  }
}
