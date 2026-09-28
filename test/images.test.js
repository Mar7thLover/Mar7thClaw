import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { prepareImage, ingestImages, looksLikeImage, MAX_EDGE, MAX_BYTES } from '../src/images.js';
import { runTurn } from '../src/claude/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tempDir = t => { const dir = mkdtempSync(path.join(tmpdir(), 'mar7thclaw-img-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const solid = (width, height, channels = 3, format = 'png') => sharp({ create: { width, height, channels, background: channels === 4 ? { r: 255, g: 100, b: 200, alpha: 0.5 } : { r: 255, g: 180, b: 220 } } })[format]().toBuffer();

test('图片预处理：合规图片原样使用，超大图缩小，透明图转 WebP，其他格式转 JPEG', async () => {
  const small = await solid(300, 200);
  const kept = await prepareImage(small);
  assert.equal(kept.mediaType, 'image/png');
  assert.equal(kept.buffer, small);
  const big = await prepareImage(await solid(4000, 3000, 3, 'png'));
  assert.equal(big.mediaType, 'image/jpeg');
  assert.equal(Math.max(big.width, big.height), MAX_EDGE);
  assert.ok(big.buffer.length <= MAX_BYTES);
  const alpha = await prepareImage(await solid(3000, 1000, 4, 'png'));
  assert.equal(alpha.mediaType, 'image/webp');
  const tiff = await prepareImage(await solid(100, 100, 3, 'tiff'));
  assert.equal(tiff.mediaType, 'image/jpeg');
  await assert.rejects(prepareImage(Buffer.from('不是图片')), /无法识别/);
  assert.ok(looksLikeImage('a.JPG') && looksLikeImage('x', 'image/png') && !looksLikeImage('a.txt', 'text/plain'));
});

test('图片入库：保存处理后的文件，单张失败只留说明', async t => {
  const dir = tempDir(t);
  const { images, notes } = await ingestImages(dir, 'sess', [{ name: 'ok.png', buffer: await solid(50, 50) }, { name: 'bad.png', buffer: Buffer.from('x') }]);
  assert.equal(images.length, 1);
  assert.ok(existsSync(path.join(dir, 'uploads', images[0].file)) && statSync(path.join(dir, 'uploads', images[0].file)).size > 0);
  assert.match(images[0].file, /^sess\/\d+-\w+\.png$/);
  assert.match(notes[0], /bad\.png 无法处理/);
});

test('运行器：图片以内容块放在文字之前发给 Claude Code', async t => {
  const dir = tempDir(t);
  const data = (await solid(20, 20)).toString('base64');
  const texts = [];
  await runTurn({ claudeSessionId: 'x', resume: false, cwd: dir, system: 'S', prompt: '<message>看图</message>', permissionMode: 'auto', tier: 'guest', images: [{ mediaType: 'image/png', data }, { mediaType: 'image/png', data }] }, {
    claudeBin: 'fake', tmpDir: path.join(dir, 'tmp'), onEvent: e => { if (e.type === 'text') texts.push(e.text); },
    spawnProcess: (bin, args, options) => spawn(process.execPath, [path.join(here, 'fake-claude.js'), ...args], { ...options, env: { ...options.env, FAKE_MODE: 'images' } }),
  });
  assert.equal(texts.join(''), '图片2张，首块image');
});
