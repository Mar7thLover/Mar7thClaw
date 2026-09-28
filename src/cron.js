// 标准 5 段 cron（分 时 日 月 周），按本机时区计算。支持 * , - / 以及 @hourly/@daily/@weekly/@monthly。
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *' };
const FIELDS = [['分钟', 0, 59], ['小时', 0, 23], ['日期', 1, 31], ['月份', 1, 12], ['星期', 0, 7]];

function parseField(text, [name, min, max]) {
  const values = new Set();
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!match) throw new Error(`cron 的${name}字段无效：${part}`);
    let [from, to] = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
    if (to === undefined) to = match[2] ? max : from;
    const step = match[2] ? Number(match[2]) : 1;
    if (from < min || to > max || from > to || step < 1) throw new Error(`cron 的${name}字段超出范围：${part}`);
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

export function parseCron(expression) {
  const source = ALIASES[String(expression).trim().toLowerCase()] || String(expression).trim();
  const parts = source.split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 表达式需要 5 段：分 时 日 月 周（例如 "0 9 * * *" 表示每天 9:00）');
  const [minutes, hours, days, months, weekdays] = parts.map((part, i) => parseField(part, FIELDS[i]));
  if (weekdays.has(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function dayMatches(cron, date) {
  if (!cron.months.has(date.getMonth() + 1)) return false;
  const dom = cron.days.has(date.getDate());
  const dow = cron.weekdays.has(date.getDay());
  // 与 Vixie cron 一致：日期与星期都受限时满足其一即可。
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dow;
  if (cron.dowAny) return dom;
  return dom || dow;
}

// 返回严格晚于 from 的下一次触发时间；两年内找不到则返回 null（例如 2 月 30 日）。
export function nextCronRun(expression, from = new Date()) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const date = new Date(from.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = from.getTime() + 2 * 366 * 86400000;
  while (date.getTime() <= limit) {
    if (!dayMatches(cron, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date;
  }
  return null;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
// 常见表达式给出中文描述，其余原样显示。
export function describeCron(expression) {
  const source = ALIASES[String(expression).trim().toLowerCase()] || String(expression).trim();
  const [m, h, dom, mon, dow] = source.split(/\s+/);
  const time = /^\d+$/.test(m) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (time && dom === '*' && mon === '*' && dow === '*') return `每天 ${time}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `工作日 ${time}`;
  if (time && dom === '*' && mon === '*' && /^[0-7](,[0-7])*$/.test(dow)) return `每周${dow.split(',').map(d => WEEK[Number(d) % 7]).join('、')} ${time}`;
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `每月 ${dom} 日 ${time}`;
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `每小时第 ${m} 分`;
  const step = /^\*\/(\d+)$/.exec(m);
  if (step && h === '*' && dom === '*' && mon === '*' && dow === '*') return `每 ${step[1]} 分钟`;
  return `cron ${source}`;
}
