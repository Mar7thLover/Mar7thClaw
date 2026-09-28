import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

// 统一成 chara_card_v3 结构；V1（平铺字段）和 V2 都能读入，导出的 JSON 酒馆可直接导入。
const TEXT_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version'];

export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('角色卡必须是 JSON 对象');
  const data = raw.data && typeof raw.data === 'object' ? raw.data : raw;
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {} };
  for (const key of TEXT_FIELDS) card.data[key] = typeof data[key] === 'string' ? data[key] : '';
  if (!card.data.name.trim()) throw new Error('角色卡缺少 name');
  card.data.alternate_greetings = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.filter(s => typeof s === 'string') : [];
  card.data.group_only_greetings = Array.isArray(data.group_only_greetings) ? data.group_only_greetings.filter(s => typeof s === 'string') : [];
  card.data.tags = Array.isArray(data.tags) ? data.tags.filter(s => typeof s === 'string') : [];
  card.data.extensions = data.extensions && typeof data.extensions === 'object' ? structuredClone(data.extensions) : {};
  card.data.character_book = normalizeBook(data.character_book);
  return card;
}

export function normalizeBook(book) {
  if (!book || typeof book !== 'object') return { name: '', entries: [] };
  // 酒馆独立世界书导出的 entries 是以 uid 为键的对象，这里也兼容。
  const list = Array.isArray(book.entries) ? book.entries : Object.values(book.entries || {});
  return {
    name: typeof book.name === 'string' ? book.name : '',
    scan_depth: book.scan_depth, token_budget: book.token_budget, recursive_scanning: book.recursive_scanning,
    extensions: book.extensions || {},
    entries: list.map((entry, index) => normalizeEntry(entry, index)),
  };
}

function normalizeEntry(e, index) {
  const ext = e.extensions || {};
  const keys = e.keys ?? e.key ?? [];
  const secondary = e.secondary_keys ?? e.keysecondary ?? [];
  // 位置编码沿用酒馆：0 角色前 1 角色后 2 作者注释前 3 作者注释后 4 指定深度 5 示例前 6 示例后
  let position = ext.position;
  if (position === undefined) position = e.position === 'after_char' ? 1 : typeof e.position === 'number' ? e.position : 0;
  return {
    id: e.id ?? e.uid ?? index,
    name: e.name || e.comment || '',
    comment: e.comment || '',
    keys: Array.isArray(keys) ? keys.map(String) : String(keys).split(',').map(s => s.trim()).filter(Boolean),
    secondary_keys: Array.isArray(secondary) ? secondary.map(String) : [],
    content: typeof e.content === 'string' ? e.content : '',
    enabled: e.enabled !== undefined ? e.enabled !== false : e.disable !== true,
    constant: e.constant === true,
    selective: e.selective === true || (Array.isArray(secondary) && secondary.length > 0),
    insertion_order: Number(e.insertion_order ?? e.order ?? 100),
    case_sensitive: e.case_sensitive ?? ext.case_sensitive ?? false,
    extensions: {
      ...ext,
      position,
      depth: Number(ext.depth ?? e.depth ?? 4),
      role: ext.role ?? e.role ?? 0,
      probability: Number(ext.probability ?? e.probability ?? 100),
      useProbability: ext.useProbability ?? e.useProbability ?? true,
      selectiveLogic: Number(ext.selectiveLogic ?? e.selectiveLogic ?? 0),
      match_whole_words: ext.match_whole_words ?? e.matchWholeWords ?? null,
      exclude_recursion: ext.exclude_recursion ?? e.excludeRecursion ?? false,
      prevent_recursion: ext.prevent_recursion ?? e.preventRecursion ?? false,
      scan_depth: ext.scan_depth ?? e.scanDepth ?? null,
    },
  };
}

// 酒馆 PNG 角色卡：tEXt/iTXt 块中 keyword 为 ccv3（优先）或 chara，值为 base64 JSON。
export function extractPngCard(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(signature)) throw new Error('不是 PNG 文件');
  const found = {};
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'tEXt') {
      const zero = body.indexOf(0);
      found[body.toString('latin1', 0, zero)] = body.toString('latin1', zero + 1);
    } else if (type === 'iTXt') {
      const zero = body.indexOf(0);
      const keyword = body.toString('latin1', 0, zero);
      const compressed = body[zero + 1] === 1;
      let cursor = body.indexOf(0, zero + 3) + 1; // 跳过语言标签
      cursor = body.indexOf(0, cursor) + 1; // 跳过翻译关键字
      const text = body.subarray(cursor);
      found[keyword] = (compressed ? inflateSync(text) : text).toString('utf8');
    } else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const encoded = found.ccv3 ?? found.chara;
  if (!encoded) throw new Error('PNG 中没有找到角色卡数据（ccv3 / chara）');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

export function cardFromBuffer(buffer, filename = '') {
  if (/\.png$/i.test(filename) || buffer.subarray(0, 4).toString('latin1') === '\x89PNG') return normalizeCard(extractPngCard(buffer));
  return normalizeCard(JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')));
}

export class CardStore {
  constructor(dirs) {
    // dirs[0] 为用户卡目录（可写），其余为内置卡目录；同名时用户卡优先。
    this.dirs = dirs;
    mkdirSync(dirs[0], { recursive: true });
  }

  list() {
    const seen = new Map();
    for (const dir of [...this.dirs].reverse()) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const id = file.slice(0, -5);
        try {
          const card = this.get(id);
          seen.set(id, { id, name: card.data.name, tags: card.data.tags, builtin: dir !== this.dirs[0] });
        } catch { /* 损坏的卡不阻止面板加载 */ }
      }
    }
    return [...seen.values()];
  }

  file(id) {
    if (!/^[\w\u4e00-\u9fff.-]{1,80}$/.test(id)) throw new Error('角色卡 ID 只能包含字母、数字、中文、点、下划线和连字符');
    for (const dir of this.dirs) {
      const file = path.join(dir, `${id}.json`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  get(id) {
    const file = this.file(id);
    if (!file) throw new Error(`找不到角色卡：${id}`);
    return normalizeCard(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
  }

  // 头像沿用酒馆习惯：与卡同名的 PNG，用户目录优先。
  avatarFile(id) {
    this.file(id);
    for (const dir of this.dirs) {
      const file = path.join(dir, `${id}.png`);
      if (existsSync(file)) return file;
    }
    return null;
  }

  saveAvatar(id, buffer) {
    this.file(id);
    writeFileSync(path.join(this.dirs[0], `${id}.png`), buffer);
  }

  save(id, raw) {
    this.file(id);
    const card = normalizeCard(raw);
    writeFileSync(path.join(this.dirs[0], `${id}.json`), JSON.stringify(card, null, 2), 'utf8');
    return card;
  }
}
