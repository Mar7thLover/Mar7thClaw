import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assemblePrompt } from './persona/assembler.js';
import { runTurn as defaultRunTurn, RunnerError } from './claude/runner.js';
import { fileRecord, stageOutgoing, MAX_OUTGOING_FILES } from './attachments.js';

const PERMISSION_MODES = ['auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'manual'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async acquire() {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise(resolve => this.waiters.push(resolve));
    this.active++;
  }
  release() { this.active--; this.waiters.shift()?.(); }
}

function nowText(date = new Date()) {
  return date.toLocaleString('zh-CN', { hour12: false });
}

function pickGreeting(card, random = Math.random) {
  const options = [card.data.first_mes, ...card.data.alternate_greetings].filter(text => text.trim());
  return options.length ? options[Math.floor(random() * options.length)] : '';
}

export class SessionManager extends EventEmitter {
  constructor({ config, cards, dataDir, runTurn = defaultRunTurn, models = null, mcp = null, people = null }) {
    super();
    this.models = models;
    this.people = people;
    // mcp: { url, token, script }，为主人会话提供 Claw 自己的 MCP 工具（定时任务）。
    this.mcp = mcp;
    this.config = config;
    this.cards = cards;
    this.dataDir = dataDir;
    this.dir = path.join(dataDir, 'sessions');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.runTurn = runTurn;
    this.sessions = new Map();
    this.queues = new Map();
    this.running = new Map();
    this.permissions = new Map();
    // 本轮她用 send_file 交付的文件，回复结束时随回复一起发出。
    this.outbox = new Map();
    this.semaphore = new Semaphore(config.agent.maxConcurrent);
    mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const meta = JSON.parse(readFileSync(path.join(this.dir, file), 'utf8'));
        this.sessions.set(meta.id, meta);
      } catch { /* 跳过损坏的会话文件 */ }
    }
  }

  emitEvent(sessionId, event) {
    this.emit('event', { sessionId, ...event });
  }

  save(meta) {
    meta.updatedAt = new Date().toISOString();
    const file = path.join(this.dir, `${meta.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2), 'utf8');
    renameSync(`${file}.tmp`, file);
    this.emitEvent(meta.id, { type: 'session', session: this.summary(meta) });
  }

  append(id, entry) {
    const record = { ts: new Date().toISOString(), ...entry };
    appendFileSync(path.join(this.dir, `${id}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
    this.emitEvent(id, { type: 'entry', entry: record });
    return record;
  }

  summary(meta) {
    return {
      id: meta.id, title: meta.title, card: meta.card, origin: meta.origin, surface: meta.surface, tier: meta.tier,
      cwd: meta.cwd, model: meta.model, effort: meta.effort, permissionMode: meta.permissionMode, authorNote: meta.authorNote,
      userName: meta.userName, discord: meta.discord || null, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      stats: meta.stats, busy: this.running.has(meta.id), queued: this.queues.get(meta.id)?.length || 0,
    };
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(meta => this.summary(meta));
  }

  get(id) {
    const meta = this.sessions.get(id);
    if (!meta) throw Object.assign(new Error('会话不存在'), { status: 404 });
    return meta;
  }

  findByKey(key) {
    return [...this.sessions.values()].find(meta => meta.key === key) || null;
  }

  transcript(id, limit = 200) {
    this.get(id);
    const file = path.join(this.dir, `${id}.jsonl`);
    if (!existsSync(file)) return [];
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit);
  }

  create(options = {}) {
    const cardId = options.card || this.config.card;
    const card = this.cards.get(cardId);
    const meta = {
      id: randomUUID(),
      key: options.key || null,
      title: options.title || '新的委托',
      card: cardId,
      origin: options.origin || 'panel',
      surface: options.surface || 'panel',
      tier: options.tier === 'guest' ? 'guest' : 'owner',
      userName: options.userName || this.config.user.name,
      cwd: path.resolve(options.cwd || this.config.agent.cwd),
      model: options.model ?? this.config.agent.model,
      effort: options.effort ?? this.config.agent.effort,
      permissionMode: options.permissionMode || this.config.agent.permissionMode,
      authorNote: options.authorNote || '',
      discord: options.discord || null,
      claudeSessionId: randomUUID(),
      started: false,
      pendingGreeting: '',
      createdAt: new Date().toISOString(),
      stats: { turns: 0, costUsd: 0 },
    };
    this.validate(meta);
    this.sessions.set(meta.id, meta);
    const greeting = pickGreeting(card);
    if (greeting) {
      meta.pendingGreeting = greeting;
      this.save(meta);
      this.append(meta.id, { kind: 'assistant', text: this.expandGreeting(meta, card, greeting), greeting: true });
    } else this.save(meta);
    return meta;
  }

  expandGreeting(meta, card, greeting) {
    return greeting.replaceAll('{{char}}', card.data.name).replaceAll('{{user}}', meta.userName).replaceAll('<USER>', meta.userName).replaceAll('<BOT>', card.data.name);
  }

  validate(meta) {
    if (!PERMISSION_MODES.includes(meta.permissionMode)) throw Object.assign(new Error(`permissionMode 只能是 ${PERMISSION_MODES.join(' / ')}`), { status: 400 });
    if (!EFFORTS.includes(meta.effort || '')) throw Object.assign(new Error('effort 只能是 low / medium / high / xhigh / max 或留空'), { status: 400 });
    if (meta.model && !/^[\w.[\]-]{1,80}$/.test(meta.model)) throw Object.assign(new Error('模型名不合法'), { status: 400 });
  }

  update(id, patch) {
    const meta = this.get(id);
    const allowed = ['title', 'model', 'effort', 'permissionMode', 'authorNote', 'userName'];
    const next = { ...meta };
    for (const key of allowed) if (patch[key] !== undefined) next[key] = typeof patch[key] === 'string' ? patch[key] : next[key];
    // 访客会话不能提升权限模式。
    if (meta.tier === 'guest') next.permissionMode = meta.permissionMode;
    // 换模型后，新模型不支持原来的强度档位时回到默认，避免 CLI 报错。
    const model = this.models?.find(next.model || 'default');
    if (model && next.effort && !model.effortLevels.includes(next.effort)) {
      if (patch.effort) throw Object.assign(new Error(`${next.model || '默认模型'} 支持的强度：${model.effortLevels.join(' / ') || '不支持调整'}`), { status: 400 });
      next.effort = '';
    }
    this.validate(next);
    Object.assign(meta, next);
    this.save(meta);
    return meta;
  }

  // Discord 会话记住最后一位发言者，定时任务推送结果时 @ 这个人。
  noteDiscordUser(id, userId) {
    const meta = this.get(id);
    if (!meta.discord || meta.discord.lastUserId === userId) return;
    meta.discord.lastUserId = userId;
    this.save(meta);
  }

  mcpServersFor(meta) {
    if (!this.mcp || meta.tier !== 'owner') return null;
    return {
      claw: {
        type: 'stdio', command: process.execPath, args: [this.mcp.script],
        env: { CLAW_URL: this.mcp.url, CLAW_TOKEN: this.mcp.token, CLAW_SESSION_ID: meta.id },
      },
    };
  }

  remove(id) {
    this.get(id);
    this.interrupt(id);
    this.sessions.delete(id);
    rmSync(path.join(this.dir, `${id}.json`), { force: true });
    rmSync(path.join(this.dir, `${id}.jsonl`), { force: true });
    rmSync(path.join(this.dataDir, 'uploads', id), { recursive: true, force: true });
    this.emitEvent(id, { type: 'session_removed' });
  }

  // 开新的 Claude Code 会话但保留同一个 Claw 会话（Discord 频道 /new 就用这个）。
  reset(id) {
    const meta = this.get(id);
    this.interrupt(id);
    const card = this.cards.get(meta.card);
    meta.claudeSessionId = randomUUID();
    meta.started = false;
    meta.pendingGreeting = pickGreeting(card);
    this.save(meta);
    this.append(id, { kind: 'divider', text: '— 新的对话 —' });
    if (meta.pendingGreeting) this.append(id, { kind: 'assistant', text: this.expandGreeting(meta, card, meta.pendingGreeting), greeting: true });
    return meta;
  }

  recentTexts(id, count) {
    return this.transcript(id, count * 2).filter(row => row.kind === 'user' || row.kind === 'assistant').slice(-count).map(row => row.text || '');
  }

  // 访客会话的模型、强度与工具以 Discord 访客策略为准，而不是会话自己的设置。
  runtimeFor(meta) {
    if (meta.tier !== 'guest') return { model: meta.model, effort: meta.effort, permissionMode: meta.permissionMode, guestTools: [] };
    const policy = this.config.discord.guest;
    const model = policy.model || '';
    const levels = this.models?.find(model || 'default')?.effortLevels;
    const effort = policy.effort && (!levels || levels.includes(policy.effort)) ? policy.effort : '';
    return { model, effort, permissionMode: 'dontAsk', guestTools: policy.webSearch ? ['WebSearch'] : [] };
  }

  buildPrompt(meta, message) {
    const card = this.cards.get(meta.card);
    const scan = Math.max(1, this.config.prompt.worldInfoScanDepth);
    return assemblePrompt({
      card, prompt: this.config.prompt, userName: meta.userName, persona: meta.origin === 'panel' ? this.config.user.persona : '',
      surface: meta.surface, tier: meta.tier, authorNote: meta.authorNote, recent: this.recentTexts(meta.id, scan),
      message: { from: message.from || meta.userName, text: message.text, via: message.via || meta.surface, time: nowText(), images: message.images?.length || 0, files: message.files || [] },
      channelHistory: message.channelHistory || '', replyTo: message.replyTo || null,
      // 面板里的主人会话也能按名字想起群里的人。
      people: message.people ?? (this.people && meta.origin === 'panel' && meta.tier === 'owner' ? this.people.activate({ text: message.text }) : ''),
      emojis: message.emojis || '', reactions: Boolean(message.reactions), stickers: message.stickers || '',
      guestWebSearch: this.runtimeFor(meta).guestTools.includes('WebSearch'),
      greeting: meta.started ? '' : meta.pendingGreeting ? this.expandGreeting(meta, card, meta.pendingGreeting) : '',
    });
  }

  preview(id, text = '（预览用的示例消息）') {
    const meta = this.get(id);
    return this.buildPrompt(meta, { text });
  }

  /**
   * 把一条消息放进会话队列。返回的 Promise 在本轮结束时 resolve。
   * hooks.onEvent 只接收本轮事件（Discord 用它做流式预览和审批按钮）。
   */
  send(id, message, hooks = {}) {
    const meta = this.get(id);
    if (!message?.text?.trim() && !message?.images?.length && !message?.files?.length) throw Object.assign(new Error('消息不能为空'), { status: 400 });
    if (!message.text?.trim()) {
      const parts = [message.images?.length ? `${message.images.length} 张图片` : '', message.files?.length ? `${message.files.length} 个文件` : ''].filter(Boolean);
      message.text = `（发来了 ${parts.join('和')}）`;
    }
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(id) || [];
      queue.push({ message, hooks, resolve, reject });
      this.queues.set(id, queue);
      this.emitEvent(id, { type: 'session', session: this.summary(meta) });
      if (!this.running.has(id)) this.drain(id);
    });
  }

  async drain(id) {
    const queue = this.queues.get(id);
    if (!queue?.length || this.running.has(id)) return;
    const job = queue.shift();
    const controller = new AbortController();
    this.running.set(id, controller);
    this.emitEvent(id, { type: 'session', session: this.summary(this.get(id)) });
    try {
      job.resolve(await this.execute(id, job.message, job.hooks, controller.signal));
    } catch (error) {
      job.reject(error);
    } finally {
      this.running.delete(id);
      if (this.sessions.has(id)) {
        this.emitEvent(id, { type: 'session', session: this.summary(this.get(id)) });
        this.drain(id);
      }
    }
  }

  async execute(id, message, hooks, signal) {
    let meta = this.get(id);
    const turnId = randomUUID();
    const images = (message.images || []).map(image => ({ file: image.file, mediaType: image.mediaType, width: image.width, height: image.height }));
    const files = (message.files || []).map(fileRecord);
    this.append(id, { kind: 'user', turnId, from: message.from || meta.userName, via: message.via || meta.surface, text: message.text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) });
    if (meta.stats.turns === 0 && meta.title === '新的委托') {
      meta.title = message.text.replace(/\s+/g, ' ').trim().slice(0, 24) || meta.title;
      this.save(meta);
    }
    await this.semaphore.acquire();
    const emit = event => {
      this.emitEvent(id, { turnId, ...event });
      try { hooks.onEvent?.(event); } catch { /* 前端回调异常不影响生成 */ }
    };
    const tools = new Map();
    let text = '';
    let thinking = '';
    const onEvent = event => {
      if (event.type === 'segment' && text && !text.endsWith('\n\n')) { text += '\n\n'; }
      if (event.type === 'text') text += event.text;
      if (event.type === 'thinking') thinking += event.text;
      if (event.type === 'tool_use') tools.set(event.id, { id: event.id, name: event.name, input: event.input });
      if (event.type === 'tool_result' && tools.has(event.id)) Object.assign(tools.get(event.id), { result: event.text.slice(0, 1500), isError: event.isError });
      if (event.type === 'init' && !meta.started) { meta.started = true; meta.pendingGreeting = ''; this.save(meta); }
      if (event.type === 'model_fallback') this.append(id, { kind: 'notice', text: `${event.from || '所选模型'} 的安全防护拦下了这次回复${event.category ? `（${event.category}）` : ''}，Claude Code 已自动换用 ${event.to || '其他模型'} 重试。` });
      emit(event);
    };
    this.outbox.set(id, []);
    emit({ type: 'turn_start' });
    try {
      let result;
      for (let attempt = 0; attempt < 2; attempt++) {
        meta = this.get(id);
        const prompt = this.buildPrompt(meta, message);
        emit({ type: 'prompt_info', activated: prompt.activated });
        const runtime = this.runtimeFor(meta);
        try {
          result = await this.runTurn({
            claudeSessionId: meta.claudeSessionId, resume: meta.started, cwd: meta.cwd, system: prompt.system, prompt: prompt.turn,
            model: runtime.model, effort: runtime.effort, permissionMode: runtime.permissionMode, tier: meta.tier, guestTools: runtime.guestTools,
            images: (message.images || []).map(image => ({ mediaType: image.mediaType, data: image.data })),
            documents: message.documents || [],
            disallowedTools: this.config.agent.disallowedTools, name: `Mar7thClaw · ${meta.title}`, mcpServers: this.mcpServersFor(meta),
          }, {
            claudeBin: this.config.claudeBin, tmpDir: this.tmpDir, signal, onEvent,
            canUseTool: (request, requestSignal) => this.requestPermission(id, request, requestSignal, hooks),
          });
          break;
        } catch (error) {
          // Claude Code 的会话文件丢失时（手动清理、换机器）开新会话继续，而不是让整个频道卡死。
          if (attempt === 0 && error instanceof RunnerError && ['resume_failed', 'session_in_use'].includes(error.code)) {
            meta.claudeSessionId = randomUUID();
            meta.started = false;
            this.save(meta);
            this.append(id, { kind: 'notice', text: '原有的 Claude Code 会话无法续接，已自动开启新会话。' });
            continue;
          }
          throw error;
        }
      }
      meta = this.get(id);
      meta.stats.turns += 1;
      if (typeof result.costUsd === 'number') meta.stats.costUsd = Number((meta.stats.costUsd + result.costUsd).toFixed(6));
      this.save(meta);
      const finalText = text.trim() || result.text;
      const outgoing = this.takeOutbox(id);
      const entry = this.append(id, {
        kind: 'assistant', turnId, text: finalText, finalText: result.text, thinking: thinking.slice(0, 20000),
        tools: [...tools.values()], ok: result.ok, interrupted: result.interrupted === true, error: result.error || '',
        costUsd: result.costUsd ?? null, durationMs: result.durationMs ?? null, ...(outgoing.length ? { files: outgoing } : {}),
      });
      emit({ type: 'turn_end', ok: result.ok, interrupted: result.interrupted === true, error: result.error || '' });
      return { ...result, entry, files: outgoing };
    } catch (error) {
      const outgoing = this.takeOutbox(id);
      this.append(id, { kind: 'assistant', turnId, text: text.trim(), tools: [...tools.values()], ok: false, error: error.message, ...(outgoing.length ? { files: outgoing } : {}) });
      emit({ type: 'turn_end', ok: false, error: error.message });
      error.files = outgoing;
      throw error;
    } finally {
      this.outbox.delete(id);
      this.semaphore.release();
    }
  }

  takeOutbox(id) {
    const files = this.outbox.get(id) || [];
    this.outbox.delete(id);
    return files;
  }

  /**
   * 她通过 claw 的 send_file 工具交付文件：只能在本轮进行中调用，文件随本轮回复一起发出。
   * blocked 由核心传入（Claw 数据目录、Claude 凭据等不能外发的位置）。
   */
  addOutgoingFile(id, filePath, name, blocked = []) {
    const meta = this.get(id);
    const list = this.outbox.get(id);
    if (!list) throw Object.assign(new Error('当前没有进行中的回复，文件无法附上'), { status: 409 });
    if (list.length >= MAX_OUTGOING_FILES) throw Object.assign(new Error(`一次回复最多附 ${MAX_OUTGOING_FILES} 个文件`), { status: 400 });
    const file = stageOutgoing(this.dataDir, id, meta.cwd, filePath, name, blocked);
    list.push(file);
    this.emitEvent(id, { type: 'file_out', file });
    return file;
  }

  interrupt(id) {
    this.running.get(id)?.abort();
    const queue = this.queues.get(id) || [];
    this.queues.set(id, []);
    for (const job of queue) job.reject(Object.assign(new Error('已取消'), { code: 'cancelled' }));
  }

  // ---- 权限审批：面板与 Discord 谁先回答都行，超时自动拒绝 ----
  requestPermission(sessionId, request, signal, hooks) {
    return new Promise(resolve => {
      const timeoutMs = this.config.agent.approvalTimeoutSec * 1000;
      const pending = { sessionId, request, resolve: null, timer: null, createdAt: Date.now(), expiresAt: Date.now() + timeoutMs };
      const finish = decision => {
        if (!this.permissions.has(request.requestId)) return;
        this.permissions.delete(request.requestId);
        clearTimeout(pending.timer);
        this.emitEvent(sessionId, { type: 'permission_closed', requestId: request.requestId, behavior: decision.behavior, by: decision.by || '' });
        resolve(decision);
      };
      pending.resolve = finish;
      pending.timer = setTimeout(() => finish({ behavior: 'deny', message: '审批超时，操作未执行。', by: 'timeout' }), timeoutMs);
      signal.addEventListener('abort', () => finish({ behavior: 'deny', message: '本轮已被中断。', by: 'interrupt' }), { once: true });
      this.permissions.set(request.requestId, pending);
      this.emitEvent(sessionId, { type: 'permission_open', request, expiresAt: pending.expiresAt });
      try { hooks.onPermission?.(request, decision => finish(decision)); } catch { /* 回调异常时仍可在面板审批 */ }
    });
  }

  resolvePermission(requestId, decision) {
    const pending = this.permissions.get(requestId);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
  }

  pendingPermissions() {
    return [...this.permissions.values()].map(p => ({ sessionId: p.sessionId, request: p.request, expiresAt: p.expiresAt }));
  }
}
