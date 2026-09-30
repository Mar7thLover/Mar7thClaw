import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runOneShot as defaultOneShot } from '../claude/oneshot.js';
import { prepareImage } from '../images.js';

const BATCH = 16;
const MAX_NOTE_CHARS = 40;
const RETRY_AFTER_MS = 24 * 3600 * 1000;
const SYSTEM = '你负责给 Discord 聊天用的自定义表情和贴纸写简短的画面描述，供聊天机器人按描述挑选使用。只输出 JSON。';

export function emojiImageUrl(id) {
  // 动图表情请求 .png 会拿到第一帧，描述画面足够了。
  return `https://cdn.discordapp.com/emojis/${id}.png?size=96`;
}

// 贴纸格式：1 PNG、2 APNG、3 Lottie（矢量动画，没法当图片看）、4 GIF。
export function stickerImageUrl(sticker) {
  if (sticker.format === 3 || sticker.formatType === 3) return null;
  const ext = sticker.format === 4 || sticker.formatType === 4 ? 'gif' : 'png';
  return `https://media.discordapp.net/stickers/${sticker.id}.${ext}?size=160`;
}

/**
 * 服务器表情 / 贴纸的画面描述：很多表情名字只是 emoji_52 这样的编号，她没法据此挑选。
 * 第一次见到时在后台下载图片，让模型看图写一句描述，按 ID 缓存到 data/emoji-notes.json。
 * 缓存文件可以手动编辑：把某条的 manual 设为 true 后不会再被自动覆盖。
 */
export class EmojiNotes {
  constructor({ dataDir, config, claudeBin, log = () => {}, runOneShot = defaultOneShot, fetchImpl = fetch, now = () => Date.now() }) {
    this.file = path.join(dataDir, 'emoji-notes.json');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.config = config;
    this.claudeBin = claudeBin;
    this.log = log;
    this.runOneShot = runOneShot;
    this.fetch = fetchImpl;
    this.now = now;
    this.notes = {};
    this.queue = [];
    this.working = null;
    mkdirSync(dataDir, { recursive: true });
    if (existsSync(this.file)) {
      try { this.notes = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.log('[emoji] emoji-notes.json 损坏，已忽略'); }
    }
  }

  get cfg() { return this.config.discord.emojiNotes || {}; }

  get(id) {
    return this.notes[id]?.note || '';
  }

  save() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.notes, null, 2), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }

  /**
   * 把还没有描述的表情 / 贴纸排进后台队列。
   * @param {{ id: string, kind: 'emoji'|'sticker', name: string, url: string|null, context?: string }[]} items
   */
  describe(items) {
    if (this.cfg.enabled === false) return;
    const queued = new Set([...this.queue.map(item => item.id), ...(this.working || []).map(item => item.id)]);
    for (const item of items) {
      const known = this.notes[item.id];
      if (!item.url || queued.has(item.id)) continue;
      if (known?.note || (known?.failedAt && this.now() - Date.parse(known.failedAt) < RETRY_AFTER_MS)) continue;
      this.queue.push(item);
      queued.add(item.id);
    }
    this.pump();
  }

  async pump() {
    if (this.working || !this.queue.length) return;
    // 同一批只放同一个服务器、同一种类的图，提示里的上下文才对得上。
    const head = this.queue[0];
    const batch = this.queue.filter(item => item.kind === head.kind && item.context === head.context).slice(0, BATCH);
    this.queue = this.queue.filter(item => !batch.includes(item));
    this.working = batch;
    try {
      await this.describeBatch(batch);
    } catch (error) {
      this.log(`[emoji] 描述表情失败：${error.message}`);
      const at = new Date(this.now()).toISOString();
      for (const item of batch) if (!this.notes[item.id]?.note) this.notes[item.id] = { kind: item.kind, name: item.name, note: '', failedAt: at };
      this.save();
    }
    this.working = null;
    this.pump();
  }

  async download(url) {
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return prepareImage(Buffer.from(await response.arrayBuffer()));
  }

  async describeBatch(batch) {
    const label = batch[0].kind === 'sticker' ? '贴纸' : '自定义表情';
    const content = [];
    const numbered = [];
    for (const item of batch) {
      try {
        const image = await this.download(item.url);
        numbered.push(item);
        content.push({ type: 'text', text: `#${numbered.length} 原名：${item.name}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.buffer.toString('base64') } });
      } catch (error) {
        this.log(`[emoji] 下载${label} ${item.name} 失败：${error.message}`);
        if (!this.notes[item.id]?.note) this.notes[item.id] = { kind: item.kind, name: item.name, note: '', failedAt: new Date(this.now()).toISOString() };
      }
    }
    if (!numbered.length) throw new Error('图片都没有下载成功');
    content.unshift({ type: 'text', text: [
      `下面依次是${batch[0].context ? ` Discord 服务器「${batch[0].context}」的` : '一些'} ${numbered.length} 个${label}，每张前面标了编号和原名（原名经常只是 emoji_52 这样的编号，不代表内容）。`,
      `给每张写一句中文描述，不超过 ${MAX_NOTE_CHARS - 16} 个字：画的是谁（认得出的动漫 / 游戏角色写出名字，比如《崩坏：星穹铁道》里的三月七、流萤；认不出就写外观，不要瞎猜名字）、什么表情或动作、适合在聊天里表达什么情绪。`,
      '图里有文字的把文字带上。只输出一个 JSON 对象，键是编号（不带 #），值是描述，例如 {"1":"三月七比心，开心撒娇","2":"流萤捂脸害羞"}。',
    ].join('\n') });
    const { text } = await this.runOneShot({ claudeBin: this.claudeBin, tmpDir: this.tmpDir, content, system: SYSTEM, model: this.cfg.model || 'sonnet', timeoutMs: 180000 });
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (!json) throw new Error('模型没有返回 JSON');
    const parsed = JSON.parse(json);
    const at = new Date(this.now()).toISOString();
    let count = 0;
    for (const [index, item] of numbered.entries()) {
      const note = String(parsed[String(index + 1)] || parsed[`#${index + 1}`] || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
      if (this.notes[item.id]?.manual) continue;
      if (!note) { this.notes[item.id] = { kind: item.kind, name: item.name, note: '', failedAt: at }; continue; }
      this.notes[item.id] = { kind: item.kind, name: item.name, note, at };
      count++;
    }
    this.save();
    this.log(`[emoji] 描述了 ${count} 个${label}${batch[0].context ? `（${batch[0].context}）` : ''}`);
  }
}
