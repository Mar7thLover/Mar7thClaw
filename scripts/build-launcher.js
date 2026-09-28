// 生成带头像图标的启动程序 Mar7thClaw.exe（electron.exe 的副本 + 自定义图标与版本信息）。
// Windows 在无法从快捷方式或窗口属性解析任务栏图标时，会退回可执行文件自身的图标；
// 让可执行文件本身就是头像，任务栏无论走哪条路都不会显示 Electron 的默认图标。
// 用法：npm run build-launcher（npm install 后会自动运行；换了头像后可以再跑一次，需先退出面板）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { rcedit } from 'rcedit';
import { root, dataDir, readUserConfig } from '../src/config.js';

if (process.platform !== 'win32') {
  console.log('非 Windows 系统，跳过生成启动程序。');
  process.exit(0);
}

const dist = path.join(root, 'node_modules', 'electron', 'dist');
const source = path.join(dist, 'electron.exe');
const target = path.join(dist, 'Mar7thClaw.exe');
if (!existsSync(source)) {
  console.log('还没有下载 Electron（node_modules/electron/dist/electron.exe 不存在），跳过。');
  process.exit(0);
}

const cardId = readUserConfig().card || 'march7th';
const avatar = [path.join(dataDir, 'cards', `${cardId}.png`), path.join(root, 'cards', `${cardId}.png`)].find(existsSync);

// 没有头像时画一个粉蓝渐变圆，中间一颗白色「冰晶」，与面板里的默认图标一致。
const fallbackSvg = size => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7fb6f5"/><stop offset="1" stop-color="#f39cc0"/></linearGradient></defs>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="url(#g)"/><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.16}" fill="#fff"/></svg>`);
const circleMask = size => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`);

async function rgba(size) {
  const base = avatar ? sharp(avatar).resize(size, size, { fit: 'cover' }) : sharp(fallbackSvg(size));
  return base.ensureAlpha().composite([{ input: circleMask(size), blend: 'dest-in' }]).raw().toBuffer();
}

// ICO：256 用 PNG 条目，其余用 32 位 DIB（Windows 只稳定支持 256 的 PNG 条目）。
async function buildIco(file) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const entries = [];
  for (const size of sizes) {
    const pixels = await rgba(size);
    if (size === 256) {
      entries.push(await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
      continue;
    }
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0);
    header.writeInt32LE(size, 4);
    header.writeInt32LE(size * 2, 8);
    header.writeUInt16LE(1, 12);
    header.writeUInt16LE(32, 14);
    const maskStride = Math.ceil(size / 32) * 4;
    header.writeUInt32LE(size * size * 4 + maskStride * size, 20);
    const bgra = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const src = (y * size + x) * 4;
        const dst = ((size - 1 - y) * size + x) * 4;
        bgra[dst] = pixels[src + 2];
        bgra[dst + 1] = pixels[src + 1];
        bgra[dst + 2] = pixels[src];
        bgra[dst + 3] = pixels[src + 3];
      }
    }
    entries.push(Buffer.concat([header, bgra, Buffer.alloc(maskStride * size)]));
  }
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(entries[i].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entries[i].length;
  });
  writeFileSync(file, Buffer.concat([dir, ...entries]));
}

mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
const icoFile = path.join(dataDir, 'tmp', `launcher-${Date.now()}.ico`);
await buildIco(icoFile);
const staging = `${target}.new`;
copyFileSync(source, staging);
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
await rcedit(staging, {
  icon: icoFile,
  'file-version': version,
  'product-version': version,
  'version-string': {
    ProductName: 'Mar7thClaw',
    FileDescription: 'Mar7thClaw · 三月七',
    CompanyName: 'Mar7thLover',
    OriginalFilename: 'Mar7thClaw.exe',
    InternalName: 'Mar7thClaw',
    LegalCopyright: 'MIT License',
  },
});
try {
  rmSync(target, { force: true });
  copyFileSync(staging, target);
  rmSync(staging, { force: true });
} catch (error) {
  console.error(`无法替换 ${target}（面板可能正在运行，请先从托盘「完全退出」后再运行）：${error.message}`);
  process.exit(1);
} finally {
  rmSync(icoFile, { force: true });
}
console.log(`已生成 ${target}（图标来源：${avatar || '默认渐变图标'}）`);
