import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseCron, nextCronRun, describeCron } from './cron.js';

const MAX_TIMER_MS = 60 * 1000;
const CATCH_UP_MS = 12 * 3600 * 1000;
const MIN_INTERVAL_MINUTES = 5;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function localTime(date) {
  return new Date(date).toLocaleString('zh-CN', { hour12: false });
}

// "2026-09-28 09:00"、"2026-09-28T09:00" 与带时区的 ISO 都按本机时区理解。
export function parseLocalDateTime(text) {
  const value = String(text || '').trim();
  const local = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  const date = local ? new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +(local[6] || 0)) : new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, `无法识别的时间：${value}（请用 2026-09-28 09:00 这样的格式）`);
  return date;
}

export function normalizeSchedule(input) {
  const kinds = ['cron', 'at', 'everyMinutes'].filter(key => input?.[key] !== undefined && input[key] !== '' && input[key] !== null);
  if (kinds.length !== 1) throw httpError(400, '时间规则只能三选一：cron（重复）、at（一次性）或 everyMinutes（固定间隔）');
  if (kinds[0] === 'cron') {
    try { parseCron(input.cron); } catch (error) { throw httpError(400, error.message); }
    if (!nextCronRun(input.cron)) throw httpError(400, '这个 cron 表达式两年内都不会触发');
    return { type: 'cron', cron: String(input.cron).trim() };
  }
  if (kinds[0] === 'at') return { type: 'once', at: parseLocalDateTime(input.at).toISOString() };
  const minutes = Number(input.everyMinutes);
  if (!Number.isSafeInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > 60 * 24 * 31) throw httpError(400, `间隔需要是 ${MIN_INTERVAL_MINUTES} 分钟到 31 天之间的整数分钟`);
  return { type: 'interval', everyMinutes: minutes };
}

export function describeSchedule(schedule) {
  if (schedule.type === 'cron') return describeCron(schedule.cron);
  if (schedule.type === 'once') return `一次性 · ${localTime(schedule.at)}`;
  return `每 ${schedule.everyMinutes} 分钟`;
}

export function computeNextRun(schedule, from = new Date(), lastRunAt = null) {
  if (schedule.type === 'cron') return nextCronRun(schedule.cron, from)?.toISOString() || null;
  if (schedule.type === 'once') return lastRunAt ? null : schedule.at;
  const base = lastRunAt ? new Date(lastRunAt).getTime() : from.getTime();
  return new Date(Math.max(base + schedule.everyMinutes * 60000, from.getTime() + 1000)).toISOString();
}

/**
 * 定时任务：到点后向目标会话发送一轮消息，再把结果推送到面板或 Discord。
 * Claude Code 自带的 Cron 工具只在常驻的交互会话里生效，Claw 每轮都会退出进程，所以调度放在核心里。
 */
