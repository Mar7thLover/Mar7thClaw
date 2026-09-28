import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Claude API 支持的图片格式与建议尺寸：长边超过 1568px 会被服务端缩小（只增加延迟），单张不能超过 5MB（base64 前）。
export const MAX_EDGE = 1568;
export const MAX_BYTES = 3.75 * 1024 * 1024;
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES = 6;
const PASSTHROUGH = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function looksLikeImage(name = '', contentType = '') {
  return /^image\//i.test(contentType) || /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic)$/i.test(name);
}

/**
 * 把任意图片整理成可以直接发给模型的格式。
 * @returns {Promise<{ mediaType: string, buffer: Buffer, width: number, height: number }>}
 */
export async function prepareImage(input) {
  if (!Buffer.isBuffer(input) || !input.length) throw new Error('图片为空');
  if (input.length > MAX_INPUT_BYTES) throw new Error('图片超过 25MB');
  let meta;
  try { meta = await sharp(input, { animated: false }).metadata(); } catch { throw new Error('无法识别的图片格式'); }
  const longEdge = Math.max(meta.width || 0, meta.height || 0);
  const passthrough = PASSTHROUGH[meta.format];
  // 已经合规的图片原样使用（旋转信息正常的前提下），避免二次压缩损失。
  if (passthrough && longEdge <= MAX_EDGE && input.length <= MAX_BYTES && (!meta.orientation || meta.orientation === 1)) {
    return { mediaType: passthrough, buffer: input, width: meta.width, height: meta.height };
  }
  const alpha = meta.hasAlpha === true;
  for (const quality of [85, 72, 60, 45]) {
    const pipeline = sharp(input, { animated: false }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    const { data, info } = alpha
      ? await pipeline.webp({ quality }).toBuffer({ resolveWithObject: true })
      : await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    if (data.length <= MAX_BYTES || quality === 45) {
      if (data.length > MAX_BYTES) throw new Error('图片压缩后仍然太大');
      return { mediaType: alpha ? 'image/webp' : 'image/jpeg', buffer: data, width: info.width, height: info.height };
    }
  }
  throw new Error('图片处理失败');
}

// 保存处理后的图片，返回相对 data/uploads 的路径（面板用它显示缩略图）。
export function saveUpload(dataDir, sessionId, image) {
  const dir = path.join(dataDir, 'uploads', sessionId);
  mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${randomUUID().slice(0, 8)}.${EXT[image.mediaType] || 'bin'}`;
  writeFileSync(path.join(dir, name), image.buffer);
  return `${sessionId}/${name}`;
}

// 处理并保存一批图片；单张失败不影响其他图片，失败原因以文字说明返回。
export async function ingestImages(dataDir, sessionId, items) {
  const images = [];
  const notes = [];
  for (const item of items.slice(0, MAX_IMAGES)) {
    try {
      const image = await prepareImage(item.buffer);
      images.push({ mediaType: image.mediaType, data: image.buffer.toString('base64'), file: saveUpload(dataDir, sessionId, image), name: item.name || '', width: image.width, height: image.height });
    } catch (error) {
      notes.push(`<图片 ${item.name || ''} 无法处理：${error.message}>`);
    }
  }
  if (items.length > MAX_IMAGES) notes.push(`<另有 ${items.length - MAX_IMAGES} 张图片超出单条消息上限，未发送>`);
  return { images, notes };
}
