/*
 * LifeTools 全站主题中枢 theme-manager.js(零依赖,仅暴露 window.LifeToolsTheme)
 *
 * 用法:每个页面在 <head> 里、任何 <style> 之前同步引入并立刻初始化,避免刷新时闪白/闪黑(FOUC):
 *   <meta name="color-scheme" content="light dark">
 *   <script src="theme-manager.js"></script>
 *   <script>window.LifeToolsTheme && LifeToolsTheme.initAntiFOUC('badminton');</script>
 * 页面样式只依赖 html[data-theme="dark"|"light"],不要依赖 class。
 * 非首页可在 <body> 内调用 LifeToolsTheme.mountThemeControl('badminton') 挂载主题挂件。
 *
 * 存储(localStorage,不可用时自动退化为内存值,绝不抛错):
 *   lifetools_global_theme        'auto' | 'dark' | 'light'          默认 'auto'
 *   lifetools_page_theme_<pageId> 'follow' | 'dark' | 'light' | 'system'  默认 'follow'
 *   pageId 约定:'home'(首页,永不使用页面覆盖)、'badminton'、'interview'
 *
 * 事件:window 上的 'lifetools:themechange',detail = { pageId, theme, mode }
 *   theme 为生效主题 'dark'|'light';mode 为该页面当前的模式设置
 *   (非首页是页面模式 follow/dark/light/system,首页则是全局模式 auto/dark/light)。
 *   onChange(cb) 的 cb 收到的是原生 CustomEvent,取值用 e.detail.theme。
 *
 * API:getGlobalTheme / setGlobalTheme / getPageTheme / setPageTheme / resolveEffectiveTheme /
 *      applyTheme / initAntiFOUC / mountThemeControl / unmountThemeControl / onChange / KEYS
 */
