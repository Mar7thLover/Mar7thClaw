import { mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// 非图片附件：文本类解码后直接放进消息，PDF 作为文档内容块交给模型（访客也能读，不依赖工具）；
// 主人的附件另存到工作目录，其他格式由她用工具处理。
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_TEXT_CHARS = 50_000;
export const MAX_TOTAL_TEXT_CHARS = 120_000;
// 访客的文本类附件只下载这么大，反正超出的部分也不会内联。
export const MAX_GUEST_TEXT_BYTES = 5 * 1024 * 1024;
// Claude API 单次请求上限 32MB（base64 后），PDF 最多 100 页；超出的不内联，免得整轮报错、会话卡住。
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;
export const MAX_PDFS = 3;
// 她发回的文件；Discord 的实际上限按服务器加成等级另算。
export const MAX_OUTGOING_BYTES = 25 * 1024 * 1024;
export const MAX_OUTGOING_FILES = 10;

const TEXT_EXT = new Set(('txt md markdown rst adoc csv tsv json jsonl json5 ndjson yaml yml toml ini cfg conf properties env log xml svg html htm css scss sass less '
  + 'js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi ipynb rb go rs java kt kts groovy gradle c h cc cpp cxx hpp hh cs fs swift m mm php lua pl r dart scala clj ex exs erl hs ml '
  + 'sh bash zsh fish ps1 psm1 psd1 bat cmd sql graphql gql proto tf hcl nix dockerfile makefile cmake gitignore gitattributes editorconfig tex bib srt vtt ass lrc diff patch reg').split(' '));
const BINARY_EXT = new Set(('zip 7z rar tar gz tgz bz2 xz zst exe dll msi sys bin iso img dmg apk ipa jar class pyc so o a lib obj pdb wasm '
  + 'doc docx xls xlsx ppt pptx odt ods odp epub mobi psd ai sketch fig blend fbx glb gltf stl '
  + 'mp3 wav flac ogg m4a aac opus mp4 mkv mov avi webm flv wmv ttf otf woff woff2 db sqlite mdb').split(' '));
const INLINE_IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function extOf(name) {
  const base = path.basename(String(name || '')).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : base;
}

// 只看文件名和 Content-Type 猜类型（Discord 上决定访客的附件要不要下载）。
export function guessKind(name = '', contentType = '') {
  const ext = extOf(name);
  if (ext === 'pdf' || /application\/pdf/i.test(contentType)) return 'pdf';
  if (TEXT_EXT.has(ext) || /^text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml)/i.test(contentType)) return 'text';
  if (BINARY_EXT.has(ext)) return 'binary';
  return 'unknown';
}

// 去掉路径与控制字符，保留中文，用于显示和落盘。
export function safeFileName(name, fallback = 'file') {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+$/, '').trim();
  return (base || fallback).slice(-120);
}

