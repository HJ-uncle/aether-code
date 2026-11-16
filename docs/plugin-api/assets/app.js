(() => {
  'use strict';
  const root = document.documentElement;
  const byId = id => document.getElementById(id);
  const themeKey = 'aether-plugin-docs-theme';
  const themeToggle = byId('theme-toggle');
  const themeMenu = byId('theme-menu');
  const themeItems = [...themeMenu.querySelectorAll('[data-theme]')];
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  let theme = root.dataset.themeMode || 'system';
  function applyTheme(mode, persist = false) {
    theme = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
    root.dataset.themeMode = theme;
    root.dataset.appearance = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
    for (const icon of themeToggle.querySelectorAll('[data-theme-icon]')) icon.toggleAttribute('hidden', icon.dataset.themeIcon !== theme);
    for (const item of themeItems) item.setAttribute('aria-checked', String(item.dataset.theme === theme));
    const label = { system: '跟随系统', light: '浅色', dark: '深色' }[theme];
    themeToggle.title = `选择外观 · ${label}`;
    if (persist) try { localStorage.setItem(themeKey, theme); } catch { /* Browsers may restrict storage for local files. */ }
  }
  function closeTheme(restoreFocus = false) {
    themeMenu.hidden = true;
    themeToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) themeToggle.focus();
  }
  function openTheme() {
    themeMenu.hidden = false;
    themeToggle.setAttribute('aria-expanded', 'true');
    (themeItems.find(item => item.dataset.theme === theme) || themeItems[0]).focus();
  }
  themeToggle.addEventListener('click', () => themeMenu.hidden ? openTheme() : closeTheme(true));
  themeToggle.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openTheme(); }
  });
  themeItems.forEach(item => item.addEventListener('click', () => { applyTheme(item.dataset.theme, true); closeTheme(true); }));
  themeMenu.addEventListener('keydown', event => {
    const index = themeItems.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? themeItems.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + themeItems.length) % themeItems.length;
      themeItems[next].focus();
    } else if (event.key === 'Escape') { event.preventDefault(); closeTheme(true); }
    else if (event.key === 'Tab') closeTheme(true);
  });
  document.addEventListener('pointerdown', event => { if (!themeMenu.hidden && !event.target.closest('.theme-control')) closeTheme(); });
  document.addEventListener('focusin', event => { if (!themeMenu.hidden && !event.target.closest('.theme-control')) closeTheme(); });
  systemTheme.addEventListener('change', () => { if (theme === 'system') applyTheme('system'); });
  window.addEventListener('storage', event => { if (event.key === themeKey) applyTheme(event.newValue || 'system'); });
  applyTheme(theme);
  themeToggle.hidden = false;

  const navigationOpen = byId('navigation-open');
  const navigationDialog = byId('navigation-dialog');
  const navigation = byId('desktop-navigation').querySelector('nav');
  byId('mobile-navigation-content').append(navigation.cloneNode(true));
  let navigationOpener;
  navigationOpen.hidden = false;
  navigationOpen.addEventListener('click', () => {
    closeTheme();
    navigationOpener = document.activeElement;
    navigationDialog.showModal();
    navigationOpen.setAttribute('aria-expanded', 'true');
    (navigationDialog.querySelector('[aria-current="page"]') || navigationDialog.querySelector('button')).focus();
  });
  navigationDialog.querySelector('[data-close-navigation]').addEventListener('click', () => navigationDialog.close());
  navigationDialog.addEventListener('click', event => {
    if (event.target === navigationDialog) {
      const rect = navigationDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) navigationDialog.close();
    }
  });
  navigationDialog.addEventListener('close', () => {
    navigationOpen.setAttribute('aria-expanded', 'false');
    if (byId('search-dialog').open) return;
    if (navigationOpener?.isConnected && navigationOpener.getClientRects().length) navigationOpener.focus();
    else navigation.querySelector('[aria-current="page"]')?.focus();
  });
  matchMedia('(min-width: 768px)').addEventListener('change', event => { if (event.matches && navigationDialog.open) navigationDialog.close(); });

  const searchOpen = byId('search-open');
  const searchDialog = byId('search-dialog');
  const searchInput = byId('search-input');
  const searchResults = byId('search-results');
  const searchStatus = byId('search-status');
  const searchEmpty = byId('search-empty');
  const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  let searchIndex = [];
  let indexValid = true;
  try {
    const data = JSON.parse(byId('search-index').textContent);
    if (!Array.isArray(data)) throw new Error('Invalid search index');
    searchIndex = data.filter(item => item && ['title', 'section', 'href', 'text'].every(key => typeof item[key] === 'string') && /^[a-z0-9-]+\.html(?:#[^\s]*)?$/i.test(item.href))
      .map(item => ({ ...item, titleSearch: normalize(item.title), sectionSearch: normalize(item.section), textSearch: normalize(item.text) }));
  } catch { indexValid = false; }
  let searchOpener;
  let activeResult = 0;
  let resultLinks = [];
  let searchTimer;
  const onMac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.querySelectorAll('[data-search-shortcut]').forEach(element => { element.textContent = onMac ? '⌘ K' : 'Ctrl K'; });
  function highlighted(text, terms) {
    const fragment = document.createDocumentFragment();
    if (!terms.length) { fragment.append(document.createTextNode(text)); return fragment; }
    const lower = text.toLocaleLowerCase();
    let cursor = 0;
    while (cursor < text.length) {
      let at = -1, match = '';
      for (const term of terms) {
        const next = lower.indexOf(term, cursor);
        if (next >= 0 && (at < 0 || next < at)) { at = next; match = term; }
      }
      if (at < 0) { fragment.append(document.createTextNode(text.slice(cursor))); break; }
      fragment.append(document.createTextNode(text.slice(cursor, at)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(at, at + match.length);
      fragment.append(mark); cursor = at + match.length;
    }
    return fragment;
  }
  function selectResult(index, scroll = true) {
    if (!resultLinks.length) { searchInput.removeAttribute('aria-activedescendant'); return; }
    activeResult = (index + resultLinks.length) % resultLinks.length;
    resultLinks.forEach((link, i) => link.setAttribute('aria-selected', String(i === activeResult)));
    const selected = resultLinks[activeResult];
    searchInput.setAttribute('aria-activedescendant', selected.id);
    if (scroll) selected.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  function renderSearch() {
    clearTimeout(searchTimer); searchTimer = undefined;
    const query = normalize(searchInput.value);
    const terms = query.split(' ').filter(Boolean).slice(0, 12);
    const matched = query ? searchIndex.map((item, position) => {
      let score = 0;
      for (const term of terms) {
        const title = item.titleSearch.includes(term), section = item.sectionSearch.includes(term), text = item.textSearch.includes(term);
        if (!title && !section && !text) return null;
        score += (title ? 10 : 0) + (section ? 18 : 0) + (text ? 1 : 0);
        if (item.sectionSearch === term || item.titleSearch === term) score += 25;
      }
      return { item, score, position };
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.position - b.position).map(value => value.item)
      : searchIndex.filter(item => !item.href.includes('#'));
    const results = matched.slice(0, 30);
    searchResults.replaceChildren(); resultLinks = []; activeResult = 0;
    searchStatus.textContent = indexValid ? (query ? `${matched.length} 项结果${matched.length > 30 ? ' · 显示前 30 项' : ''}` : '快速访问') : '搜索暂不可用';
    searchEmpty.hidden = results.length > 0;
    if (!indexValid) searchEmpty.textContent = '搜索索引无法读取，请使用文档导航。';
    for (const [index, result] of results.entries()) {
      const row = document.createElement('li'); row.setAttribute('role', 'presentation');
      const link = document.createElement('a'); link.className = 'search-result'; link.href = result.href; link.id = `search-result-${index}`; link.setAttribute('role', 'option'); link.tabIndex = -1;
      const path = document.createElement('span'); path.className = 'search-result-path'; path.textContent = result.section ? result.title : '文档';
      const title = document.createElement('span'); title.className = 'search-result-title'; title.append(highlighted(result.section || result.title, terms));
      const excerpt = document.createElement('span'); excerpt.className = 'search-result-excerpt';
      const plain = result.text.replace(/\s+/g, ' ').trim();
      const hit = terms.map(term => plain.toLocaleLowerCase().indexOf(term)).filter(value => value >= 0).sort((a, b) => a - b)[0] ?? 0;
      const start = Math.max(0, hit - 36), snippet = (start ? '…' : '') + plain.slice(start, start + 180) + (plain.length > start + 180 ? '…' : '');
      excerpt.append(highlighted(snippet, terms));
      link.append(path, title, excerpt); row.append(link); searchResults.append(row); resultLinks.push(link);
      link.addEventListener('pointermove', () => selectResult(index, false));
      link.addEventListener('click', () => searchDialog.close());
    }
    selectResult(0, false); searchResults.scrollTop = 0;
  }
  function openSearch() {
    if (searchDialog.open) { searchInput.focus(); searchInput.select(); return; }
    closeTheme();
    if (navigationDialog.open) navigationDialog.close();
    searchOpener = document.activeElement;
    renderSearch(); searchDialog.showModal(); searchInput.focus(); searchInput.select();
  }
  searchOpen.hidden = false;
  searchOpen.addEventListener('click', openSearch);
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 70); });
  searchInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (searchTimer) renderSearch(); selectResult(activeResult + (event.key === 'ArrowDown' ? 1 : -1));
    }
  });
  byId('search-form').addEventListener('submit', event => { event.preventDefault(); renderPending(); resultLinks[activeResult]?.click(); });
  function renderPending() { if (searchTimer) { clearTimeout(searchTimer); searchTimer = undefined; renderSearch(); } }
  searchDialog.querySelector('[data-close-search]').addEventListener('click', () => searchDialog.close());
  searchDialog.addEventListener('keydown', event => {
    // Search inputs otherwise consume Escape to clear text before the dialog can close.
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); searchDialog.close();
    }
  });
  searchDialog.addEventListener('click', event => {
    if (event.target === searchDialog) {
      const rect = searchDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) searchDialog.close();
    }
  });
  searchDialog.addEventListener('close', () => { clearTimeout(searchTimer); if (searchOpener?.isConnected) searchOpener.focus(); });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); }
  });

  const feedback = byId('feedback');
  let feedbackTimer;
  function announce(message) {
    clearTimeout(feedbackTimer); feedback.textContent = message; feedback.dataset.visible = 'true';
    feedbackTimer = setTimeout(() => { feedback.dataset.visible = 'false'; }, 2500);
  }
  async function copyText(text) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch { /* Local documents may need the user-gesture copy fallback. */ }
    const active = document.activeElement, selection = window.getSelection();
    const ranges = selection ? [...Array(selection.rangeCount)].map((_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const textarea = document.createElement('textarea'); textarea.className = 'copy-fallback'; textarea.value = text; textarea.readOnly = true; textarea.setAttribute('aria-label', '待复制代码'); document.body.append(textarea);
    let copied = false;
    try { textarea.focus(); textarea.select(); copied = document.execCommand('copy'); }
    finally { textarea.remove(); if (active instanceof HTMLElement) active.focus({ preventScroll: true }); if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); } }
    if (!copied) throw new Error('Copy not available');
  }
  const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
  const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
  document.querySelectorAll('.prose pre').forEach(pre => {
    const code = pre.querySelector('code'); if (!code) return;
    const wrapper = document.createElement('div'); wrapper.className = 'code-block';
    const toolbar = document.createElement('div'); toolbar.className = 'code-toolbar';
    const language = document.createElement('span'); language.className = 'code-language';
    const value = [...code.classList].find(name => name.startsWith('language-'))?.slice(9) || 'text';
    language.textContent = ({ js: 'JavaScript', javascript: 'JavaScript', ts: 'TypeScript', typescript: 'TypeScript', html: 'HTML', css: 'CSS', json: 'JSON', text: '文本', bash: 'Shell' })[value] || value;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-button'; copy.setAttribute('aria-label', '复制代码'); copy.innerHTML = `${copyIcon}<span>复制</span>`;
    let timer, copying = false;
    copy.addEventListener('click', async () => {
      if (copying) return; copying = true; clearTimeout(timer); copy.setAttribute('aria-busy', 'true');
      try {
        await copyText(code.textContent); copy.dataset.state = 'success'; copy.innerHTML = `${checkIcon}<span>已复制</span>`; copy.setAttribute('aria-label', '代码已复制'); announce('代码已复制');
      } catch {
        copy.dataset.state = 'error'; copy.innerHTML = `${copyIcon}<span>复制失败</span>`; copy.setAttribute('aria-label', '复制失败，请手动选择代码'); announce('无法访问剪贴板，请手动选择并复制代码。');
      } finally {
        copying = false; copy.removeAttribute('aria-busy');
        timer = setTimeout(() => { delete copy.dataset.state; copy.innerHTML = `${copyIcon}<span>复制</span>`; copy.setAttribute('aria-label', '复制代码'); }, 2200);
      }
    });
    toolbar.append(language, copy); pre.before(wrapper); wrapper.append(toolbar, pre);
    pre.tabIndex = 0; pre.setAttribute('aria-label', `${language.textContent} 代码示例`);
  });

  const outlineLinks = [...document.querySelectorAll('.page-outline a[href^="#"]')];
  const sections = outlineLinks.map(link => ({ link, heading: byId(decodeURIComponent(link.hash.slice(1))) })).filter(item => item.heading);
  let ticking = false;
  function updateOutline() {
    ticking = false;
    let current = sections[0];
    for (const item of sections) { if (item.heading.getBoundingClientRect().top <= 140) current = item; else break; }
    for (const item of sections) { if (item === current) item.link.setAttribute('aria-current', 'location'); else item.link.removeAttribute('aria-current'); }
  }
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateOutline); } }, { passive: true });
  updateOutline();
  root.classList.add('js');
})();
