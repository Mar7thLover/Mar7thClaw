(function () {
  const token = document.querySelector('meta[name="claw-token"]').content;
  const $ = id => document.getElementById(id);
  const desktop = window.clawDesktop || null;
  if (desktop) document.body.classList.add('desktop');

  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式下忽略 */ } },
  };

  const state = {
    sessions: [], cards: [], config: null, discord: { state: 'disabled' }, activeCard: '',
    current: store.get('claw.current', null), models: null, schedules: [], editingSchedule: null, transcript: [], live: new Map(), permissions: new Map(), cardData: null,
  };

  async function api(method, url, body) {
    const res = await fetch(url, { method, headers: { 'content-type': 'application/json', 'x-claw-token': token }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return node;
  };

  const TOOL_LABELS = { ToolSearch: '加载工具', mcp__claw__schedule_create: '登记定时任务', mcp__claw__schedule_list: '查看定时任务', mcp__claw__schedule_update: '修改定时任务', mcp__claw__schedule_delete: '删除定时任务', Bash: '运行命令', PowerShell: '运行命令', Read: '读取文件', Write: '写入文件', Edit: '修改文件', MultiEdit: '修改文件', Glob: '查找文件', Grep: '搜索内容', WebFetch: '读取网页', WebSearch: '上网搜索', Task: '派出帮手', Agent: '派出帮手', TodoWrite: '整理待办', NotebookEdit: '修改笔记本' };
  const toolDetail = input => {
    if (!input || typeof input !== 'object') return '';
    return String(input.title || input.command || input.file_path || input.pattern || input.url || input.query || input.description || input.prompt || '').replace(/\s+/g, ' ').slice(0, 140);
  };

  // ---------------- 状态栏 ----------------
  function renderStatus(online) {
    $('core-dot').className = `dot ${online ? 'ok' : 'bad'}`;
    $('core-text').textContent = online ? '在线' : '核心未连接';
    const d = state.discord || {};
    const map = { ready: ['ok', 'Discord 在线'], connecting: ['warn', 'Discord 连接中'], reconnecting: ['warn', 'Discord 重连中'], error: ['bad', 'Discord 出错'], disabled: ['', 'Discord 未启用'], stopped: ['', 'Discord 已停止'] };
    const [cls, text] = map[d.state] || ['', 'Discord'];
    $('discord-dot').className = `dot ${cls}`;
    $('discord-text').textContent = text;
    $('discord-text').title = d.error || (d.user ? d.user.tag : '');
    const card = state.cards.find(c => c.id === state.activeCard);
    if (card) $('char-name').textContent = card.name;
    $('avatar').classList.toggle('online', online);
    setAvatar(state.activeCard);
  }

  let avatarFor = null;
  function setAvatar(cardId, force = false) {
    if (!cardId || (cardId === avatarFor && !force)) return;
    avatarFor = cardId;
    const img = $('avatar-img');
    img.onload = () => { img.hidden = false; desktop?.avatarChanged?.(cardId); };
    img.onerror = () => { img.hidden = true; };
    img.src = `/avatar/${encodeURIComponent(cardId)}.png?t=${Date.now()}`;
  }

  // ---------------- 会话列表 ----------------
  function renderSessions() {
    const panel = $('panel-sessions');
    const discord = $('discord-sessions');
    panel.replaceChildren();
    discord.replaceChildren();
    for (const s of state.sessions) {
      const li = el('li', { class: s.id === state.current ? 'active' : '', onclick: () => selectSession(s.id), title: s.cwd },
        s.busy ? el('span', { class: 'busy-dot' }) : null,
        el('span', { class: 's-title' }, s.title),
        s.tier === 'guest' ? el('span', { class: 's-badge' }, '访客') : null,
        el('button', { class: 's-del', title: '删除会话', onclick: event => { event.stopPropagation(); removeSession(s); } }, '✕'));
      (s.origin === 'discord' ? discord : panel).append(li);
    }
    if (!discord.children.length) discord.append(el('li', { class: 's-badge' }, '还没有 Discord 会话'));
  }

  async function removeSession(s) {
    if (!confirm(`删除会话「${s.title}」？聊天记录会一起删除（Claude Code 自己的会话文件保留）。`)) return;
    await api('DELETE', `/api/sessions/${s.id}`).catch(e => toast(e.message));
  }

  function currentSession() {
    return state.sessions.find(s => s.id === state.current) || null;
  }

  async function selectSession(id) {
    state.current = id;
    store.set('claw.current', id);
    renderSessions();
    if (!id) { state.transcript = []; renderChat(); return; }
    try {
      const data = await api('GET', `/api/sessions/${id}`);
      if (state.current !== id) return;
      state.transcript = data.transcript;
      renderChat();
      renderSessionBar();
    } catch (error) {
      toast(error.message);
    }
    if (window.innerWidth <= 640) $('sidebar').classList.add('collapsed');
  }

  // ---------------- 模型列表 ----------------
  const GROUPS = [['menu', '当前账号菜单'], ['alias', '别名'], ['full', '完整模型 ID'], ['legacy', '旧版模型']];
  function modelLabel(m) {
    const mark = m.status === 'verified' ? ' ✓' : m.status === 'failed' ? ' ✗ 最近验证失败' : m.status === 'model-mismatch' ? ` ≠ 实际会换成 ${m.actualModel}` : m.group === 'legacy' ? '（未验证）' : '';
    return `${m.label}${mark}`;
  }
  function fillModelSelect(select, current) {
    const models = state.models?.models || [];
    const nodes = [el('option', { value: '' }, '默认（跟随 Claude Code）')];
    nodes[0].dataset.label = '默认';
    nodes[0].dataset.hint = '跟随 Claude Code 的默认模型';
    for (const [group, title] of GROUPS) {
      const items = models.filter(m => m.group === group);
      if (items.length) nodes.push(el('optgroup', { label: title }, items.map(m => {
        const option = el('option', { value: m.id }, modelLabel(m));
        option.dataset.label = m.label.replace(/（[^）]*）$/, '');
        const hint = m.group === 'legacy' ? m.id : m.resolvedModel !== m.id && !m.label.includes(m.resolvedModel) ? m.resolvedModel : '';
        if (hint) option.dataset.hint = hint;
        const badge = m.status === 'verified' ? ['可用', 'ok'] : m.status === 'model-mismatch' ? [`实为 ${m.actualModel}`, 'warn'] : m.status === 'failed' ? ['失败', 'bad'] : m.group === 'legacy' ? ['未验证', ''] : null;
        if (badge) { option.dataset.badge = badge[0]; if (badge[1]) option.dataset.tone = badge[1]; }
        return option;
      })));
    }
    if (current && !models.some(m => m.id === current)) nodes.push(el('option', { value: current }, `${current}（自定义）`));
    select.replaceChildren(...nodes);
    select.value = current || '';
  }
  function effortsFor(modelId) {
    const m = (state.models?.models || []).find(x => x.id === (modelId || 'default'));
    return m ? m.effortLevels : ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  function fillEffortSelect(modelId, current) {
    const levels = effortsFor(modelId);
    $('opt-effort').replaceChildren(el('option', { value: '' }, levels.length ? '默认' : '不支持'), ...levels.map(l => el('option', { value: l }, l)));
    $('opt-effort').value = levels.includes(current) ? current : '';
    return levels.length > 0;
  }
  $('models-refresh').addEventListener('click', async () => {
    toast('正在读取模型列表…');
    try { state.models = await api('POST', '/api/models/refresh'); renderSessionBar(); toast(`共 ${state.models.models.length} 个模型${state.models.error ? `（${state.models.error}）` : ''}`); } catch (error) { toast(error.message); }
  });

  function renderSessionBar() {
    const s = currentSession();
    $('session-title').textContent = s ? s.title : '还没有会话，点「新委托」开始吧';
    $('session-meta').textContent = s ? `${s.origin === 'discord' ? 'Discord · ' : ''}${s.tier === 'guest' ? '访客（仅聊天）' : s.cwd} · ${s.stats.turns} 轮 · $${(s.stats.costUsd || 0).toFixed(4)}` : '';
    fillModelSelect($('opt-model'), s?.model || '');
    const effortSupported = fillEffortSelect(s?.model || '', s?.effort || '');
    $('opt-mode').value = s?.permissionMode || 'auto';
    const readOnly = !s || s.origin === 'discord';
    for (const id of ['opt-model', 'opt-effort', 'opt-mode']) $(id).disabled = !s || s.tier === 'guest';
    if (!effortSupported) $('opt-effort').disabled = true;
    $('input').disabled = readOnly;
    $('send-btn').disabled = readOnly;
    $('attach-btn').disabled = readOnly;
    $('composer-note').classList.toggle('hidden', !s || s.origin !== 'discord');
    $('composer-note').textContent = 'Discord 会话只能在 Discord 里发言；这里可以查看进度、审批权限和中断任务。';
    $('stop-btn').classList.toggle('hidden', !s?.busy);
    $('send-btn').classList.toggle('hidden', Boolean(s?.busy) && readOnly);
  }

  // ---------------- 消息渲染 ----------------
  function toolNode(tool, running) {
    const stateClass = tool.result === undefined ? (running ? 'run' : '') : tool.isError ? 'err' : 'ok';
    const stateText = tool.result === undefined ? (running ? '…' : '') : tool.isError ? '✗' : '✓';
    return el('details', { class: 'tool' },
      el('summary', {}, el('span', { class: `t-state ${stateClass}` }, stateText), el('span', { class: 't-name' }, TOOL_LABELS[tool.name] || tool.name), el('span', { class: 't-detail' }, toolDetail(tool.input))),
      el('pre', {}, JSON.stringify(tool.input, null, 2)),
      tool.result !== undefined ? el('pre', {}, tool.result || '（无输出）') : null);
  }

  function assistantNode(entry, live) {
    const name = (state.cards.find(c => c.id === currentSession()?.card) || {}).name || '三月七';
    const body = el('div', { class: `content${live ? ' typing' : ''}` });
    body.innerHTML = window.renderMarkdown(entry.text || '');
    const tools = entry.tools?.length ? el('div', { class: 'tools' }, entry.tools.map(t => toolNode(t, live))) : null;
    const thinking = entry.thinking ? el('details', { class: 'thinking' }, el('summary', {}, '思考过程'), el('pre', {}, entry.thinking)) : null;
    const foot = [];
    if (entry.activated?.length) foot.push(el('span', { class: 'lore-tags' }, `📖 ${entry.activated.map(a => a.name).join('、')}`));
    if (entry.durationMs) foot.push(el('span', {}, `${(entry.durationMs / 1000).toFixed(1)}s`));
    if (typeof entry.costUsd === 'number') foot.push(el('span', {}, `$${entry.costUsd.toFixed(4)}`));
    if (entry.interrupted) foot.push(el('span', {}, '已中断'));
    if (entry.error && !entry.interrupted) foot.push(el('span', { style: 'color: var(--danger)' }, entry.error));
    return el('div', { class: `msg assistant${entry.error && !entry.interrupted ? ' error' : ''}` },
      el('div', { class: 'from' }, entry.greeting ? `${name} · 开场白` : name), thinking, tools, body,
      foot.length ? el('div', { class: 'msg-foot' }, foot) : null);
  }

  function entryNode(entry) {
    if (entry.kind === 'user') {
      const body = el('div', { class: 'content' });
      const onlyImages = entry.images?.length && /^（发来了 \d+ 张图片）$/.test(entry.text);
      if (!onlyImages) body.innerHTML = window.renderMarkdown(entry.text);
      const images = entry.images?.length ? el('div', { class: `msg-images${entry.images.length > 2 ? ' many' : ''}` }, entry.images.map(image => {
        const src = `/api/uploads/${image.file}?token=${encodeURIComponent(token)}`;
        return el('img', { src, alt: '图片', loading: 'lazy', onclick: () => openLightbox(src) });
      })) : null;
      return el('div', { class: 'msg user' }, el('div', { class: 'from' }, `${entry.from}${entry.via && entry.via !== 'panel' ? ` · ${entry.via}` : ''}`), images, onlyImages ? null : body);
    }
    if (entry.kind === 'assistant') return assistantNode(entry, false);
    if (entry.kind === 'divider') return el('div', { class: 'divider' }, entry.text);
    return el('div', { class: 'notice' }, entry.text || '');
  }

  function renderChat() {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...state.transcript.map(entryNode));
    const live = state.live.get(state.current);
    if (live) box.append(assistantNode(live, true));
    if (!state.transcript.length && !live) box.append(el('div', { class: 'notice' }, state.current ? '还没有消息。' : '点左上角「新委托」开始~'));
    if (nearBottom || live) box.scrollTop = box.scrollHeight;
    renderPermissions();
  }

  let liveFrame = 0;
  function scheduleLiveRender() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(() => { liveFrame = 0; renderChat(); });
  }

  // ---------------- 权限审批 ----------------
  function renderPermissions() {
    const box = $('permissions');
    box.replaceChildren();
    for (const p of state.permissions.values()) {
      const session = state.sessions.find(s => s.id === p.sessionId);
      const r = p.request;
      const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
      const decide = decision => api('POST', `/api/permissions/${r.requestId}`, { decision }).catch(e => toast(e.message));
      box.append(el('div', { class: 'perm-card' },
        el('h4', {}, `需要确认：${r.displayName}${session && session.id !== state.current ? `（${session.title}）` : ''}`),
        r.description ? el('div', {}, r.description) : null,
        el('pre', {}, typeof r.input?.command === 'string' ? r.input.command : JSON.stringify(r.input, null, 2)),
        r.reason ? el('div', { class: 'reason' }, r.reason) : null,
        el('div', { class: 'perm-actions' },
          el('button', { class: 'allow', onclick: () => decide('allow') }, '允许'),
          r.canAlwaysAllow ? el('button', { onclick: () => decide('always') }, '本会话都允许') : null,
          el('button', { class: 'danger', onclick: () => decide('deny') }, '拒绝'),
          el('span', { class: 'timer' }, `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后自动拒绝`))));
    }
  }
  setInterval(() => { if (state.permissions.size) renderPermissions(); }, 1000);

  // ---------------- 事件流 ----------------
  function applyState(s) {
    state.sessions = s.sessions;
    state.cards = s.cards;
    state.activeCard = s.activeCard;
    state.config = s.config;
    state.discord = s.discord;
    if (s.models) state.models = s.models;
    state.schedules = s.schedules || [];
    renderSchedules();
    state.permissions = new Map(s.permissions.map(p => [p.request.requestId, p]));
    if (state.current && !state.sessions.some(x => x.id === state.current)) state.current = null;
    if (!state.current && state.sessions.length) state.current = (state.sessions.find(x => x.origin === 'panel') || state.sessions[0]).id;
    renderSessions();
    renderStatus(true);
    renderSessionBar();
    if (state.current) selectSession(state.current); else renderChat();
  }

  function onSessionEvent(e) {
    const id = e.sessionId;
    if (e.type === 'session') {
      const i = state.sessions.findIndex(s => s.id === id);
      if (i >= 0) state.sessions[i] = e.session; else state.sessions.unshift(e.session);
      state.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      renderSessions();
      if (id === state.current) renderSessionBar();
      return;
    }
    if (e.type === 'session_removed') {
      state.sessions = state.sessions.filter(s => s.id !== id);
      if (state.current === id) selectSession(state.sessions[0]?.id || null);
      renderSessions();
      return;
    }
    if (e.type === 'permission_open') { state.permissions.set(e.request.requestId, { sessionId: id, request: e.request, expiresAt: e.expiresAt }); renderPermissions(); if (desktop) desktop.attention(); return; }
    if (e.type === 'permission_closed') { state.permissions.delete(e.requestId); renderPermissions(); return; }
    let live = state.live.get(id);
    if (e.type === 'turn_start') { state.live.set(id, { text: '', thinking: '', tools: [], activated: [] }); }
    else if (!live) { if (e.type === 'entry' && id === state.current) { state.transcript.push(e.entry); renderChat(); } return; }
    live = state.live.get(id);
    switch (e.type) {
      case 'prompt_info': live.activated = e.activated.filter(a => a.reason !== 'constant'); break;
      case 'segment': if (live.text && !live.text.endsWith('\n\n')) live.text += '\n\n'; break;
      case 'text': live.text += e.text; break;
      case 'thinking': live.thinking += e.text; break;
      case 'tool_use': live.tools.push({ id: e.id, name: e.name, input: e.input }); break;
      case 'tool_result': { const t = live.tools.find(x => x.id === e.id); if (t) { t.result = e.text; t.isError = e.isError; } break; }
      case 'entry':
        if (e.entry.kind === 'assistant' && e.entry.turnId) {
          e.entry.activated = live.activated;
          state.live.delete(id);
          const s = state.sessions.find(x => x.id === id);
          if (desktop && !document.hasFocus()) desktop.notify(`三月七 · ${s?.title || '任务'}`, (e.entry.text || e.entry.error || '完成了').replace(/[`*#>]/g, '').slice(0, 120));
        }
        if (id === state.current) state.transcript.push(e.entry);
        break;
      case 'turn_end': state.live.delete(id); break;
      default: break;
    }
    if (id === state.current) scheduleLiveRender();
  }

  function connect() {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = message => {
      const data = JSON.parse(message.data);
      if (data.kind === 'state') applyState(data.state);
      else if (data.kind === 'models') { state.models = data.models; renderSessionBar(); }
      else if (data.kind === 'schedules') { state.schedules = data.schedules; renderSchedules(); }
      else if (data.kind === 'schedule_run') onScheduleRun(data);
      else if (data.kind === 'discord_status') { state.discord = data.status; renderStatus(true); }
      else if (data.kind === 'session_event') onSessionEvent(data);
    };
    source.onerror = () => { renderStatus(false); };
    source.onopen = () => renderStatus(true);
  }

  // ---------------- 输入 ----------------
  $('composer').addEventListener('submit', async event => {
    event.preventDefault();
    const text = $('input').value.trim();
    if (!text && !pendingImages.length) return;
    let s = currentSession();
    const images = pendingImages.slice();
    try {
      if (!s) { s = await api('POST', '/api/sessions', {}); state.sessions.unshift(s); await selectSession(s.id); }
      $('input').value = '';
      autosize();
      pendingImages = [];
      renderAttachTray();
      if (images.length) toast(`正在发送 ${images.length} 张图片…`);
      await api('POST', `/api/sessions/${s.id}/messages`, { text, images: images.map(image => ({ name: image.name, base64: image.base64 })) });
    } catch (error) {
      toast(error.message);
      if (!pendingImages.length) { pendingImages = images; renderAttachTray(); }
    }
  });
  // ---------------- 图片附件 ----------------
  const MAX_IMAGES = 6;
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
  let pendingImages = [];
  function renderAttachTray() {
    const tray = $('attach-tray');
    tray.classList.toggle('hidden', !pendingImages.length);
    tray.replaceChildren(...pendingImages.map((image, index) => el('div', { class: 'attach-item', title: image.name },
      el('img', { src: image.preview, alt: image.name }),
      el('span', { class: 'attach-size' }, image.size > 1048576 ? `${(image.size / 1048576).toFixed(1)}MB` : `${Math.ceil(image.size / 1024)}KB`),
      el('button', { type: 'button', title: '移除', 'aria-label': `移除 ${image.name}`, onclick: () => { pendingImages.splice(index, 1); renderAttachTray(); } }, '✕'))));
  }
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
  }
  async function addImages(files) {
    const s = currentSession();
    if (s && s.origin === 'discord') { toast('Discord 会话只能在 Discord 里发图'); return; }
    for (const file of files) {
      if (!file.type.startsWith('image/')) { toast(`${file.name || '文件'} 不是图片`); continue; }
      if (pendingImages.length >= MAX_IMAGES) { toast(`一条消息最多 ${MAX_IMAGES} 张图片`); break; }
      if (file.size > MAX_IMAGE_BYTES) { toast(`${file.name} 超过 25MB`); continue; }
      const dataUrl = await readAsDataUrl(file);
      pendingImages.push({ name: file.name || `粘贴的图片.${file.type.split('/')[1] || 'png'}`, size: file.size, preview: dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    }
    renderAttachTray();
    $('input').focus();
  }
  $('attach-btn').addEventListener('click', () => $('attach-input').click());
  $('attach-input').addEventListener('change', () => { addImages([...$('attach-input').files]); $('attach-input').value = ''; });
  $('input').addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); addImages(files); }
  });
  const composer = $('composer');
  composer.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); composer.classList.add('dragging'); } });
  composer.addEventListener('dragleave', event => { if (!composer.contains(event.relatedTarget)) composer.classList.remove('dragging'); });
  composer.addEventListener('drop', event => {
    composer.classList.remove('dragging');
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    addImages([...event.dataTransfer.files]);
  });
  // 窗口其他地方误拖放时不要让 Electron/浏览器直接打开文件。
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());

  function openLightbox(src) {
    $('lightbox-img').src = src;
    $('lightbox').classList.remove('hidden');
  }
  $('lightbox').addEventListener('click', () => $('lightbox').classList.add('hidden'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') $('lightbox').classList.add('hidden'); });

  // 输入框随内容自动长高（最多 200px），发送清空后复原。
  function autosize() {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
  $('input').addEventListener('input', autosize);
  new MutationObserver(autosize).observe($('input'), { attributes: true, attributeFilter: ['disabled'] });

  $('input').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  $('stop-btn').addEventListener('click', () => { const s = currentSession(); if (s) api('POST', `/api/sessions/${s.id}/interrupt`).then(() => toast('已请求中断')).catch(e => toast(e.message)); });
  for (const [id, key] of [['opt-model', 'model'], ['opt-effort', 'effort'], ['opt-mode', 'permissionMode']]) {
    $(id).addEventListener('change', () => {
      const s = currentSession();
      if (!s) return;
      if (key === 'model') fillEffortSelect($(id).value, $('opt-effort').value);
      api('PATCH', `/api/sessions/${s.id}`, { [key]: $(id).value }).then(() => toast('已更新，下一轮生效')).catch(e => { toast(e.message); renderSessionBar(); });
    });
  }

  $('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
  if (store.get('claw.sidebarCollapsed', window.innerWidth <= 640)) $('sidebar').classList.add('collapsed');
  new MutationObserver(() => store.set('claw.sidebarCollapsed', $('sidebar').classList.contains('collapsed'))).observe($('sidebar'), { attributes: true });

  $('new-session-btn').addEventListener('click', () => {
    $('ns-title').value = '';
    $('ns-cwd').value = state.config?.agent?.cwd || '';
    $('new-session-dialog').showModal();
  });
  $('new-session-dialog').addEventListener('close', async () => {
    if ($('new-session-dialog').returnValue !== 'ok') return;
    try {
      const s = await api('POST', '/api/sessions', { title: $('ns-title').value.trim() || undefined, cwd: $('ns-cwd').value.trim() || undefined });
      if (!state.sessions.some(x => x.id === s.id)) state.sessions.unshift(s);
      await selectSession(s.id);
      $('input').focus();
    } catch (error) { toast(error.message); }
  });

  // ---------------- 定时任务 ----------------
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const fmt = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  function renderSchedules() {
    const box = $('schedule-list');
    box.replaceChildren();
    for (const job of state.schedules) {
      const failed = job.lastResult && !job.lastResult.ok;
      const done = !job.enabled && job.schedule.type === 'once' && job.lastRunAt;
      box.append(el('li', { class: `schedule-item${job.enabled ? '' : ' paused'}`, title: job.prompt, onclick: () => openSchedule(job) },
        el('div', { class: 'sc-line' }, job.running ? el('span', { class: 'busy-dot' }) : el('span', { class: 'sc-icon' }, job.enabled ? '⏰' : done ? '✓' : '⏸'), el('span', { class: 's-title' }, job.title)),
        el('div', { class: 'sc-when' }, job.enabled ? `${job.description} · 下次 ${fmt(job.nextRunAt)}` : done ? `已完成 · ${fmt(job.lastRunAt)}` : `已暂停 · ${job.description}`, failed ? el('span', { class: 'sc-fail' }, ' · 上次失败') : null)));
    }
    if (!state.schedules.length) box.append(el('li', { class: 's-badge' }, '还没有定时任务'));
  }

  function onScheduleRun(run) {
    if (run.phase !== 'end') return;
    const text = `定时任务「${run.job.title}」${run.ok ? '完成' : '失败'}`;
    toast(text);
    if (desktop) desktop.notify(`⏰ ${run.job.title}`, (run.job.lastResult?.text || text).replace(/[`*#>]/g, '').slice(0, 120));
  }

  // 把 cron 反解回界面上的选项；认不出的归为自定义。
  function scheduleToForm(schedule) {
    if (schedule.type === 'interval') return { kind: 'interval', minutes: schedule.everyMinutes };
    if (schedule.type === 'once') {
      const d = new Date(schedule.at);
      return { kind: 'once', at: new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) };
    }
    const m = /^(\d+) (\d+) \* \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(schedule.cron.trim());
    if (!m) return { kind: 'cron', cron: schedule.cron };
    const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
    if (m[3] === '*') return { kind: 'daily', time };
    if (m[3] === '1-5') return { kind: 'weekdays', time };
    return { kind: 'weekly', time, days: m[3].split(',').map(Number) };
  }

  function formToSchedule() {
    const kind = $('sc-kind').value;
    const [h, m] = ($('sc-time').value || '09:00').split(':').map(Number);
    if (kind === 'daily') return { cron: `${m} ${h} * * *` };
    if (kind === 'weekdays') return { cron: `${m} ${h} * * 1-5` };
    if (kind === 'weekly') {
      const days = [...document.querySelectorAll('#sc-weekdays input:checked')].map(i => i.value);
      if (!days.length) throw new Error('至少选一天');
      return { cron: `${m} ${h} * * ${days.join(',')}` };
    }
    if (kind === 'interval') return { everyMinutes: Number($('sc-minutes').value) };
    if (kind === 'once') {
      if (!$('sc-at').value) throw new Error('请选择日期时间');
      return { at: $('sc-at').value };
    }
    return { cron: $('sc-cron').value.trim() };
  }

  function showScheduleFields() {
    const kind = $('sc-kind').value;
    for (const node of document.querySelectorAll('.sc-field')) node.hidden = !node.dataset.kinds.split(' ').includes(kind);
  }
  $('sc-kind').addEventListener('change', showScheduleFields);
  $('sc-weekdays').replaceChildren(...[1, 2, 3, 4, 5, 6, 0].map(d => el('label', { title: `周${WEEK[d]}` }, el('input', { type: 'checkbox', value: String(d) }), el('span', {}, WEEK[d]))));

  function openSchedule(job = null) {
    state.editingSchedule = job;
    $('sc-heading').textContent = job ? '编辑定时任务' : '新建定时任务';
    $('sc-title').value = job?.title || '';
    $('sc-prompt').value = job?.prompt || '';
    const form = job ? scheduleToForm(job.schedule) : { kind: 'daily', time: '09:00' };
    $('sc-kind').value = form.kind;
    $('sc-time').value = form.time || '09:00';
    $('sc-minutes').value = form.minutes || 60;
    const offset = new Date().getTimezoneOffset() * 60000;
    $('sc-at').value = form.at || new Date(Date.now() + 3600000 - offset).toISOString().slice(0, 16);
    $('sc-cron').value = form.cron || '';
    for (const input of document.querySelectorAll('#sc-weekdays input')) input.checked = (form.days || [1]).includes(Number(input.value));
    const owners = state.sessions.filter(s => s.tier === 'owner');
    const first = el('option', { value: '' }, '新建一个专用会话');
    first.dataset.hint = '第一次运行时自动创建，之后一直复用';
    const options = [first];
    for (const s of owners) {
      const option = el('option', { value: s.id }, s.title);
      option.dataset.hint = s.origin === 'discord' ? `Discord · ${s.discord?.label || ''}` : '面板';
      options.push(option);
    }
    if (job?.sessionId && !owners.some(s => s.id === job.sessionId)) options.push(el('option', { value: job.sessionId }, '（原会话已删除，运行时会新建）'));
    $('sc-session').replaceChildren(...options);
    $('sc-session').value = job ? job.sessionId || '' : (currentSession()?.tier === 'owner' ? currentSession().id : '');
    $('sc-enabled').checked = job ? job.enabled : true;
    $('sc-delete').classList.toggle('hidden', !job);
    $('sc-run').classList.toggle('hidden', !job);
    const status = [];
    if (job) {
      status.push(`${job.description}；下次 ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '—'}；已运行 ${job.runs} 次；由${job.createdBy === 'claude' ? '三月七在对话中' : '面板'}创建`);
      if (job.lastResult) status.push(`上次（${new Date(job.lastResult.at).toLocaleString('zh-CN', { hour12: false })}）${job.lastResult.ok ? '成功' : '失败'}：${job.lastResult.error || job.lastResult.text || ''}`);
    }
    $('sc-status').textContent = status.join('\n');
    showScheduleFields();
    $('schedule-dialog').showModal();
  }

  $('new-schedule-btn').addEventListener('click', () => openSchedule(null));
  $('schedule-form').addEventListener('submit', async event => {
    if (event.submitter?.value !== 'ok') return;
    event.preventDefault();
    const job = state.editingSchedule;
    try {
      const body = { title: $('sc-title').value.trim(), prompt: $('sc-prompt').value.trim(), ...formToSchedule(), sessionId: $('sc-session').value || null, enabled: $('sc-enabled').checked };
      if (job) await api('PATCH', `/api/schedules/${job.id}`, body);
      else await api('POST', '/api/schedules', body);
      $('schedule-dialog').close();
      toast(job ? '已保存' : '定时任务已创建');
    } catch (error) { toast(error.message); }
  });
  $('sc-delete').addEventListener('click', async () => {
    const job = state.editingSchedule;
    if (!job || !confirm(`删除定时任务「${job.title}」？`)) return;
    try { await api('DELETE', `/api/schedules/${job.id}`); $('schedule-dialog').close(); toast('已删除'); } catch (error) { toast(error.message); }
  });
  $('sc-run').addEventListener('click', async () => {
    const job = state.editingSchedule;
    try { await api('POST', `/api/schedules/${job.id}/run`); $('schedule-dialog').close(); toast('已开始运行'); } catch (error) { toast(error.message); }
  });

  // ---------------- 桌面壳 ----------------
  if (desktop) {
    desktop.isPinned().then(pinned => $('pin-btn').classList.toggle('on', pinned));
    $('pin-btn').addEventListener('click', async () => $('pin-btn').classList.toggle('on', await desktop.togglePin()));
    $('hide-btn').addEventListener('click', () => desktop.hide());
    $('expand-btn').addEventListener('click', () => desktop.openInBrowser());
  }

  // ---------------- 设置 ----------------
  const CARD_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'];
  let editingCardId = null;

  function showTab(name) {
    for (const b of document.querySelectorAll('#settings-tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of document.querySelectorAll('section[data-panel]')) p.hidden = p.dataset.panel !== name;
    if (name === 'inspect') runInspect();
    if (name === 'discord') renderDiscordInfo();
    if (name === 'guest') loadGuest();
    if (name === 'people') loadPeople();
  }
  for (const b of document.querySelectorAll('#settings-tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());

  $('settings-btn').addEventListener('click', async () => {
    const select = $('card-select');
    select.replaceChildren(...state.cards.map(c => el('option', { value: c.id }, `${c.name}${c.id === state.activeCard ? '（默认）' : ''}`)));
    select.value = state.activeCard;
    await loadCard(state.activeCard);
    const c = state.config;
    $('pf-user-name').value = c.user.name;
    $('pf-persona').value = c.user.persona;
    $('pf-author-note').value = c.prompt.authorNote;
    $('pf-an-depth').value = c.prompt.authorNoteDepth;
    $('pf-main').value = c.prompt.mainPrompt;
    $('pf-scan').value = c.prompt.worldInfoScanDepth;
    $('pf-budget').value = c.prompt.worldInfoBudgetChars;
    $('pf-cwd').value = c.agent.cwd;
    $('pf-mode').value = c.agent.permissionMode;
    fillModelSelect($('pf-model'), c.agent.model || '');
    $('pf-session-note').value = currentSession()?.authorNote || '';
    $('pf-session-note').disabled = !currentSession();
    showTab('card');
    $('settings-dialog').showModal();
  });

  async function loadCard(id) {
    editingCardId = id;
    const card = await api('GET', `/api/cards/${encodeURIComponent(id)}`);
    state.cardData = card;
    for (const f of CARD_FIELDS) $(`cf-${f}`).value = card.data[f] || '';
    $('cf-depth_prompt').value = card.data.extensions?.depth_prompt?.prompt || '';
    $('cf-depth').value = card.data.extensions?.depth_prompt?.depth ?? 4;
    renderLore();
  }
  $('card-select').addEventListener('change', () => loadCard($('card-select').value).catch(e => toast(e.message)));

  function collectCard() {
    const card = structuredClone(state.cardData);
    for (const f of CARD_FIELDS) card.data[f] = $(`cf-${f}`).value;
    card.data.extensions = card.data.extensions || {};
    card.data.extensions.depth_prompt = { ...(card.data.extensions.depth_prompt || {}), prompt: $('cf-depth_prompt').value, depth: Number($('cf-depth').value || 4), role: card.data.extensions.depth_prompt?.role || 'system' };
    return card;
  }

  $('card-save').addEventListener('click', async () => {
    try {
      state.cardData = await api('PUT', `/api/cards/${encodeURIComponent(editingCardId)}`, collectCard());
      toast('角色卡已保存（下一轮生效）');
    } catch (error) { toast(error.message); }
  });
  $('card-activate').addEventListener('click', async () => {
    try { await api('PUT', '/api/config', { card: $('card-select').value }); toast('已设为默认角色卡（新会话生效）'); } catch (error) { toast(error.message); }
  });
  $('card-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(collectCard(), null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${editingCardId}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('card-import').addEventListener('change', async () => {
    const file = $('card-import').files[0];
    if (!file) return;
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    try {
      const result = await api('POST', '/api/cards/import', { filename: file.name, base64: btoa(binary) });
      state.cards = await api('GET', '/api/cards');
      $('card-select').replaceChildren(...state.cards.map(c => el('option', { value: c.id }, c.name)));
      $('card-select').value = result.id;
      await loadCard(result.id);
      if (result.id === state.activeCard) setAvatar(result.id, true);
      toast(`已导入「${result.card.data.name}」`);
    } catch (error) { toast(error.message); }
    $('card-import').value = '';
  });

  // 世界书编辑
  const POSITIONS = [['0', '角色描述前'], ['1', '角色描述后'], ['2', '作者注释前'], ['3', '作者注释后'], ['4', '指定深度'], ['5', '示例前'], ['6', '示例后']];
  function renderLore() {
    const list = $('lore-list');
    list.replaceChildren();
    const entries = state.cardData.data.character_book.entries;
    entries.forEach((entry, index) => {
      const bind = (node, apply) => { node.addEventListener('input', () => apply(node)); node.addEventListener('change', () => apply(node)); return node; };
      const position = el('select', {}, POSITIONS.map(([v, t]) => el('option', { value: v }, t)));
      position.value = String(entry.extensions.position ?? 1);
      list.append(el('div', { class: 'lore-entry' },
        el('div', { class: 'row' },
          bind(el('input', { class: 'grow', value: entry.name, placeholder: '条目名' }), n => { entry.name = n.value; }),
          el('label', {}, bind(el('input', { type: 'checkbox', checked: entry.enabled }), n => { entry.enabled = n.checked; }), '启用'),
          el('label', {}, bind(el('input', { type: 'checkbox', checked: entry.constant }), n => { entry.constant = n.checked; }), '常驻'),
          el('button', { onclick: () => { entries.splice(index, 1); renderLore(); } }, '删除')),
        bind(el('input', { value: entry.keys.join(', '), placeholder: '关键词，逗号分隔' }), n => { entry.keys = n.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); }),
        bind(el('textarea', { rows: 3 }, entry.content), n => { entry.content = n.value; }),
        el('div', { class: 'row' },
          el('label', {}, '位置 ', bind(position, n => { entry.extensions.position = Number(n.value); })),
          el('label', {}, '深度 ', bind(el('input', { type: 'number', min: 0, value: entry.extensions.depth ?? 4 }), n => { entry.extensions.depth = Number(n.value); })),
          el('label', {}, '顺序 ', bind(el('input', { type: 'number', value: entry.insertion_order }), n => { entry.insertion_order = Number(n.value); })),
          el('label', {}, '概率% ', bind(el('input', { type: 'number', min: 0, max: 100, value: entry.extensions.probability ?? 100 }), n => { entry.extensions.probability = Number(n.value); })))));
    });
  }
  $('lore-add').addEventListener('click', () => {
    const entries = state.cardData.data.character_book.entries;
    entries.push({ id: Date.now(), name: '新条目', keys: [], secondary_keys: [], content: '', enabled: true, constant: false, selective: false, insertion_order: 100, case_sensitive: false, extensions: { position: 1, depth: 4, probability: 100, useProbability: true, selectiveLogic: 0 } });
    renderLore();
  });
  $('lore-save').addEventListener('click', () => $('card-save').click());

  $('prompt-save').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/config', {
        user: { name: $('pf-user-name').value, persona: $('pf-persona').value },
        prompt: { authorNote: $('pf-author-note').value, authorNoteDepth: Number($('pf-an-depth').value || 0), mainPrompt: $('pf-main').value, worldInfoScanDepth: Number($('pf-scan').value || 4), worldInfoBudgetChars: Number($('pf-budget').value || 6000) },
        agent: { cwd: $('pf-cwd').value, permissionMode: $('pf-mode').value, model: $('pf-model').value },
      });
      const s = currentSession();
      if (s) await api('PATCH', `/api/sessions/${s.id}`, { authorNote: $('pf-session-note').value });
      toast('已保存');
    } catch (error) { toast(error.message); }
  });

  async function runInspect() {
    const s = currentSession();
    if (!s) { $('inspect-system').textContent = '先选择或新建一个会话。'; $('inspect-turn').textContent = ''; return; }
    try {
      const text = $('inspect-text').value.trim();
      const r = await api('GET', `/api/sessions/${s.id}/preview${text ? `?text=${encodeURIComponent(text)}` : ''}`);
      $('inspect-system').textContent = r.system;
      $('inspect-turn').textContent = r.turn;
      $('inspect-lore').textContent = `激活的世界书：${r.activated.map(a => `${a.name}（${a.reason === 'constant' ? '常驻' : '关键词'}）`).join('、') || '无'} · system 层 ${r.system.length} 字符 · 注入层 ${r.turn.length} 字符`;
    } catch (error) { toast(error.message); }
  }
  $('inspect-run').addEventListener('click', runInspect);

  function renderDiscordInfo() {
    const d = state.discord || {};
    const c = state.config?.discord || {};
    $('dc-reactions').checked = c.reactions !== false;
    $('discord-info').replaceChildren(
      el('div', {}, `状态：${d.state}${d.user ? ` · ${d.user.tag}` : ''}${d.guilds ? ` · ${d.guilds} 个服务器` : ''}`),
      d.error ? el('div', { style: 'color: var(--danger)' }, d.error) : null,
      el('div', {}, `令牌：${c.token || '未配置'} · 主人 ${c.owners?.length || 0} 人 · 白名单 ${c.allowFrom?.length || 0} 人`),
      el('div', {}, `私信策略 ${c.dmPolicy} · 群组策略 ${c.groupPolicy} · 历史 ${c.historyLimit} 条 · 提及词 ${(c.mentionPatterns || []).join(' / ')}`));
  }
  // ---------------- 访客 ----------------
  function fillEffortInto(select, modelId, current) {
    const levels = effortsFor(modelId);
    select.replaceChildren(el('option', { value: '' }, levels.length ? '默认' : '不支持'), ...levels.map(l => el('option', { value: l }, l)));
    select.value = levels.includes(current) ? current : '';
    select.disabled = !levels.length;
  }
  $('gs-model').addEventListener('change', () => fillEffortInto($('gs-effort'), $('gs-model').value, $('gs-effort').value));

  let guestUserLimits = {};
  async function loadGuest() {
    const g = state.config.discord.guest;
    fillModelSelect($('gs-model'), g.model || '');
    fillEffortInto($('gs-effort'), g.model || '', g.effort || '');
    $('gs-websearch').checked = g.webSearch !== false;
    $('gs-limit').value = g.quota.limit;
    $('gs-period').value = g.quota.period;
    guestUserLimits = { ...(g.userLimits || {}) };
    const selected = new Set((g.roles || []).map(String));
    try {
      const guilds = await api('GET', '/api/discord/guilds');
      $('gs-roles').replaceChildren(...(guilds.length ? guilds.map(guild => el('div', {},
        el('div', { class: 'role-guild-name' }, `${guild.name}${guild.configured ? '' : '（未在配置里，访客无法在这里使用）'}`),
        el('div', { class: 'role-chips' }, guild.everyone ? el('label', { class: 'role-chip everyone', title: '服务器里的所有人都能以访客身份使用（仍受次数限制，仍需 @ 她或叫她名字）' },
          el('input', { type: 'checkbox', value: guild.everyone.id, checked: selected.has(guild.everyone.id) }),
          el('span', { class: 'role-dot', style: 'background:var(--accent)' }),
          `@everyone（所有人${guild.everyone.memberCount ? `，${guild.everyone.memberCount} 人` : ''}）`) : null,
          guild.roles.length ? guild.roles.map(role => el('label', { class: 'role-chip' },
          el('input', { type: 'checkbox', value: role.id, checked: selected.has(role.id) }),
          el('span', { class: 'role-dot', style: `background:${role.color === '#000000' ? 'var(--muted)' : role.color}` }),
          role.name)) : el('span', { class: 'hint' }, '这个服务器没有可选的身份组')))) : [el('p', { class: 'hint' }, 'Discord 未连接，暂时无法读取身份组。')]));
    } catch (error) { toast(error.message); }
    await loadGuestUsage();
  }

  async function loadGuestUsage() {
    const rows = await api('GET', '/api/guest-usage');
    const box = $('gs-usage');
    if (!rows.length) { box.replaceChildren(el('p', { class: 'hint' }, '还没有访客使用过。')); return; }
    box.replaceChildren(...rows.map(row => {
      const limitInput = el('input', { type: 'number', min: 0, placeholder: `默认 ${state.config.discord.guest.quota.limit}`, value: guestUserLimits[row.id] ?? '', title: '单独给这个人设上限；留空用默认，0 = 禁止' });
      limitInput.addEventListener('input', () => { if (limitInput.value === '') delete guestUserLimits[row.id]; else guestUserLimits[row.id] = Number(limitInput.value); });
      return el('div', { class: 'usage-row' },
        el('span', { class: 'u-name', title: row.id }, row.name || row.id),
        el('span', { class: `u-count${row.remaining === 0 ? ' full' : ''}` }, `${row.periodName} ${row.used}/${row.limit} · 累计 ${row.total || 0}`),
        limitInput,
        el('button', { type: 'button', onclick: async () => { await api('POST', `/api/guest-usage/${row.id}/reset`); toast('已清零'); loadGuestUsage(); } }, '清零'));
    }));
  }

  $('guest-save').addEventListener('click', async () => {
    try {
      const roles = [...document.querySelectorAll('#gs-roles input:checked')].map(i => i.value);
      const saved = await api('PUT', '/api/config', { discord: { guest: {
        model: $('gs-model').value, effort: $('gs-effort').value, webSearch: $('gs-websearch').checked,
        quota: { limit: Number($('gs-limit').value || 0), period: $('gs-period').value }, roles, userLimits: guestUserLimits,
      } } });
      state.config = saved;
      toast('访客设置已保存');
      loadGuestUsage();
    } catch (error) { toast(error.message); }
  });

  // ---------------- 人物记忆 ----------------
  let peopleCache = [];
  async function loadPeople() {
    const pm = state.config.discord.peopleMemory;
    $('pm-enabled').checked = pm.enabled !== false;
    fillModelSelect($('pm-model'), pm.model || '');
    $('pm-every').value = pm.digestEvery;
    $('pm-max').value = pm.maxPeoplePerTurn;
    peopleCache = await api('GET', '/api/people');
    renderPeople();
  }

  function renderPeople() {
    const q = $('pm-search').value.trim().toLowerCase();
    const list = peopleCache.filter(p => !q || [p.displayName, p.username, ...(p.aliases || []), ...(p.notes || []), p.pinned].join(' ').toLowerCase().includes(q));
    const box = $('pm-list');
    if (!list.length) { box.replaceChildren(el('p', { class: 'hint' }, peopleCache.length ? '没有匹配的人。' : '还没有观察到任何人。Discord 在线后，群里有人说话就会开始记录。')); return; }
    box.replaceChildren(...list.map(person => {
      const notes = el('textarea', { rows: Math.min(8, Math.max(2, person.notes.length)), placeholder: '还没有整理出档案' }, person.notes.join('\n'));
      const aliases = el('input', { value: (person.aliases || []).join('，'), placeholder: '昵称，逗号分隔' });
      const pinned = el('input', { value: person.pinned || '', placeholder: '主人备注（始终随档案注入，例如：这是我表弟，说话随意点）' });
      const off = el('input', { type: 'checkbox', checked: person.disabled });
      const save = async () => {
        try {
          const updated = await api('PATCH', `/api/people/${person.id}`, { notes: notes.value, aliases: aliases.value, pinned: pinned.value, disabled: off.checked });
          Object.assign(person, updated);
          toast('已保存');
          renderPeople();
        } catch (error) { toast(error.message); }
      };
      return el('div', { class: `person${person.disabled ? ' off' : ''}` },
        el('div', { class: 'person-head' },
          el('span', { class: 'p-name' }, person.displayName || person.username),
          el('span', { class: 'p-meta' }, `@${person.username} · ${person.messageCount} 条发言 · 待整理 ${person.pendingCount} · 最近 ${new Date(person.lastSeen).toLocaleString('zh-CN', { hour12: false })}`)),
        notes, aliases, pinned,
        el('div', { class: 'row' },
          el('label', { class: 'inline-check grow' }, off, '不再记录和激活此人'),
          el('button', { type: 'button', onclick: async () => {
            toast('正在整理…');
            try { Object.assign(person, await api('POST', `/api/people/${person.id}/digest`)); toast('整理完成'); renderPeople(); } catch (error) { toast(error.message); }
          } }, '立即整理'),
          el('button', { type: 'button', class: 'danger', onclick: async () => {
            if (!confirm(`删除 ${person.displayName || person.username} 的全部记录？`)) return;
            await api('DELETE', `/api/people/${person.id}`);
            peopleCache = peopleCache.filter(p => p.id !== person.id);
            renderPeople();
          } }, '删除'),
          el('button', { type: 'button', class: 'primary', onclick: save }, '保存')));
    }));
  }
  $('pm-search').addEventListener('input', renderPeople);
  $('pm-save').addEventListener('click', async () => {
    try {
      state.config = await api('PUT', '/api/config', { discord: { peopleMemory: { enabled: $('pm-enabled').checked, model: $('pm-model').value, digestEvery: Number($('pm-every').value), maxPeoplePerTurn: Number($('pm-max').value) } } });
      toast('已保存');
    } catch (error) { toast(error.message); }
  });

  $('discord-save').addEventListener('click', async () => {
    try { state.config = await api('PUT', '/api/config', { discord: { reactions: $('dc-reactions').checked } }); toast('已保存'); } catch (error) { toast(error.message); }
  });

  $('discord-restart').addEventListener('click', async () => {
    try { state.discord = await api('POST', '/api/discord/restart'); renderDiscordInfo(); renderStatus(true); } catch (error) { toast(error.message); }
  });

  for (const id of ['opt-model', 'opt-effort', 'opt-mode']) window.enhanceSelect($(id));
  for (const id of ['card-select', 'pf-model', 'pf-mode', 'sc-kind', 'sc-session', 'gs-model', 'gs-effort', 'gs-period', 'pm-model']) window.enhanceSelect($(id), { block: true });
  connect();
})();
