// Discord 单条消息上限 2000 字符。按行切分并保持代码块闭合：
// 一块结尾处于代码块内部时补上闭合围栏，下一块开头重开同一个围栏行。
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const BREAK_AFTER = /[\s，。！？；、,.!?;:：）)」』】]/;

function hardSplit(line, limit) {
  const parts = [];
  let rest = line;
  while (rest.length > limit) {
    let cut = -1;
    for (let i = limit; i > limit * 0.5; i--) {
      if (BREAK_AFTER.test(rest[i - 1])) { cut = i; break; }
    }
    if (cut < 0) {
      cut = limit;
      // 不要把代理对（emoji 等）劈成两半。
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

export function chunkMessage(text, { maxChars = 2000, maxLines = 17 } = {}) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) return [];
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let open = null;
  const closing = () => open ? `${open.indent}${open.marker}` : '';
  const flush = () => {
    if (!current.length) return;
    const body = current.join('\n');
    chunks.push(open ? `${body}\n${closing()}` : body);
    current = open ? [open.line] : [];
    currentLength = open ? open.line.length : 0;
  };
  for (const line of source.split('\n')) {
    const fence = FENCE.exec(line);
    let next = open;
    if (fence) {
      if (!open) next = { indent: fence[1], marker: fence[2], line };
      else if (fence[2][0] === open.marker[0] && fence[2].length >= open.marker.length && !fence[3].trim()) next = null;
    }
    const reserve = next ? next.indent.length + next.marker.length + 1 : 0;
    const budget = Math.max(200, maxChars - reserve - (open ? open.line.length + 1 : 0));
    for (const piece of hardSplit(line, budget)) {
      const addition = (current.length ? 1 : 0) + piece.length;
      const lineCount = current.length + 1;
      if (current.length && (currentLength + addition + reserve > maxChars || lineCount > maxLines)) flush();
      current.push(piece);
      currentLength += (current.length > 1 ? 1 : 0) + piece.length;
    }
    open = next;
  }
  if (current.length) {
    const body = current.join('\n');
    chunks.push(open ? `${body}\n${closing()}` : body);
  }
  return chunks.filter(chunk => chunk.trim());
}
