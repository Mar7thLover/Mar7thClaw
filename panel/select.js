// 自绘下拉框：原生 <select> 仍是唯一的数据源（value、change 事件、disabled 都照旧），
// 这里只负责显示。选项上的 data-label / data-badge / data-tone / data-hint 用来渲染徽标与说明。
(function () {
  const enhanced = new Set();
  let openState = null;
  const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

  function labelOf(option) {
    return option ? (option.dataset.label || option.textContent) : '';
  }

  function close() {
    if (!openState) return;
    const { pop, trigger } = openState;
    pop.remove();
    trigger.setAttribute('aria-expanded', 'false');
    trigger.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('blur', close);
    window.removeEventListener('scroll', onScroll, true);
    openState = null;
  }

  function onScroll(event) {
    if (openState && !openState.pop.contains(event.target)) close();
  }

  function onOutside(event) {
    if (openState && !openState.pop.contains(event.target) && !openState.trigger.contains(event.target)) close();
  }

  function place(pop, trigger) {
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    pop.style.minWidth = `${Math.max(rect.width, 180)}px`;
    pop.style.maxWidth = `${Math.min(420, window.innerWidth - margin * 2)}px`;
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const openUp = below < 260 && above > below;
    const maxHeight = Math.min(380, (openUp ? above : below) - 6);
    pop.style.maxHeight = `${Math.max(140, maxHeight)}px`;
    const width = pop.offsetWidth;
    pop.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    if (openUp) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - rect.top + 6}px`; pop.classList.add('up'); }
    else { pop.style.bottom = ''; pop.style.top = `${rect.bottom + 6}px`; }
  }

  function buildList(select, list, filter) {
    list.replaceChildren();
    const q = filter.trim().toLowerCase();
    const items = [];
    const addOption = (option, parent) => {
      const text = `${labelOf(option)} ${option.value} ${option.dataset.hint || ''}`.toLowerCase();
      if (q && !text.includes(q)) return;
      const row = document.createElement('div');
      row.className = 'cs-opt';
      row.setAttribute('role', 'option');
      row.dataset.value = option.value;
      if (option.disabled) row.classList.add('disabled');
      const selected = option.value === valueDescriptor.get.call(select);
      row.setAttribute('aria-selected', String(selected));
      if (selected) row.classList.add('selected');
      const main = document.createElement('span');
      main.className = 'cs-opt-main';
      const label = document.createElement('span');
      label.className = 'cs-opt-label';
      label.textContent = labelOf(option);
      main.append(label);
      if (option.dataset.hint) {
        const hint = document.createElement('span');
        hint.className = 'cs-opt-hint';
        hint.textContent = option.dataset.hint;
        main.append(hint);
      }
      row.append(main);
      if (option.dataset.badge) {
        const badge = document.createElement('span');
        badge.className = `cs-badge ${option.dataset.tone || ''}`;
        badge.textContent = option.dataset.badge;
        row.append(badge);
      }
      const check = document.createElement('span');
      check.className = 'cs-check';
      check.textContent = selected ? '✓' : '';
      row.append(check);
      parent.append(row);
      items.push(row);
    };
    for (const child of select.children) {
      if (child.tagName === 'OPTGROUP') {
        const group = document.createElement('div');
        group.className = 'cs-group';
        const title = document.createElement('div');
        title.className = 'cs-group-title';
        title.textContent = child.label;
        group.append(title);
        for (const option of child.children) addOption(option, group);
        if (group.children.length > 1) list.append(group);
      } else if (child.tagName === 'OPTION') addOption(child, list);
    }
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'cs-empty';
      empty.textContent = '没有匹配的选项';
      list.append(empty);
    }
    return items;
  }

  function open(select, trigger) {
    close();
    const pop = document.createElement('div');
    pop.className = 'cs-pop';
    pop.setAttribute('role', 'listbox');
    const optionCount = select.querySelectorAll('option').length;
    let search = null;
    if (optionCount > 10) {
      search = document.createElement('input');
      search.className = 'cs-search';
      search.placeholder = '筛选…';
      search.setAttribute('aria-label', '筛选选项');
      pop.append(search);
    }
    const list = document.createElement('div');
    list.className = 'cs-list';
    pop.append(list);
    // 模态 <dialog> 位于浏览器顶层，弹层必须挂在同一个 dialog 里才不会被盖住。
    (select.closest('dialog[open]') || document.body).append(pop);
    const state = { pop, trigger, select, list, items: [], active: -1 };
    const render = () => {
      state.items = buildList(select, list, search?.value || '');
      state.active = Math.max(0, state.items.findIndex(item => item.classList.contains('selected')));
      highlight();
    };
    const highlight = (scroll = true) => {
      state.items.forEach((item, i) => item.classList.toggle('active', i === state.active));
      if (scroll) state.items[state.active]?.scrollIntoView({ block: 'nearest' });
    };
    const choose = row => {
      if (!row || row.classList.contains('disabled')) return;
      const changed = valueDescriptor.get.call(select) !== row.dataset.value;
      valueDescriptor.set.call(select, row.dataset.value);
      close();
      trigger.focus();
      sync(select);
      if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    list.addEventListener('click', event => choose(event.target.closest('.cs-opt')));
    list.addEventListener('mousemove', event => {
      const row = event.target.closest('.cs-opt');
      const i = state.items.indexOf(row);
      if (i >= 0 && i !== state.active) { state.active = i; highlight(false); }
    });
    const onKey = event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        state.active = (state.active + step + state.items.length) % Math.max(1, state.items.length);
        highlight();
      } else if (event.key === 'Enter') { event.preventDefault(); choose(state.items[state.active]); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
      else if (event.key === 'Tab') close();
    };
    pop.addEventListener('keydown', onKey);
    search?.addEventListener('input', render);
    state.onKey = onKey;
    openState = state;
    render();
    place(pop, trigger);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.classList.add('open');
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', onScroll, true);
    (search || list).focus?.();
    if (!search) { list.tabIndex = -1; list.focus(); }
  }

  function sync(select) {
    const parts = select._cs;
    if (!parts) return;
    const option = select.options[select.selectedIndex];
    parts.value.textContent = labelOf(option) || '—';
    parts.value.title = option?.dataset.hint || labelOf(option);
    parts.trigger.disabled = select.disabled;
    parts.wrap.classList.toggle('disabled', select.disabled);
    if (option?.dataset.tone) parts.wrap.dataset.tone = option.dataset.tone; else delete parts.wrap.dataset.tone;
  }

  window.enhanceSelect = function (select, { block = false } = {}) {
    if (select._cs) return select._cs;
    const wrap = document.createElement('span');
    wrap.className = `cs${block ? ' cs-block' : ''}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'cs-value';
    const chevron = document.createElement('span');
    chevron.className = 'cs-chevron';
    chevron.innerHTML = CHEVRON;
    trigger.append(value, chevron);
    select.parentNode.insertBefore(wrap, select);
    wrap.append(select, trigger);
    select.classList.add('cs-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const label = select.closest('label');
    if (label) trigger.setAttribute('aria-label', label.childNodes[0]?.textContent?.trim() || '');
    select._cs = { wrap, trigger, value };
    // 代码里直接给 select.value 赋值时也要刷新显示。
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return valueDescriptor.get.call(this); },
      set(v) { valueDescriptor.set.call(this, v); sync(this); },
    });
    trigger.addEventListener('click', () => (openState?.select === select ? close() : open(select, trigger)));
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(select, trigger); }
    });
    // label 点击默认会聚焦隐藏的 select，这里改成聚焦按钮。
    label?.addEventListener('click', event => { if (event.target === label) { event.preventDefault(); trigger.focus(); } });
    new MutationObserver(() => sync(select))
      .observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    select.addEventListener('change', () => sync(select));
    enhanced.add(select);
    sync(select);
    return select._cs;
  };
})();
