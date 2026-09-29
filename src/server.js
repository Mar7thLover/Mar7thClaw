import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { root, publicConfig, saveUserConfig, replaceUserConfigValue, merge } from './config.js';
import { cardFromBuffer } from './persona/card.js';
import { ingestImages, MAX_IMAGES } from './images.js';
import { ingestFiles, inlineImageType, uploadPath, MAX_FILES } from './attachments.js';
import { dataDir as defaultDataDir } from './config.js';

const panelDir = path.join(root, 'panel');
const MIME = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, value) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, '请求体过大')); req.destroy(); } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON 格式错误')); }
    });
    req.once('error', reject);
  });
}

// 下载时的文件名：ASCII 兜底 + RFC 5987 的 UTF-8 文件名，中文名也不会乱码。
function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

function sameToken(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer({ config, sessions, cards, discord, models, scheduler, people, guestUsage, dataDir = defaultDataDir, token, onConfigChange, onShutdown }) {
  const clients = new Set();
  // send_file 不能外发的位置：Claw 数据目录（含令牌与会话记录）、Claude Code 凭据、SSH 密钥。
  const blockedOutgoing = [dataDir, path.join(homedir(), '.claude', '.credentials.json'), path.join(homedir(), '.ssh')];
  const broadcast = payload => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(data);
  };
  sessions.on('event', event => broadcast({ kind: 'session_event', ...event }));
  discord?.on?.('status', status => broadcast({ kind: 'discord_status', status }));
  scheduler?.on('change', schedules => broadcast({ kind: 'schedules', schedules }));
  scheduler?.on('run', run => broadcast({ kind: 'schedule_run', ...run }));

  const state = () => ({
    sessions: sessions.list(),
    cards: cards.list(),
    activeCard: config.card,
    config: publicConfig(config),
    discord: discord?.status?.() || { state: 'disabled' },
    permissions: sessions.pendingPermissions(),
    models: models?.state || null,
    schedules: scheduler?.list() || [],
  });

  const routes = [
    ['GET', /^\/api\/state$/, async () => state()],
    ['GET', /^\/api\/sessions$/, async () => sessions.list()],
    ['POST', /^\/api\/sessions$/, async (req) => sessions.summary(sessions.create({ ...(await readBody(req)), origin: 'panel', surface: 'panel', tier: 'owner' }))],
    ['GET', /^\/api\/sessions\/([\w-]+)$/, async (req, [id]) => ({ session: sessions.summary(sessions.get(id)), transcript: sessions.transcript(id) })],
    ['PATCH', /^\/api\/sessions\/([\w-]+)$/, async (req, [id]) => sessions.summary(sessions.update(id, await readBody(req)))],
    ['DELETE', /^\/api\/sessions\/([\w-]+)$/, async (req, [id]) => { sessions.remove(id); return { ok: true }; }],
    ['POST', /^\/api\/sessions\/([\w-]+)\/reset$/, async (req, [id]) => sessions.summary(sessions.reset(id))],
    ['POST', /^\/api\/sessions\/([\w-]+)\/interrupt$/, async (req, [id]) => { sessions.interrupt(id); return { ok: true }; }],
    ['POST', /^\/api\/sessions\/([\w-]+)\/messages$/, async (req, [id]) => {
      const body = await readBody(req, 320 * 1024 * 1024);
      const meta = sessions.get(id);
      if (meta.origin !== 'panel') throw new HttpError(400, 'Discord 会话只能在 Discord 中发言；面板里可以查看与中断');
      const raw = Array.isArray(body.images) ? body.images : [];
      const rawFiles = Array.isArray(body.files) ? body.files : [];
      if (raw.length > MAX_IMAGES) throw new HttpError(400, `一条消息最多 ${MAX_IMAGES} 张图片`);
      if (rawFiles.length > MAX_FILES) throw new HttpError(400, `一条消息最多 ${MAX_FILES} 个文件`);
      const decode = item => ({ name: String(item.name || ''), buffer: Buffer.from(String(item.base64 || ''), 'base64') });
      const { images, notes } = await ingestImages(dataDir, id, raw.map(decode));
      if (raw.length && !images.length) throw new HttpError(400, notes.join(' ') || '图片处理失败');
      // 面板会话都是主人会话：附件另存到工作目录，方便她用工具处理。
      const { files, documents, notes: fileNotes } = await ingestFiles(dataDir, id, rawFiles.map(decode), { saveDir: path.join(meta.cwd, '.claw-attachments') });
      if (rawFiles.length && !files.length) throw new HttpError(400, fileNotes.join(' ') || '文件处理失败');
      const text = [String(body.text || ''), ...notes, ...fileNotes].filter(Boolean).join('\n');
      if (!text.trim() && !images.length && !files.length) throw new HttpError(400, '消息不能为空');
      // 不等待生成完成：结果通过 SSE 推送。
      sessions.send(id, { text, images, files, documents, from: meta.userName, via: 'panel' }).catch(() => {});
      return { ok: true, images: images.length, files: files.length };
    }],
    // claw MCP 的 send_file：只能给发起调用的会话附文件，且只在本轮进行中有效。
    ['POST', /^\/api\/outbox$/, async (req) => {
      const sessionId = String(req.headers['x-claw-session'] || '');
      if (!sessionId) throw new HttpError(400, '缺少会话标识');
      const body = await readBody(req);
      return sessions.addOutgoingFile(sessionId, body.path, body.name, blockedOutgoing);
    }],
    ['GET', /^\/api\/sessions\/([\w-]+)\/preview$/, async (req, [id], url) => sessions.preview(id, url.searchParams.get('text') || undefined)],
    ['POST', /^\/api\/permissions\/([\w-]+)$/, async (req, [requestId]) => {
      const body = await readBody(req);
      const decision = body.decision === 'deny'
        ? { behavior: 'deny', message: body.message || '用户在面板上拒绝了这次操作。', by: 'panel' }
        : { behavior: 'allow', always: body.decision === 'always', by: 'panel' };
      if (!sessions.resolvePermission(requestId, decision)) throw new HttpError(404, '该审批已结束');
      return { ok: true };
    }],
    ['GET', /^\/api\/discord\/guilds$/, async () => discord?.guildsInfo?.() || []],
    ['GET', /^\/api\/discord\/users$/, async (req, match, url) => {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(id => /^\d{5,25}$/.test(id)).slice(0, 100);
      return discord?.resolveUsers?.(ids) || ids.map(id => ({ id, name: null }));
    }],
    ['PUT', /^\/api\/discord\/access$/, async (req) => {
      const body = await readBody(req);
      const idList = (value, name) => {
        if (!Array.isArray(value) || value.some(id => !/^\d{5,25}$/.test(String(id)))) throw new HttpError(400, `${name} 里有不合法的 ID`);
        return [...new Set(value.map(String))];
      };
      const owners = idList(body.owners, '主人');
      // 主人为空时，启动时会被 allowFrom 顶替，容易误会，所以直接拒绝。
      if (!owners.length) throw new HttpError(400, '至少保留一位主人');
      const allowFrom = idList(body.allowFrom, '私信白名单');
      const policies = ['allowlist', 'open', 'disabled'];
      if (!policies.includes(body.dmPolicy) || !policies.includes(body.groupPolicy)) throw new HttpError(400, '策略只能是 allowlist / open / disabled');
      if (!body.guilds || typeof body.guilds !== 'object' || Array.isArray(body.guilds)) throw new HttpError(400, 'guilds 格式不对');
      const guilds = {};
      for (const [gid, g] of Object.entries(body.guilds)) {
        if (!/^\d{5,25}$/.test(gid) && gid !== '*') throw new HttpError(400, `服务器 ID 不合法：${gid}`);
        // 保留面板不管理的字段（例如 channels），只校验并覆盖这几个。
        const previous = config.discord.guilds?.[gid] || {};
        guilds[gid] = {
          ...previous,
          requireMention: g.requireMention !== false,
          ignoreOtherMentions: g.ignoreOtherMentions === true,
          users: idList(g.users || [], '用户名单'),
          roles: idList(g.roles || [], '身份组名单'),
        };
        if (g.enabled === false) guilds[gid].enabled = false; else delete guilds[gid].enabled;
      }
      for (const [key, value] of [['owners', owners], ['allowFrom', allowFrom], ['dmPolicy', body.dmPolicy], ['groupPolicy', body.groupPolicy], ['guilds', guilds]]) {
        replaceUserConfigValue(['discord', key], value);
        config.discord[key] = structuredClone(value);
      }
      broadcast({ kind: 'state', state: state() });
      return publicConfig(config).discord;
    }],
    ['GET', /^\/api\/guest-usage$/, async () => guestUsage?.list() || []],
    ['POST', /^\/api\/guest-usage\/(\d+)\/reset$/, async (req, [id]) => { guestUsage.reset(id); return guestUsage.status(id); }],
    ['GET', /^\/api\/people$/, async () => people?.list() || []],
    ['PATCH', /^\/api\/people\/(\d+)$/, async (req, [id]) => people.update(id, await readBody(req))],
    ['DELETE', /^\/api\/people\/(\d+)$/, async (req, [id]) => { people.remove(id); return { ok: true }; }],
    ['POST', /^\/api\/people\/(\d+)\/digest$/, async (req, [id]) => { people.get(id); await people.digest(id); return people.view(people.get(id)); }],
    ['GET', /^\/api\/schedules$/, async () => scheduler.list()],
    ['POST', /^\/api\/schedules$/, async (req) => {
      const body = await readBody(req);
      const fromClaude = Boolean(req.headers['x-claw-session']);
      // 模型创建的任务只能绑定到发起调用的会话，不能借机指定别的会话或频道。
      if (fromClaude) body.sessionId = String(req.headers['x-claw-session']);
      const target = body.sessionId ? sessions.get(body.sessionId) : null;
      return scheduler.create({ ...body, notifyUserId: target?.discord?.lastUserId || null }, { createdBy: fromClaude ? 'claude' : 'panel' });
    }],
    ['PATCH', /^\/api\/schedules\/([\w-]+)$/, async (req, [id]) => {
      const body = await readBody(req);
      if (req.headers['x-claw-session']) delete body.sessionId;
      return scheduler.update(id, body);
    }],
    ['DELETE', /^\/api\/schedules\/([\w-]+)$/, async (req, [id]) => { scheduler.remove(id); return { ok: true }; }],
    ['POST', /^\/api\/schedules\/([\w-]+)\/run$/, async (req, [id]) => {
      scheduler.get(id);
      scheduler.run(id, { manual: true }).catch(() => {});
      return { ok: true };
    }],
    ['GET', /^\/api\/models$/, async () => models?.state || null],
    ['POST', /^\/api\/models\/refresh$/, async () => {
      if (!models) throw new HttpError(404, '模型目录不可用');
      await models.refresh();
      await models.reloadChecks();
      broadcast({ kind: 'models', models: models.state });
      return models.state;
    }],
    ['GET', /^\/api\/cards$/, async () => cards.list()],
    ['GET', /^\/api\/cards\/([^/]+)$/, async (req, [id]) => cards.get(decodeURIComponent(id))],
    ['PUT', /^\/api\/cards\/([^/]+)$/, async (req, [id]) => cards.save(decodeURIComponent(id), await readBody(req))],
    ['POST', /^\/api\/cards\/import$/, async (req) => {
      const body = await readBody(req);
      const buffer = Buffer.from(String(body.base64 || ''), 'base64');
      const card = cardFromBuffer(buffer, String(body.filename || ''));
      const id = String(body.id || card.data.name).replace(/[^\w\u4e00-\u9fff.-]/g, '_').slice(0, 60) || 'imported';
      cards.save(id, card);
      // PNG 角色卡本身就是头像。
      if (buffer.subarray(1, 4).toString('latin1') === 'PNG') cards.saveAvatar(id, buffer);
      return { id, card };
    }],
    ['PUT', /^\/api\/config$/, async (req) => {
      const body = await readBody(req);
      const patch = {};
      if (body.card !== undefined) { cards.get(body.card); patch.card = body.card; }
      if (body.user) patch.user = { name: String(body.user.name ?? config.user.name).slice(0, 60) || '开拓者', persona: String(body.user.persona ?? config.user.persona) };
      if (body.prompt) {
        patch.prompt = {};
        for (const key of ['mainPrompt', 'authorNote']) if (body.prompt[key] !== undefined) patch.prompt[key] = String(body.prompt[key]);
        for (const key of ['authorNoteDepth', 'worldInfoScanDepth', 'worldInfoBudgetChars']) {
          if (body.prompt[key] !== undefined) {
            const value = Number(body.prompt[key]);
            if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new HttpError(400, `${key} 必须是非负整数`);
            patch.prompt[key] = value;
          }
        }
      }
      if (body.desktop && body.desktop.notifications !== undefined) patch.desktop = { notifications: body.desktop.notifications === true };
      if (body.discord) {
        const d = body.discord;
        patch.discord = {};
        if (d.reactions !== undefined) patch.discord.reactions = d.reactions === true;
        if (d.guest) {
          const g = d.guest;
          const guest = {};
          if (g.model !== undefined) {
            if (g.model && !/^[\w.[\]-]{1,80}$/.test(g.model)) throw new HttpError(400, '模型名不合法');
            guest.model = String(g.model);
          }
          if (g.effort !== undefined) {
            if (!['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(g.effort)) throw new HttpError(400, 'effort 不合法');
            guest.effort = g.effort;
          }
          if (g.webSearch !== undefined) guest.webSearch = g.webSearch === true;
          if (g.quota) {
            const limit = Number(g.quota.limit);
            if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100000) throw new HttpError(400, '次数上限必须是 0 到 100000 的整数');
            if (!['day', 'week', 'month', 'total'].includes(g.quota.period)) throw new HttpError(400, '周期只能是 day / week / month / total');
            guest.quota = { limit, period: g.quota.period };
          }
          if (g.roles !== undefined) {
            if (!Array.isArray(g.roles) || g.roles.some(id => !/^\d{5,25}$/.test(String(id)))) throw new HttpError(400, '身份组 ID 不合法');
            guest.roles = g.roles.map(String);
          }
          if (g.userLimits !== undefined) {
            const limits = {};
            for (const [id, value] of Object.entries(g.userLimits || {})) {
              if (!/^\d{5,25}$/.test(id) || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new HttpError(400, '单独上限格式不对');
              limits[id] = Number(value);
            }
            guest.userLimits = limits;
          }
          patch.discord.guest = guest;
        }
        if (d.peopleMemory) {
          const pm = d.peopleMemory;
          const memory = {};
          if (pm.enabled !== undefined) memory.enabled = pm.enabled === true;
          if (pm.model !== undefined) memory.model = String(pm.model);
          for (const [key, min, max] of [['digestEvery', 3, 200], ['maxNotes', 1, 20], ['maxPeoplePerTurn', 0, 20]]) {
            if (pm[key] !== undefined) {
              const value = Number(pm[key]);
              if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${key} 必须在 ${min}-${max} 之间`);
              memory[key] = value;
            }
          }
          patch.discord.peopleMemory = memory;
        }
      }
      if (body.agent) {
        patch.agent = {};
        for (const key of ['model', 'effort', 'permissionMode', 'cwd']) if (body.agent[key] !== undefined) patch.agent[key] = String(body.agent[key]);
      }
      saveUserConfig(patch);
      Object.assign(config, merge(config, patch));
      const limits = patch.discord?.guest?.userLimits;
      if (limits) {
        replaceUserConfigValue(['discord', 'guest', 'userLimits'], limits);
        config.discord.guest.userLimits = structuredClone(limits);
      }
      onConfigChange?.(config);
      broadcast({ kind: 'state', state: state() });
      return publicConfig(config);
    }],
    ['POST', /^\/api\/shutdown$/, async () => { setImmediate(() => onShutdown?.('面板请求')); return { ok: true }; }],
    ['POST', /^\/api\/discord\/restart$/, async () => { await discord?.restart?.(); return discord?.status?.() || { state: 'disabled' }; }],
  ];

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      // 防 DNS 重绑定：只接受回环地址的 Host。
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'Host 不允许');
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, name: 'mar7thclaw' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const indexHtml = await readFile(path.join(panelDir, 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'" });
        // 令牌只写进同源页面；其他网页读不到它，也就无法跨站调用 API。
        res.end(indexHtml.replace('__CLAW_TOKEN__', token));
        return;
      }
      const avatar = /^\/avatar\/([^/]+)\.png$/.exec(url.pathname);
      if (req.method === 'GET' && avatar) {
        let file = null;
        try { file = cards.avatarFile(decodeURIComponent(avatar[1])); } catch { /* 非法 ID 按不存在处理 */ }
        if (!file) throw new HttpError(404, '没有头像');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' });
        res.end(await readFile(file));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/panel/')) {
        const file = path.normalize(path.join(panelDir, url.pathname.slice('/panel/'.length)));
        if (!file.startsWith(panelDir + path.sep)) throw new HttpError(404, 'Not found');
        const body = await readFile(file).catch(() => { throw new HttpError(404, 'Not found'); });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(body);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
      const supplied = req.headers['x-claw-token'] || url.searchParams.get('token');
      if (!sameToken(supplied, token)) throw new HttpError(401, '缺少或错误的面板令牌');
      // 聊天记录里的图片（img 标签无法带请求头，所以令牌放在查询参数里）。
      const upload = /^\/api\/uploads\/([\w-]+)\/([\w.-]+\.(?:jpg|png|webp))$/.exec(url.pathname);
      if (req.method === 'GET' && upload) {
        const file = path.join(dataDir, 'uploads', upload[1], upload[2]);
        const body = await readFile(file).catch(() => { throw new HttpError(404, '图片不存在'); });
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' });
        res.end(body);
        return;
      }
      // 聊天记录里的附件：对方发来的（in）与她发出的（out）。只有常见图片按图片内联显示，其余一律当作下载，
      // 避免 HTML/SVG 之类的文件在面板同源下被当成网页执行。
      const stored = /^\/api\/files\/([\w-]+)\/(in|out)\/([\w.-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && stored) {
        const body = await readFile(uploadPath(dataDir, stored.slice(1).join('/'))).catch(() => { throw new HttpError(404, '文件不存在'); });
        const name = (url.searchParams.get('name') || stored[3]).slice(0, 200);
        const image = url.searchParams.get('inline') === '1' ? inlineImageType(stored[3]) : '';
        res.writeHead(200, {
          'content-type': image || 'application/octet-stream',
          'content-disposition': contentDisposition(image ? 'inline' : 'attachment', name),
          'cache-control': 'private, max-age=31536000, immutable',
        });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ kind: 'state', state: state() })}\n\n`);
        clients.add(res);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
        return;
      }
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = pattern.exec(url.pathname);
        if (match) return json(res, 200, await handler(req, match.slice(1), url));
      }
      throw new HttpError(404, '接口不存在');
    } catch (error) {
      json(res, error.status || 500, { error: error.status ? error.message : `内部错误：${error.message}` });
    }
  });
  server.broadcast = broadcast;
  server.closeClients = () => { for (const res of clients) res.end(); clients.clear(); };
  return server;
}
