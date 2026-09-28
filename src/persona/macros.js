// 酒馆（SillyTavern）风格宏的子集。未知宏原样保留，避免把用户文本吞掉。
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const pad = n => String(n).padStart(2, '0');

function roll(spec, random) {
  const match = /^(\d*)d(\d+)$/i.exec(spec.trim()) || /^()(\d+)$/.exec(spec.trim());
  if (!match) return null;
  const count = Math.min(Number(match[1] || 1), 100);
  const sides = Number(match[2]);
  if (!sides) return null;
  let total = 0;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(random() * sides);
  return String(total);
}

export function expandMacros(text, ctx = {}, { now = new Date(), random = Math.random } = {}) {
  if (typeof text !== 'string' || !text) return text || '';
  const values = {
    char: ctx.char ?? '', user: ctx.user ?? '', persona: ctx.persona ?? '',
    description: ctx.description ?? '', personality: ctx.personality ?? '', scenario: ctx.scenario ?? '',
    original: ctx.original ?? '', mesexamples: ctx.mesExamples ?? '', lastmessage: ctx.lastMessage ?? '',
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`,
    weekday: WEEKDAYS[now.getDay()],
    isotime: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    isodate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    newline: '\n',
  };
  let out = text.replace(/<USER>/g, values.user).replace(/<BOT>/g, values.char);
  // 最多展开 3 轮，允许 {{description}} 中再出现 {{char}}，同时防止自引用死循环。
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    out = out.replace(/\{\{([^{}]*)\}\}/g, (whole, body) => {
      const raw = body.trim();
      const key = raw.toLowerCase();
      if (key.startsWith('//')) return '';
      if (key === 'trim') return '\u0000TRIM\u0000';
      if (key in values) return values[key];
      const colon = raw.indexOf(':');
      if (colon > 0) {
        const name = raw.slice(0, colon).trim().toLowerCase();
        const arg = raw.slice(colon + 1);
        if (name === 'random' || name === 'pick') {
          const options = (arg.includes('::') ? arg.split('::') : arg.split(',')).map(s => s.trim());
          return options.length ? options[Math.floor(random() * options.length)] : '';
        }
        if (name === 'roll') return roll(arg, random) ?? whole;
      }
      return whole;
    });
    if (out === before) break;
  }
  return out.replace(/\s*\u0000TRIM\u0000\s*/g, '');
}
