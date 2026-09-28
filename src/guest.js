import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const PERIODS = ['day', 'week', 'month', 'total'];

// 以本机时区划分统计周期。周从周一开始。
export function periodKey(period, date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  if (period === 'total') return 'total';
  if (period === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  if (period === 'week') {
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    return `w${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const PERIOD_NAMES = { day: '今天', week: '本周', month: '本月', total: '总共' };

/** Discord 访客的使用次数统计与额度判断。 */
export class GuestUsage {
  constructor({ dataDir, config, now = () => new Date() }) {
    this.file = path.join(dataDir, 'guest-usage.json');
    this.config = config;
    this.now = now;
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  get policy() { return this.config.discord.guest; }

  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }

  limitFor(userId) {
    const override = this.policy.userLimits?.[userId];
    return Number.isSafeInteger(override) && override >= 0 ? override : this.policy.quota.limit;
  }

  status(userId) {
    const period = PERIODS.includes(this.policy.quota.period) ? this.policy.quota.period : 'day';
    const key = periodKey(period, this.now());
    const record = this.data[userId];
    const used = record?.period === key ? record.count : 0;
    const limit = this.limitFor(userId);
    return { used, limit, remaining: Math.max(0, limit - used), period, periodName: PERIOD_NAMES[period] };
  }

  // 先检查再计数；额度用完时返回 allowed=false，不计数。
  consume(userId, identity = {}) {
    const status = this.status(userId);
    if (status.used >= status.limit) return { allowed: false, ...status };
    const key = periodKey(status.period, this.now());
    this.data[userId] = { period: key, count: status.used + 1, name: identity.name || this.data[userId]?.name || '', total: (this.data[userId]?.total || 0) + 1, lastAt: this.now().toISOString() };
    this.save();
    return { allowed: true, ...status, used: status.used + 1, remaining: status.remaining - 1 };
  }

  reset(userId) {
    if (this.data[userId]) { this.data[userId].count = 0; this.save(); }
  }

  list() {
    return Object.entries(this.data).map(([id, record]) => ({ id, name: record.name, total: record.total, lastAt: record.lastAt, ...this.status(id) }))
      .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  }
}