(function (global) {
  'use strict';

  var doc = global.document;

  var KEYS = Object.freeze({
    GLOBAL: 'lifetools_global_theme',
    PAGE_PREFIX: 'lifetools_page_theme_'
  });
  var EVENT_NAME = 'lifetools:themechange';
  var HOME_ID = 'home';
  var DARK_QUERY = '(prefers-color-scheme: dark)';
  var GLOBAL_MODES = ['auto', 'dark', 'light'];
  var PAGE_MODES = ['follow', 'dark', 'light', 'system'];
  var THEME_LABEL = { dark: '深色', light: '浅色' };

  /* ---------------------------------------------------------------
   * 存储层:只在 localStorage 读写失败(隐私模式、被禁用、配额)时才用内存兜底,
   * 这样存储正常时始终以 localStorage 为准,跨标签页读到的是最新值。
   * --------------------------------------------------------------- */
  var memory = {};

  function readRaw(key) {
    // 内存里有值说明这个键最近一次写入失败,它才是用户最新的选择,优先于存储里的旧值
    if (Object.prototype.hasOwnProperty.call(memory, key)) return memory[key];
    try {
      var v = global.localStorage.getItem(key);
      if (v !== null && v !== undefined) return v;
    } catch (e) { /* 存储不可用,按默认值处理 */ }
    return null;
  }

  function writeRaw(key, value) {
    try {
      global.localStorage.setItem(key, value);
      delete memory[key];
    } catch (e) {
      memory[key] = value;
    }
  }

  function pageKey(pageId) {
    return KEYS.PAGE_PREFIX + pageId;
  }

  function validPageId(pageId) {
    return typeof pageId === 'string' && pageId !== '';
  }

  /* ---------------------------------------------------------------
   * 读写与解析
   * --------------------------------------------------------------- */
  function getGlobalTheme() {
    var v = readRaw(KEYS.GLOBAL);
    return GLOBAL_MODES.indexOf(v) >= 0 ? v : 'auto';
  }

  function getPageTheme(pageId) {
    // 首页恒等于全局解析结果,不存在页面级覆盖
    if (!validPageId(pageId) || pageId === HOME_ID) return 'follow';
    var v = readRaw(pageKey(pageId));
    return PAGE_MODES.indexOf(v) >= 0 ? v : 'follow';
  }

  function systemTheme() {
    try {
      if (typeof global.matchMedia === 'function') {
        return global.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
      }
    } catch (e) { /* 忽略,按深色处理 */ }
    return 'dark'; // 无 matchMedia 时,与首页默认的深色保持一致
  }

  function resolveGlobal() {
    var g = getGlobalTheme();
    return g === 'auto' ? systemTheme() : g;
  }

  function resolveEffectiveTheme(pageId) {
    if (pageId === HOME_ID) return resolveGlobal();
    var mode = getPageTheme(pageId);
    if (mode === 'dark' || mode === 'light') return mode;
    if (mode === 'system') return systemTheme();
    return resolveGlobal(); // follow
  }

  function modeOf(pageId) {
    return pageId === HOME_ID ? getGlobalTheme() : getPageTheme(pageId);
  }

  /* ---------------------------------------------------------------
   * 应用到 DOM + 广播
   * --------------------------------------------------------------- */
  var currentPageId = null; // initAntiFOUC 记录的"当前页"

  function emit(detail) {
    var evt;
    try {
      evt = new global.CustomEvent(EVENT_NAME, { detail: detail });
    } catch (e) {
      evt = doc.createEvent('CustomEvent');
      evt.initCustomEvent(EVENT_NAME, false, false, detail);
    }
    global.dispatchEvent(evt);
  }

  function applyTheme(pageId) {
    var theme = resolveEffectiveTheme(pageId);
    try {
      var root = doc.documentElement;
      root.setAttribute('data-theme', theme);
      root.style.colorScheme = theme; // 让滚动条、表单控件等原生部件跟着变
    } catch (e) { /* 极端环境下 DOM 不可写,忽略 */ }
    emit({ pageId: pageId, theme: theme, mode: modeOf(pageId) });
    return theme;
  }

  function applyCurrent() {
    if (currentPageId !== null) applyTheme(currentPageId);
  }

  function setGlobalTheme(mode) {
    if (GLOBAL_MODES.indexOf(mode) < 0) return; // 非法值直接忽略,不污染存储
    writeRaw(KEYS.GLOBAL, mode);
    applyCurrent();
  }

  function setPageTheme(pageId, mode) {
    // 首页没有页面级覆盖,直接忽略
    if (!validPageId(pageId) || pageId === HOME_ID || PAGE_MODES.indexOf(mode) < 0) return;
    writeRaw(pageKey(pageId), mode);
    applyCurrent();
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    global.addEventListener(EVENT_NAME, cb);
    return function off() {
      global.removeEventListener(EVENT_NAME, cb);
    };
  }

  /* ---------------------------------------------------------------
   * 防闪烁初始化 + 跨标签页 / 系统主题监听(只注册一次)
   * --------------------------------------------------------------- */
  var listening = false;
  var systemQuery = null; // 持有引用,避免监听被回收

  function onStorage(e) {
    if (currentPageId === null) return;
    // key 为 null 表示 localStorage.clear()
    if (e.key === null || e.key === KEYS.GLOBAL || e.key === pageKey(currentPageId)) {
      // 其它标签页的写入比本页失败的那次写入更新,丢掉内存兜底值
      if (e.key === null) memory = {};
      else delete memory[e.key];
      applyCurrent();
    }
  }

  function onPageShow(e) {
    // 从 bfcache 恢复时,冻结期间的 storage 事件不会补发,这里补一次
    if (e && e.persisted) applyCurrent();
  }

  function bindListeners() {
    if (listening) return;
    listening = true;
    try {
      global.addEventListener('storage', onStorage);
      global.addEventListener('pageshow', onPageShow);
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof global.matchMedia === 'function') {
        systemQuery = global.matchMedia(DARK_QUERY);
        if (systemQuery.addEventListener) systemQuery.addEventListener('change', applyCurrent);
        else if (systemQuery.addListener) systemQuery.addListener(applyCurrent); // 旧版 Safari
      }
    } catch (e) { /* 忽略 */ }
  }

  function initAntiFOUC(pageId) {
    currentPageId = validPageId(pageId) ? pageId : (currentPageId !== null ? currentPageId : '');
    applyTheme(currentPageId);
    bindListeners();
  }

  /* ---------------------------------------------------------------
   * 主题挂件(非首页使用):悬浮或内联,键盘可操作,样式自包含
   * --------------------------------------------------------------- */
  var STYLE_ID = 'lt-theme-style';
  var MENU_OPTIONS = [
    { mode: 'follow', icon: '🏠', label: '跟随首页' },
    { mode: 'light', icon: '☀️', label: '浅色' },
    { mode: 'dark', icon: '🌙', label: '深色' },
    { mode: 'system', icon: '💻', label: '跟随系统' }
  ];
  var POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  var mounts = {};
  var mountSeq = 0;

  var CSS = [
    /* 变量全部挂在组件根上,不依赖宿主页的 CSS 变量;默认浅色,html[data-theme=dark] 时切深色 */
    '.lt-theme-root{--lt-theme-fg:#24201a;--lt-theme-muted:#6b6457;--lt-theme-accent:#7a5a14;',
    '--lt-theme-accent-soft:rgba(122,90,20,.12);--lt-theme-hover:rgba(36,32,26,.06);',
    '--lt-theme-bg:rgba(255,255,255,.97);--lt-theme-border:rgba(36,32,26,.16);',
    '--lt-theme-shadow:0 8px 28px rgba(36,32,26,.16),0 1px 3px rgba(36,32,26,.12);',
    'position:relative;display:inline-block;box-sizing:border-box;margin:0;padding:0;color:var(--lt-theme-fg);',
    'font:14px/1.4 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;text-align:left}',
    'html[data-theme="dark"] .lt-theme-root{--lt-theme-fg:#ddd8cc;--lt-theme-muted:#9aa3b5;--lt-theme-accent:#e8c56a;',
    '--lt-theme-accent-soft:rgba(232,197,106,.16);--lt-theme-hover:rgba(255,255,255,.07);',
    '--lt-theme-bg:rgba(22,28,38,.97);--lt-theme-border:rgba(255,255,255,.14);',
    '--lt-theme-shadow:0 10px 32px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.4)}',
    /* 支持毛玻璃时才把底色调透明,否则保持上面的近乎纯色回退 */
    '@supports ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){',
    '.lt-theme-root{--lt-theme-bg:rgba(255,255,255,.74)}',
    'html[data-theme="dark"] .lt-theme-root{--lt-theme-bg:rgba(22,28,38,.7)}',
    '.lt-theme-btn,.lt-theme-menu{-webkit-backdrop-filter:blur(14px) saturate(1.5);backdrop-filter:blur(14px) saturate(1.5)}}',
    '.lt-theme-root *{box-sizing:border-box}',
    '.lt-theme-floating{position:fixed;z-index:100000}',
    '.lt-theme-pos-bottom-right{right:16px;bottom:16px;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom))}',
    '.lt-theme-pos-bottom-left{left:16px;bottom:16px;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom))}',
    '.lt-theme-pos-top-right{right:16px;top:16px;right:max(16px,env(safe-area-inset-right));top:max(16px,env(safe-area-inset-top))}',
    '.lt-theme-pos-top-left{left:16px;top:16px;left:max(16px,env(safe-area-inset-left));top:max(16px,env(safe-area-inset-top))}',
    '.lt-theme-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;',
    'min-width:44px;min-height:44px;margin:0;padding:0 14px;border:1px solid var(--lt-theme-border);border-radius:999px;',
    'background:var(--lt-theme-bg);color:var(--lt-theme-fg);font:inherit;font-weight:600;cursor:pointer;',
    'box-shadow:var(--lt-theme-shadow);-webkit-tap-highlight-color:transparent;',
    'transition:transform .18s ease,border-color .2s ease,box-shadow .2s ease,background-color .2s ease,color .2s ease}',
    '.lt-theme-inline .lt-theme-btn{box-shadow:none}',
    '.lt-theme-btn:hover{border-color:var(--lt-theme-accent);transform:translateY(-1px)}',
    '.lt-theme-btn:active{transform:scale(.97)}',
    '.lt-theme-btn:focus-visible,.lt-theme-item:focus-visible{outline:2px solid var(--lt-theme-accent);outline-offset:2px}',
    '.lt-theme-icon{display:inline-block;font-size:18px;line-height:1;transition:transform .35s cubic-bezier(.34,1.56,.64,1)}',
    '.lt-theme-root[data-open="true"] .lt-theme-icon{transform:rotate(24deg) scale(1.12)}',
    /* 收起时 display:none:既不占滚动区域(否则靠右的内联菜单会撑出横向滚动条),也不会进入 Tab 序列 */
    '.lt-theme-menu{position:absolute;z-index:1;min-width:192px;max-width:calc(100vw - 32px);padding:6px;border:1px solid var(--lt-theme-border);border-radius:16px;',
    'background:var(--lt-theme-bg);color:var(--lt-theme-fg);box-shadow:var(--lt-theme-shadow);',
    'display:none;opacity:0;transform:translateY(6px) scale(.97);',
    'transition:opacity .18s ease,transform .18s ease;',
    'transition:opacity .18s ease,transform .18s ease,display .18s allow-discrete}', /* 不支持 allow-discrete 时上一行生效:只是少了淡出 */
    '.lt-theme-root[data-open="true"] .lt-theme-menu{display:block;opacity:1;transform:none}',
    '@starting-style{.lt-theme-root[data-open="true"] .lt-theme-menu{opacity:0;transform:translateY(6px) scale(.97)}}',
    '.lt-theme-root[data-v="up"] .lt-theme-menu{bottom:calc(100% + 8px)}',
    '.lt-theme-root[data-v="down"] .lt-theme-menu{top:calc(100% + 8px);transform:translateY(-6px) scale(.97)}',
    '.lt-theme-root[data-v="down"][data-open="true"] .lt-theme-menu{transform:none}',
    '@starting-style{.lt-theme-root[data-v="down"][data-open="true"] .lt-theme-menu{transform:translateY(-6px) scale(.97)}}',
    '.lt-theme-root[data-h="right"] .lt-theme-menu{right:0}',
    '.lt-theme-root[data-h="left"] .lt-theme-menu{left:0}',
    '.lt-theme-status{margin:0;padding:8px 12px 6px;font-size:12px;letter-spacing:.02em;color:var(--lt-theme-muted)}',
    '.lt-theme-item{appearance:none;-webkit-appearance:none;display:flex;align-items:center;gap:10px;width:100%;min-height:44px;',
    'margin:0;padding:0 12px;border:0;border-radius:11px;background:transparent;color:inherit;font:inherit;text-align:left;',
    'cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color .15s ease,color .15s ease}',
    '.lt-theme-item:hover{background:var(--lt-theme-hover)}',
    '.lt-theme-item[aria-checked="true"]{background:var(--lt-theme-accent-soft);color:var(--lt-theme-accent);font-weight:600}',
    '.lt-theme-item-icon{width:20px;text-align:center;font-size:16px;line-height:1}',
    '.lt-theme-check{margin-left:auto;opacity:0;font-weight:700;transition:opacity .15s ease}',
    '.lt-theme-item[aria-checked="true"] .lt-theme-check{opacity:1}',
    '@media (max-width:480px){',
    '.lt-theme-floating .lt-theme-btn{padding:0}.lt-theme-floating .lt-theme-label{display:none}}',
    '@media (prefers-reduced-motion:reduce){',
    '.lt-theme-root *{transition-duration:.01ms!important;transition-delay:0s!important;animation:none!important}}'
  ].join('');

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text; // 只用 textContent,杜绝注入
    return node;
  }

  function mountThemeControl(pageId, options) {
    // 首页用自己的顶栏三段式切换器,不渲染挂件
    if (!validPageId(pageId) || pageId === HOME_ID) return null;
    options = options || {};

    var existing = mounts[pageId];
    if (existing) {
      if (existing.pending || existing.root.isConnected) return existing.root;
      existing.destroy(); // 宿主页把挂件节点移除了,重新挂载
    }

    // 页面没调用过 initAntiFOUC 时补一次,保证选择后能立即生效
    if (currentPageId === null) initAntiFOUC(pageId);
    ensureStyle();

    var container = options.container && options.container.nodeType === 1 ? options.container : null;
    var position = POSITIONS.indexOf(options.position) >= 0 ? options.position : 'bottom-right';
    var menuId = 'lt-theme-menu-' + (++mountSeq);

    var root = el('div', 'lt-theme-root ' + (container ? 'lt-theme-inline' : 'lt-theme-floating lt-theme-pos-' + position));
    root.setAttribute('data-page', pageId);
    root.setAttribute('data-open', 'false');
    root.setAttribute('data-v', container || position.indexOf('top') === 0 ? 'down' : 'up');
    root.setAttribute('data-h', !container && position.slice(-5) === 'right' ? 'right' : 'left');

    var btn = el('button', 'lt-theme-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', menuId);
    var btnIcon = el('span', 'lt-theme-icon');
    btnIcon.setAttribute('aria-hidden', 'true');
    var btnLabel = el('span', 'lt-theme-label');
    btn.appendChild(btnIcon);
    btn.appendChild(btnLabel);

    var menu = el('div', 'lt-theme-menu');
    menu.id = menuId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '主题模式');
    var status = el('p', 'lt-theme-status');
    status.setAttribute('aria-live', 'polite');
    menu.appendChild(status);

    var items = MENU_OPTIONS.map(function (opt) {
      var item = el('button', 'lt-theme-item');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      item.setAttribute('data-mode', opt.mode);
      var ico = el('span', 'lt-theme-item-icon', opt.icon);
      ico.setAttribute('aria-hidden', 'true');
      var check = el('span', 'lt-theme-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      item.appendChild(ico);
      item.appendChild(el('span', 'lt-theme-item-text', opt.label));
      item.appendChild(check);
      menu.appendChild(item);
      return item;
    });

    root.appendChild(btn);
    root.appendChild(menu);

    var entry = { root: root, pending: false, destroyed: false, destroy: null };
    var open = false;

    function refresh() {
      var mode = getPageTheme(pageId);
      var theme = resolveEffectiveTheme(pageId);
      var modeText = '';
      items.forEach(function (item) {
        var on = item.getAttribute('data-mode') === mode;
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        if (on) modeText = item.querySelector('.lt-theme-item-text').textContent;
      });
      btnIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
      btnLabel.textContent = modeText;
      status.textContent = '当前:' + THEME_LABEL[theme];
      btn.setAttribute('aria-label', '主题设置,当前' + THEME_LABEL[theme] + '(' + modeText + ')');
      btn.title = '主题:' + modeText + ' · 当前' + THEME_LABEL[theme];
    }

    // 内联模式下菜单可能越出视口,打开前按剩余空间决定朝向
    function placeMenu() {
      if (!container) return;
      var rect = root.getBoundingClientRect();
      var w = menu.offsetWidth;
      var h = menu.offsetHeight;
      var vw = global.innerWidth || doc.documentElement.clientWidth;
      var vh = global.innerHeight || doc.documentElement.clientHeight;
      root.setAttribute('data-h', rect.left + w > vw - 8 && rect.right - w >= 8 ? 'right' : 'left');
      root.setAttribute('data-v', rect.bottom + 8 + h > vh && rect.top - 8 - h >= 0 ? 'up' : 'down');
    }

    function focusItem(index) {
      var n = items.length;
      items[((index % n) + n) % n].focus();
    }

    function selectedIndex() {
      for (var i = 0; i < items.length; i++) {
        if (items[i].getAttribute('aria-checked') === 'true') return i;
      }
      return 0;
    }

    function openMenu(focusIndex) {
      if (!open) {
        open = true;
        root.setAttribute('data-open', 'true'); // 先展开再量尺寸:收起时菜单是 display:none
        btn.setAttribute('aria-expanded', 'true');
        placeMenu();
      }
      focusItem(focusIndex === undefined ? selectedIndex() : focusIndex);
    }

    function closeMenu(returnFocus) {
      if (!open) return;
      open = false;
      root.setAttribute('data-open', 'false');
      btn.setAttribute('aria-expanded', 'false');
      if (returnFocus) btn.focus();
    }

    function onBtnClick() {
      if (open) closeMenu(false);
      else openMenu();
    }

    function onBtnKeydown(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(); }
      else if (e.key === 'Escape') closeMenu(false);
      else if (e.key === 'Tab' && e.shiftKey) closeMenu(false); // 焦点往回离开挂件
    }

    function onMenuKeydown(e) {
      var idx = items.indexOf(doc.activeElement);
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault(); focusItem(idx + 1); break;
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault(); focusItem(idx - 1); break;
        case 'Home':
          e.preventDefault(); focusItem(0); break;
        case 'End':
          e.preventDefault(); focusItem(items.length - 1); break;
        case 'Escape':
          e.preventDefault(); closeMenu(true); break;
        case 'Tab':
          // 焦点从最后一项往后离开时收起菜单(Tab 本身仍按浏览器默认行为移动)
          if (!e.shiftKey && idx === items.length - 1) closeMenu(false);
          break;
      }
    }

    function onItemClick(e) {
      var item = e.target.closest ? e.target.closest('.lt-theme-item') : null;
      if (!item || items.indexOf(item) < 0) return;
      setPageTheme(pageId, item.getAttribute('data-mode'));
      refresh(); // 主题事件已触发过 refresh;这里兜底保证存储不可用时 UI 也同步
      closeMenu(true);
    }

    function onOutside(e) {
      if (open && !root.contains(e.target)) closeMenu(false);
    }

    function onDocKeydown(e) {
      if (open && e.key === 'Escape') closeMenu(true);
    }

    btn.addEventListener('click', onBtnClick);
    btn.addEventListener('keydown', onBtnKeydown);
    menu.addEventListener('keydown', onMenuKeydown);
    menu.addEventListener('click', onItemClick);
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('click', onOutside, true);
    doc.addEventListener('keydown', onDocKeydown);
    var off = onChange(refresh); // 首页 / 其它标签页 / 系统主题变化时同步选中态与文案

    entry.destroy = function () {
      if (entry.destroyed) return;
      entry.destroyed = true;
      off();
      doc.removeEventListener('pointerdown', onOutside, true);
      doc.removeEventListener('click', onOutside, true);
      doc.removeEventListener('keydown', onDocKeydown);
      if (root.parentNode) root.parentNode.removeChild(root);
      if (mounts[pageId] === entry) delete mounts[pageId];
    };

    mounts[pageId] = entry;
    refresh();

    if (container) {
      container.appendChild(root);
    } else if (doc.body) {
      doc.body.appendChild(root);
    } else {
      // 脚本在 <head> 里提前调用时,等 body 出现再挂
      entry.pending = true;
      doc.addEventListener('DOMContentLoaded', function attach() {
        doc.removeEventListener('DOMContentLoaded', attach);
        entry.pending = false;
        if (!entry.destroyed && doc.body) doc.body.appendChild(root);
      });
    }
    return root;
  }

  function unmountThemeControl(pageId) {
    var entry = mounts[pageId];
    if (entry) entry.destroy();
  }

  global.LifeToolsTheme = {
    KEYS: KEYS,
    getGlobalTheme: getGlobalTheme,
    setGlobalTheme: setGlobalTheme,
    getPageTheme: getPageTheme,
    setPageTheme: setPageTheme,
    resolveEffectiveTheme: resolveEffectiveTheme,
    applyTheme: applyTheme,
    initAntiFOUC: initAntiFOUC,
    mountThemeControl: mountThemeControl,
    unmountThemeControl: unmountThemeControl,
    onChange: onChange
  };
})(window);