export function formatSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1).replace(/\.0$/, '')}MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))}KB`;
}

/**
 * 把字节解码成文本；看起来是二进制时返回 null。
 * 支持 UTF-8（含 BOM）、UTF-16 BOM，Windows 上常见的 GBK 文本用 GB18030 兜底。
 */
export function decodeText(buffer) {
  if (!buffer.length) return { text: '', encoding: 'utf-8' };
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  const sample = buffer.subarray(0, 64 * 1024);
  if (sample.includes(0)) return null;
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer).replace(/^﻿/, '');
      const control = (text.slice(0, 20000).match(/[\u0000-\u0008\u000e-\u001f]/g) || []).length;
      if (control > 8) return null;
      return { text, encoding };
    } catch { /* 换下一种编码 */ }
  }
  return null;
}

// 粗略估计 PDF 页数：取页树里最大的 /Count，找不到时数 /Type /Page；对象流压缩过的 PDF 可能返回 null。
export function pdfPageCount(buffer) {
  const text = buffer.toString('latin1');
  let max = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) max = Math.max(max, Number(match[1] || match[2]));
  if (max) return max;
  const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  return pages || null;
}

export function isPdf(buffer) {
  return buffer.subarray(0, 1024).toString('latin1').includes('%PDF-');
}

function storeCopy(dataDir, sessionId, dir, name, write) {
  const target = path.join(dataDir, 'uploads', sessionId, dir);
  mkdirSync(target, { recursive: true });
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,10}$/) || [''])[0];
  const stored = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
  write(path.join(target, stored));
  return `${sessionId}/${dir}/${stored}`;
}

/**
 * 处理一批非图片附件。
 * @param {Array<{ name: string, buffer: Buffer, label?: string }>} items
 * @param {object} options saveDir：主人会话的附件另存目录（为空表示访客，二进制文件不保留）；prefix：落盘文件名前缀
 * @returns {Promise<{ files: object[], documents: Array<{ name: string, data: string }>, notes: string[] }>}
 *   files 的每项会写进聊天记录（不含 text）；text 只在本轮提示词里使用。
 */
export async function ingestFiles(dataDir, sessionId, items, { saveDir = null, prefix = '' } = {}) {
  const files = [];
  const documents = [];
  const notes = [];
  let textBudget = MAX_TOTAL_TEXT_CHARS;
  for (const item of items.slice(0, MAX_FILES)) {
    const name = safeFileName(item.name);
    const label = item.label || name;
    const buffer = item.buffer;
    if (!Buffer.isBuffer(buffer)) { notes.push(`<附件 ${label} 读取失败>`); continue; }
    if (buffer.length > MAX_FILE_BYTES) { notes.push(`<附件 ${label} 超过 ${formatSize(MAX_FILE_BYTES)}，未接收>`); continue; }
    const pdf = isPdf(buffer);
    const decoded = pdf ? null : decodeText(buffer);
    const kind = pdf ? 'pdf' : decoded ? 'text' : 'binary';
    if (kind === 'binary' && !saveDir) { notes.push(`<附件:${label}（这类文件没办法直接读取）>`); continue; }
    const entry = { name, size: buffer.length, kind, file: storeCopy(dataDir, sessionId, 'in', name, file => writeFileSync(file, buffer)) };
    if (item.label && item.label !== name) entry.label = item.label;
    if (saveDir) {
      mkdirSync(saveDir, { recursive: true });
      entry.path = path.join(saveDir, `${prefix || Date.now()}-${name.replace(/[^\w.一-鿿-]/g, '_')}`);
      writeFileSync(entry.path, buffer);
    }
    if (kind === 'text') {
      entry.encoding = decoded.encoding;
      entry.chars = decoded.text.length;
      const take = Math.max(0, Math.min(MAX_TEXT_CHARS, textBudget));
      entry.text = decoded.text.slice(0, take);
      entry.truncated = decoded.text.length > take;
      textBudget -= entry.text.length;
    } else if (kind === 'pdf') {
      const pages = pdfPageCount(buffer);
      if (pages) entry.pages = pages;
      if (buffer.length > MAX_PDF_BYTES) entry.skipped = `超过 ${formatSize(MAX_PDF_BYTES)}`;
      else if (pages > MAX_PDF_PAGES) entry.skipped = `超过 ${MAX_PDF_PAGES} 页`;
      else if (documents.length >= MAX_PDFS) entry.skipped = `一条消息最多直接附上 ${MAX_PDFS} 个 PDF`;
      else documents.push({ name, data: buffer.toString('base64') });
      entry.inline = !entry.skipped;
    }
    files.push(entry);
  }
  if (items.length > MAX_FILES) notes.push(`<另有 ${items.length - MAX_FILES} 个附件超出单条消息上限，未接收>`);
  return { files, documents, notes };
}

// 聊天记录里只保留元数据，文本内容不落进 jsonl。
export function fileRecord(file) {
  const { text, ...rest } = file;
  return rest;
}

/**
 * 她要发给对方的文件：复制一份到 data/uploads/<会话>/out/，这样面板以后还能下载，Discord 发送时也不受原文件变动影响。
 * blocked：不允许发送的目录（Claw 的数据目录里有令牌）。
 */
export function stageOutgoing(dataDir, sessionId, cwd, filePath, name, blocked = []) {
  const raw = String(filePath || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) throw Object.assign(new Error('缺少文件路径'), { status: 400 });
  const absolute = path.resolve(cwd, raw);
  const lower = absolute.toLowerCase();
  for (const dir of blocked) {
    const d = path.resolve(dir).toLowerCase();
    if (lower === d || lower.startsWith(d + path.sep)) throw Object.assign(new Error('这个位置的文件不能发送（Claw 的数据或凭据目录）'), { status: 403 });
  }
  let stat;
  try { stat = statSync(absolute); } catch { throw Object.assign(new Error(`找不到文件：${absolute}`), { status: 404 }); }
  if (!stat.isFile()) throw Object.assign(new Error(`不是文件：${absolute}`), { status: 400 });
  if (stat.size > MAX_OUTGOING_BYTES) throw Object.assign(new Error(`文件 ${formatSize(stat.size)}，超过 ${formatSize(MAX_OUTGOING_BYTES)} 的上限`), { status: 413 });
  const display = safeFileName(name || path.basename(absolute));
  const file = storeCopy(dataDir, sessionId, 'out', display, target => copyFileSync(absolute, target));
  const mediaType = INLINE_IMAGE[path.extname(display).toLowerCase()] || '';
  return { name: display, size: stat.size, file, source: absolute, ...(mediaType ? { mediaType } : {}) };
}

export function uploadPath(dataDir, file) {
  return path.join(dataDir, 'uploads', ...String(file).split('/'));
}

export function inlineImageType(name) {
  return INLINE_IMAGE[path.extname(String(name || '')).toLowerCase()] || '';
}