export class Scheduler extends EventEmitter {
  constructor({ sessions, dataDir, deliver = async () => {}, hooksFor = () => ({}), log = () => {}, now = () => new Date() }) {
    super();
    this.sessions = sessions;
    this.file = path.join(dataDir, 'schedules.json');
    this.deliver = deliver;
    this.hooksFor = hooksFor;
    this.log = log;
    this.now = now;
    this.jobs = [];
    this.running = new Set();
    this.timer = null;
    if (existsSync(this.file)) {
      try { this.jobs = JSON.parse(readFileSync(this.file, 'utf8')); } catch (error) { log(`[schedule] 读取 ${this.file} 失败：${error.message}`); }
    }
  }

  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.jobs, null, 2), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
    this.emit('change', this.list());
  }

  view(job) {
    return { ...job, description: describeSchedule(job.schedule), running: this.running.has(job.id) };
  }

  list() {
    return this.jobs.map(job => this.view(job)).sort((a, b) => (a.nextRunAt || '9').localeCompare(b.nextRunAt || '9'));
  }

  get(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job) throw httpError(404, '定时任务不存在');
    return job;
  }

  validateTarget(sessionId) {
    if (!sessionId) return null;
    const meta = this.sessions.get(sessionId);
    if (meta.tier !== 'owner') throw httpError(403, '只有主人的会话可以挂定时任务');
    return meta;
  }

  create(input, { createdBy = 'panel' } = {}) {
    const title = String(input.title || '').trim().slice(0, 60);
    const prompt = String(input.prompt || '').trim();
    if (!title) throw httpError(400, '需要一个标题');
    if (!prompt) throw httpError(400, '需要写明到点要做什么（prompt）');
    if (prompt.length > 4000) throw httpError(400, '任务内容太长了（最多 4000 字）');
    const schedule = normalizeSchedule(input);
    const target = this.validateTarget(input.sessionId);
    if (schedule.type === 'once' && new Date(schedule.at) <= this.now()) throw httpError(400, '这个时间已经过去了');
    const job = {
      id: randomUUID().slice(0, 8),
      title, prompt, schedule, enabled: input.enabled !== false,
      sessionId: target?.id || null,
      notifyUserId: input.notifyUserId || null,
      createdBy, createdAt: this.now().toISOString(),
      lastRunAt: null, lastResult: null, runs: 0,
    };
    job.nextRunAt = job.enabled ? computeNextRun(schedule, this.now()) : null;
    this.jobs.push(job);
    this.save();
    this.arm();
    this.log(`[schedule] 新建「${title}」：${describeSchedule(schedule)}，下次 ${job.nextRunAt ? localTime(job.nextRunAt) : '—'}`);
    return this.view(job);
  }

  update(id, patch) {
    const job = this.get(id);
    if (patch.title !== undefined) job.title = String(patch.title).trim().slice(0, 60) || job.title;
    if (patch.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt || prompt.length > 4000) throw httpError(400, '任务内容不能为空，最多 4000 字');
      job.prompt = prompt;
    }
    if (['cron', 'at', 'everyMinutes'].some(key => patch[key] !== undefined)) job.schedule = normalizeSchedule(patch);
    if (patch.sessionId !== undefined) job.sessionId = this.validateTarget(patch.sessionId)?.id || null;
    if (patch.enabled !== undefined) job.enabled = patch.enabled === true;
    job.nextRunAt = job.enabled ? computeNextRun(job.schedule, this.now(), job.schedule.type === 'once' ? null : job.lastRunAt) : null;
    if (job.enabled && job.schedule.type === 'once' && new Date(job.schedule.at) <= this.now()) throw httpError(400, '这个时间已经过去了');
    this.save();
    this.arm();
    return this.view(job);
  }

  remove(id) {
    this.get(id);
    this.jobs = this.jobs.filter(job => job.id !== id);
    this.save();
    this.arm();
  }

  // 启动时处理关机期间错过的任务：12 小时内的补跑一次，更早的跳过。
  start() {
    const now = this.now();
    for (const job of this.jobs) {
      if (!job.enabled || !job.nextRunAt) continue;
      const due = new Date(job.nextRunAt);
      if (due > now) continue;
      if (now - due <= CATCH_UP_MS) { job.catchUp = true; continue; }
      job.lastResult = { ok: false, at: now.toISOString(), text: `错过了 ${localTime(due)} 的运行（Claw 当时没有运行），已跳过` };
      job.nextRunAt = computeNextRun(job.schedule, now, job.schedule.type === 'once' ? due.toISOString() : null);
      if (!job.nextRunAt) job.enabled = false;
    }
    this.save();
    this.arm();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  arm() {
    clearTimeout(this.timer);
    const pending = this.jobs.filter(job => job.enabled && job.nextRunAt && !this.running.has(job.id));
    if (!pending.length) return;
    const soonest = Math.min(...pending.map(job => new Date(job.nextRunAt).getTime()));
    // 最多等 60 秒就重新检查，避免系统睡眠后定时器漂移。
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, soonest - this.now().getTime()));
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  tick() {
    const now = this.now();
    for (const job of this.jobs) {
      if (job.enabled && job.nextRunAt && new Date(job.nextRunAt) <= now && !this.running.has(job.id)) this.run(job.id).catch(() => {});
    }
    this.arm();
  }

  targetSession(job) {
    if (job.sessionId) {
      try { return this.sessions.get(job.sessionId); } catch { /* 原会话被删掉了，下面新建 */ }
    }
    const meta = this.sessions.create({ title: `⏰ ${job.title}`, origin: 'panel', surface: 'panel', tier: 'owner' });
    job.sessionId = meta.id;
    return meta;
  }

  async run(id, { manual = false } = {}) {
    const job = this.get(id);
    if (this.running.has(id)) throw httpError(409, '这个任务正在运行');
    this.running.add(id);
    const startedAt = this.now();
    const scheduledFor = job.nextRunAt;
    // 先推进下一次时间，避免任务执行较久时被重复触发。
    if (!manual) {
      job.nextRunAt = computeNextRun(job.schedule, startedAt, startedAt.toISOString());
      if (!job.nextRunAt) job.enabled = false;
    }
    const catchUp = job.catchUp === true;
    delete job.catchUp;
    this.save();
    this.emit('run', { job: this.view(job), phase: 'start' });
    let meta;
    let result;
    try {
      meta = this.targetSession(job);
      this.save();
      const lines = [
        `【定时任务「${job.title}」${manual ? '手动运行' : '到点触发'} · ${localTime(startedAt)}】`,
        catchUp && scheduledFor ? `（原定 ${localTime(scheduledFor)}，当时 Claw 没有运行，现在补上）` : '',
        job.prompt,
      ].filter(Boolean);
      result = await this.sessions.send(meta.id, { text: lines.join('\n'), from: '定时任务', via: 'schedule' }, this.hooksFor(meta));
    } catch (error) {
      result = { ok: false, error: error.message, entry: { text: '' }, files: error.files || [] };
    }
    const text = (result.entry?.text || result.text || '').trim();
    job.lastRunAt = startedAt.toISOString();
    job.runs += 1;
    job.lastResult = { ok: result.ok !== false, at: this.now().toISOString(), text: (text || result.error || '').slice(0, 500), error: result.ok === false ? result.error || '' : '' };
    this.running.delete(id);
    if (this.jobs.includes(job)) this.save();
    this.arm();
    this.log(`[schedule] 「${job.title}」运行${result.ok === false ? `失败：${result.error}` : '完成'}`);
    try { await this.deliver({ job: this.view(job), session: meta, text, ok: result.ok !== false, error: result.error || '', files: result.files || [] }); }
    catch (error) { this.log(`[schedule] 推送结果失败：${error.message}`); }
    this.emit('run', { job: this.view(job), phase: 'end', ok: result.ok !== false });
    return this.view(job);
  }
}
