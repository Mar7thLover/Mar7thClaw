// 世界书（character_book）关键词激活，语义对齐酒馆 World Info 的常用子集：
// 常驻条目、主/次关键词与四种逻辑、/正则/、整词匹配、概率、递归扫描、预算与排序。
export const POSITION = { BEFORE_CHAR: 0, AFTER_CHAR: 1, AN_TOP: 2, AN_BOTTOM: 3, AT_DEPTH: 4, EM_TOP: 5, EM_BOTTOM: 6 };
const LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 形如 /pattern/flags 的关键词按正则处理，其余按字面量处理。
export function keyMatcher(key, { caseSensitive = false, wholeWords = false } = {}) {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(key);
  if (regex) {
    try {
      const re = new RegExp(regex[1], regex[2].replace(/[gy]/g, ''));
      return text => re.test(text);
    } catch { return () => false; }
  }
  const needle = key.trim();
  if (!needle) return () => false;
  // CJK 文本没有词边界，整词匹配只对纯拉丁词生效。
  if (wholeWords && /^[\w\s'-]+$/.test(needle)) {
    const re = new RegExp(`(?:^|\\W)${escapeRegex(needle)}(?:$|\\W)`, caseSensitive ? '' : 'i');
    return text => re.test(text);
  }
  if (caseSensitive) return text => text.includes(needle);
  const lower = needle.toLowerCase();
  return text => text.toLowerCase().includes(lower);
}

function matchesAny(keys, text, options) {
  return keys.some(key => keyMatcher(key, options)(text));
}

function entryMatches(entry, text) {
  const options = { caseSensitive: entry.case_sensitive === true, wholeWords: entry.extensions.match_whole_words === true };
  if (!matchesAny(entry.keys, text, options)) return false;
  if (!entry.selective || !entry.secondary_keys.length) return true;
  const hits = entry.secondary_keys.map(key => keyMatcher(key, options)(text));
  switch (entry.extensions.selectiveLogic) {
    case LOGIC.NOT_ALL: return !hits.every(Boolean);
    case LOGIC.NOT_ANY: return !hits.some(Boolean);
    case LOGIC.AND_ALL: return hits.every(Boolean);
    default: return hits.some(Boolean);
  }
}

/**
 * @param {object} book 规范化后的 character_book
 * @param {string[]} messages 最近的可见消息文本（旧→新），最后一条是当前输入
 * @returns {{constant: object[], triggered: object[]}} 常驻条目进入 system 层（利于缓存），触发条目进入本轮注入层
 */
export function activateEntries(book, messages, { scanDepth = 4, budgetChars = 6000, recursion = true, random = Math.random } = {}) {
  const entries = (book?.entries || []).filter(entry => entry.enabled && entry.content.trim());
  const active = new Map();
  const scanFor = entry => {
    const depth = entry.extensions.scan_depth ?? book.scan_depth ?? scanDepth;
    return messages.slice(-Math.max(1, depth)).join('\n');
  };
  for (const entry of entries) {
    if (entry.constant) active.set(entry, 'constant');
  }
  for (const entry of entries) {
    if (active.has(entry) || !entry.keys.length) continue;
    if (entryMatches(entry, scanFor(entry))) active.set(entry, 'keyword');
  }
  if (recursion && book?.recursive_scanning !== false) {
    // 已激活条目的正文可以继续触发其他条目，最多 3 层。
    for (let level = 0; level < 3; level++) {
      const source = [...active.keys()].filter(entry => !entry.extensions.prevent_recursion).map(entry => entry.content).join('\n');
      let added = false;
      for (const entry of entries) {
        if (active.has(entry) || !entry.keys.length || entry.extensions.exclude_recursion) continue;
        if (entryMatches(entry, source)) { active.set(entry, 'recursive'); added = true; }
      }
      if (!added) break;
    }
  }
  const passed = [...active.entries()].filter(([entry]) => {
    const ext = entry.extensions;
    return !ext.useProbability || ext.probability >= 100 || random() * 100 < ext.probability;
  });
  // insertion_order 越大越靠后、越接近输出位置；预算按优先级从高到低保留。
  passed.sort((a, b) => b[0].insertion_order - a[0].insertion_order);
  const kept = [];
  let used = 0;
  for (const [entry, reason] of passed) {
    if (used + entry.content.length > budgetChars && kept.length) continue;
    used += entry.content.length;
    kept.push({ ...entry, reason });
  }
  kept.sort((a, b) => a.insertion_order - b.insertion_order);
  return {
    constant: kept.filter(entry => entry.reason === 'constant'),
    triggered: kept.filter(entry => entry.reason !== 'constant'),
  };
}
