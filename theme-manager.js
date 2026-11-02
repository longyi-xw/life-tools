/*
 * LifeTools 全站主题中枢 theme-manager.js(零依赖,仅暴露 window.LifeToolsTheme)
 *
 * 两个正交维度:
 *   明暗(theme):dark | light          —— 由「全局明暗模式」与「页面明暗模式」解析得到
 *   风格(style):classic | tech | fresh | paper(经典 / 科技 / 清新 / 书卷)
 *                                       —— 由「全局风格」与「页面风格」解析得到
 *   两个维度各自独立存储、独立解析,共同组成 4 风格 × 明暗 = 8 套配色。
 *
 * 用法:每个页面在 <head> 里、任何 <style> 之前同步引入并立刻初始化,避免刷新时闪白/闪黑/闪风格(FOUC):
 *   <meta name="color-scheme" content="light dark">
 *   <script src="theme-manager.js"></script>
 *   <script>window.LifeToolsTheme && LifeToolsTheme.initAntiFOUC('badminton');</script>
 *   <link rel="stylesheet" href="theme-tokens.css">
 * 页面样式只依赖 <html data-theme="dark|light" data-style="classic|tech|fresh|paper">,不要依赖 class。
 * 非首页可在 <body> 内调用 LifeToolsTheme.mountThemeControl('badminton') 挂载主题挂件。
 * initAntiFOUC 可重复调用(幂等):监听只注册一次,每次调用都会按最新存储重新应用并广播。
 *
 * 存储(localStorage,不可用时自动退化为内存值,绝不抛错;非法值一律回退默认,set 非法值直接忽略、不写存储):
 *   lifetools_global_theme        'auto' | 'dark' | 'light'                       默认 'auto'
 *   lifetools_page_theme_<pageId> 'follow' | 'dark' | 'light' | 'system'          默认 'follow'
 *   lifetools_global_style        'classic' | 'tech' | 'fresh' | 'paper'          默认 'classic'
 *   lifetools_page_style_<pageId> 'follow' | 'classic' | 'tech' | 'fresh' | 'paper'  默认 'follow'
 *   pageId 约定(取文件名短 slug,需全站唯一):
 *     home(index.html 首页,永不使用页面级覆盖)、badminton、interview、dcf、graham、earnings、
 *     etf、geopolitical、camera、reading、technical、trainer
 *   home 的 getPageTheme/getPageStyle 恒为 'follow',setPageTheme/setPageStyle 被忽略;
 *   空串或非字符串的 pageId 同样视为非法:读恒为 'follow'、写被忽略。
 *
 * 解析规则:
 *   resolveEffectiveTheme(pageId):home = 全局明暗(auto 取系统);其它页 = 页面显式 dark/light 优先,
 *                                  system 取系统,follow 取全局。
 *   resolveEffectiveStyle(pageId):home = 全局风格;其它页 = 页面显式风格优先,follow 取全局风格。
 *
 * 事件:window 上的 'lifetools:themechange',detail = { pageId, theme, mode, style, styleMode }
 *   theme 为生效明暗 'dark'|'light';mode 为该页面当前的明暗模式设置
 *   (非首页是页面模式 follow/dark/light/system,首页则是全局模式 auto/dark/light)。
 *   style 为生效风格 'classic'|'tech'|'fresh'|'paper';styleMode 为该页面当前的风格设置
 *   (非首页是页面风格 follow/classic/tech/fresh/paper,首页则是全局风格 id)。
 *   任何一次 applyTheme(含 setter、storage 跨标签页同步、系统明暗变化、initAntiFOUC)都会广播。
 *   onChange(cb) 的 cb 收到的是原生 CustomEvent,取值用 e.detail.theme / e.detail.style。
 *
 * DOM 契约:
 *   <html data-theme data-style> 以及 style.colorScheme(让滚动条、表单控件等原生部件跟随明暗)。
 *   主题挂件(mountThemeControl)结构:
 *     .lt-theme-root[data-page][data-open] > button.lt-theme-btn(图标 + 明暗模式文字 + .lt-theme-chip 当前风格:
 *       默认为右上角角标色块,悬浮且视口 > 480px 时展开为"色块 + 风格名";名称始终在 DOM / aria-label / title 中)
 *       + [role=menu].lt-theme-menu > p.lt-theme-status(aria-live)
 *         + [role=group][data-section=mode][aria-label=明暗模式] > 4 个 button[role=menuitemradio][data-mode]
 *         + [role=group][data-section=style][aria-label=风格]   > 5 个 button[role=menuitemradio][data-style]
 *           (follow=跟随首页,及 classic/tech/fresh/paper;每个风格项带 .lt-theme-swatch 小色块与文字)
 *   键盘:菜单内 Arrow 上下左右 / Home / End 在全部 9 项间循环移动,Esc 收起并还原焦点,
 *   Tab 从最后一项向后离开或 Shift+Tab 从按钮向前离开时收起;所有项触控高度 ≥ 40px。
 *
 * API:getGlobalTheme / setGlobalTheme / getPageTheme / setPageTheme / resolveEffectiveTheme /
 *      getGlobalStyle / setGlobalStyle / getPageStyle / setPageStyle / resolveEffectiveStyle /
 *      applyTheme / initAntiFOUC / mountThemeControl / unmountThemeControl / onChange /
 *      KEYS(GLOBAL / PAGE_PREFIX / GLOBAL_STYLE / PAGE_STYLE_PREFIX) /
 *      STYLES(只读冻结数组 [{ id, label, swatch: [c1 背景代表色, c2 强调代表色] }],顺序 classic/tech/fresh/paper,
 *             取值 = 各风格原生明暗下 theme-tokens.css 的 --lt-bg / --lt-accent,供首页风格选择器与子页挂件渲染色块;
 *             色块在深浅两种页面底色上都要可辨,所以渲染方需给色块加描边环,不要只靠色块本身的明度)
 *
 * 挂件样式:全部自包含在 #lt-theme-style 里,配色优先取 theme-tokens.css 的 --lt-* 令牌(var(--lt-text, 回退值)),
 * 回退值是令牌文件缺失时的硬编码配色,所以缺文件时挂件照常可读。选择器统一叠两层 .lt-theme-root 提高特异性并对
 * 每个子节点 all:initial 后再显式声明,宿主页的全局 button / p / div 选择器、body 的 font / line-height / color /
 * letter-spacing / text-transform 都不会改变挂件外观(宿主若用 #id 或 !important 强行命中挂件内部节点则不在保护范围)。
 */
(function (global) {
  'use strict';

  var doc = global.document;

  var KEYS = Object.freeze({
    GLOBAL: 'lifetools_global_theme',
    PAGE_PREFIX: 'lifetools_page_theme_',
    GLOBAL_STYLE: 'lifetools_global_style',
    PAGE_STYLE_PREFIX: 'lifetools_page_style_'
  });
  var EVENT_NAME = 'lifetools:themechange';
  var HOME_ID = 'home';
  var DARK_QUERY = '(prefers-color-scheme: dark)';
  var GLOBAL_MODES = ['auto', 'dark', 'light'];
  var PAGE_MODES = ['follow', 'dark', 'light', 'system'];
  var THEME_LABEL = { dark: '深色', light: '浅色' };

  // 风格清单:顺序即展示顺序;swatch = [c1 背景代表色, c2 强调代表色],仅用于渲染小色块(真实配色在 theme-tokens.css)。
  // 取值 = 各风格「原生明暗」下 theme-tokens.css 的 --lt-bg / --lt-accent:classic、tech 取深色块,
  // fresh、paper 取浅色块(清新浅色优先、书卷是暖纸色)。两个代表色互相 >= 3:1,色块一分为二仍能分辨;
  // 与页面底色的区分靠色块自带的描边环(见下方 CSS:1px 外环取 --lt-theme-muted,对挂件底色 >= 5:1),所以深浅宿主上都可辨,不依赖色块本身的明度。
  function freezeStyle(id, label, c1, c2) {
    return Object.freeze({ id: id, label: label, swatch: Object.freeze([c1, c2]) });
  }
  var STYLES = Object.freeze([
    freezeStyle('classic', '经典', '#080a0d', '#c8a84b'),
    freezeStyle('tech', '科技', '#0b1120', '#26b5f2'),
    freezeStyle('fresh', '清新', '#e8f3f0', '#0a5f52'),
    freezeStyle('paper', '书卷', '#f2ebdd', '#9c2f1a')
  ]);
  var STYLE_IDS = STYLES.map(function (s) { return s.id; });
  var DEFAULT_STYLE = 'classic';
  var PAGE_STYLE_MODES = ['follow'].concat(STYLE_IDS);
  var STYLE_BY_ID = {};
  STYLES.forEach(function (s) { STYLE_BY_ID[s.id] = s; });

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

  function pageStyleKey(pageId) {
    return KEYS.PAGE_STYLE_PREFIX + pageId;
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

  /* 风格维度:与明暗完全平行,但没有"跟随系统"这一项 */
  function getGlobalStyle() {
    var v = readRaw(KEYS.GLOBAL_STYLE);
    return STYLE_IDS.indexOf(v) >= 0 ? v : DEFAULT_STYLE;
  }

  function getPageStyle(pageId) {
    // 首页恒等于全局风格,不存在页面级覆盖
    if (!validPageId(pageId) || pageId === HOME_ID) return 'follow';
    var v = readRaw(pageStyleKey(pageId));
    return PAGE_STYLE_MODES.indexOf(v) >= 0 ? v : 'follow';
  }

  function resolveEffectiveStyle(pageId) {
    if (pageId === HOME_ID) return getGlobalStyle();
    var mode = getPageStyle(pageId);
    return mode === 'follow' ? getGlobalStyle() : mode;
  }

  function styleModeOf(pageId) {
    return pageId === HOME_ID ? getGlobalStyle() : getPageStyle(pageId);
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
    var style = resolveEffectiveStyle(pageId);
    try {
      var root = doc.documentElement;
      root.setAttribute('data-theme', theme);
      root.setAttribute('data-style', style);
      root.style.colorScheme = theme; // 让滚动条、表单控件等原生部件跟着变
    } catch (e) { /* 极端环境下 DOM 不可写,忽略 */ }
    emit({ pageId: pageId, theme: theme, mode: modeOf(pageId), style: style, styleMode: styleModeOf(pageId) });
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

  function setGlobalStyle(style) {
    if (STYLE_IDS.indexOf(style) < 0) return; // 非法值直接忽略,不污染存储
    writeRaw(KEYS.GLOBAL_STYLE, style);
    applyCurrent();
  }

  function setPageStyle(pageId, style) {
    // 首页没有页面级覆盖,直接忽略
    if (!validPageId(pageId) || pageId === HOME_ID || PAGE_STYLE_MODES.indexOf(style) < 0) return;
    writeRaw(pageStyleKey(pageId), style);
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
    if (e.key === null || e.key === KEYS.GLOBAL || e.key === pageKey(currentPageId) ||
        e.key === KEYS.GLOBAL_STYLE || e.key === pageStyleKey(currentPageId)) {
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
  var STYLE_OPTIONS = [{ id: 'follow', label: '跟随首页' }].concat(STYLES.map(function (s) {
    return { id: s.id, label: s.label };
  }));
  var POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  var mounts = {};
  var mountSeq = 0;

  /* 选择器前缀 R:叠两层类名 -> 根节点特异性 (0,2,0)、子孙 (0,3,0),盖过宿主的 `.toolbar button` 之类选择器;
     每个子节点先 all:initial 抹掉宿主对 button / p / div / span 的全局样式,再逐项显式声明(必须排在其它规则之前)。
     令牌:--lt-theme-* 是挂件内部变量,值优先取 theme-tokens.css 的 --lt-*,var() 逗号后是令牌缺失时的硬编码回退。 */
  var R = '.lt-theme-root.lt-theme-root';
  var DARK = 'html[data-theme="dark"] ';
  var GLASS = '((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px)))';
  var FONT_SYS = 'system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';
  var NODES = ['btn', 'menu', 'status', 'group', 'group-title', 'item', 'icon', 'label', 'chip', 'chip-text',
    'swatch', 'item-icon', 'item-swatch', 'item-text', 'check'];

  var CSS = [
    /* 根节点:默认浅色;html[data-theme=dark] 时切深色。color-scheme 让菜单滚动条跟随明暗 */
    R + '{all:initial;direction:ltr;color-scheme:light;',
    '--lt-theme-fg:var(--lt-text,#24201a);--lt-theme-muted:var(--lt-text-muted,#6b6457);',
    '--lt-theme-accent:var(--lt-accent-strong,#7a5a14);--lt-theme-accent-soft:var(--lt-accent-soft,rgba(122,90,20,.12));',
    '--lt-theme-hover:rgba(36,32,26,.06);--lt-theme-bg:var(--lt-surface,rgba(255,255,255,.97));--lt-theme-halo:var(--lt-surface,#fff);',
    /* border = 装饰分隔线;edge = 承载信息的边界(按钮 / 菜单 / 色块描边环,令牌保证 >= 3:1) */
    '--lt-theme-border:var(--lt-border,rgba(36,32,26,.16));--lt-theme-edge:var(--lt-border-strong,#8a8272);',
    '--lt-theme-focus:var(--lt-focus,#7a5a14);',
    '--lt-theme-shadow:var(--lt-shadow,0 8px 28px rgba(36,32,26,.16),0 1px 3px rgba(36,32,26,.12));',
    '--lt-theme-r:var(--lt-radius,16px);--lt-theme-r-sm:var(--lt-radius-sm,11px);',
    '--lt-theme-font-h:var(--lt-font-heading,' + FONT_SYS + ');',
    'position:relative;display:inline-block;box-sizing:border-box;margin:0;padding:0;color:var(--lt-theme-fg);',
    'font:14px/1.4 ' + FONT_SYS + ';text-align:left}',
    DARK + R + '{color-scheme:dark;',
    '--lt-theme-fg:var(--lt-text,#ddd8cc);--lt-theme-muted:var(--lt-text-muted,#9aa3b5);',
    '--lt-theme-accent:var(--lt-accent-strong,#e8c56a);--lt-theme-accent-soft:var(--lt-accent-soft,rgba(232,197,106,.16));',
    '--lt-theme-hover:rgba(255,255,255,.07);--lt-theme-bg:var(--lt-surface,rgba(22,28,38,.97));--lt-theme-halo:var(--lt-surface,#161c26);',
    '--lt-theme-border:var(--lt-border,rgba(255,255,255,.14));--lt-theme-edge:var(--lt-border-strong,#67738b);',
    '--lt-theme-focus:var(--lt-focus,#e8c56a);',
    '--lt-theme-shadow:var(--lt-shadow,0 10px 32px rgba(0,0,0,.55),0 1px 3px rgba(0,0,0,.4))}',
    /* 毛玻璃:令牌里的 surface 是不透明色,有 color-mix 时压成 97% 不透明(最差情形是深色菜单压在纯白宿主上,正文与弱化文字
       仍 >= 5.9:1,按钮 / 菜单边界对挂件底色 >= 3.2:1);不支持 color-mix 就直接用不透明 surface;令牌缺失时回退成同样 97% 不透明的
       硬编码色(原 74% / 70% 在反色宿主上对比度不足) */
    '@supports (background:color-mix(in srgb,red,blue)){' + R + '{--lt-theme-glass:color-mix(in srgb,var(--lt-surface) 97%,transparent)}}',
    '@supports ' + GLASS + '{' + R + '{--lt-theme-bg:var(--lt-theme-glass,var(--lt-surface,rgba(255,255,255,.97)))}',
    DARK + R + '{--lt-theme-bg:var(--lt-theme-glass,var(--lt-surface,rgba(22,28,38,.97)))}}',
    /* 子节点统一重置(all:initial 会清掉 box-sizing / font / color,所以紧跟着显式继承回来) */
    NODES.map(function (n) { return R + ' .lt-theme-' + n; }).join(',') +
      '{all:initial;box-sizing:border-box;font:inherit;color:inherit;text-align:inherit;-webkit-tap-highlight-color:transparent}',
    R + '.lt-theme-floating{position:fixed;z-index:100000}',
    R + '.lt-theme-pos-bottom-right{right:16px;bottom:16px;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom))}',
    R + '.lt-theme-pos-bottom-left{left:16px;bottom:16px;left:max(16px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom))}',
    R + '.lt-theme-pos-top-right{right:16px;top:16px;right:max(16px,env(safe-area-inset-right));top:max(16px,env(safe-area-inset-top))}',
    R + '.lt-theme-pos-top-left{left:16px;top:16px;left:max(16px,env(safe-area-inset-left));top:max(16px,env(safe-area-inset-top))}',
    /* 触发按钮:边框用 edge(>= 3:1);科技 / 书卷风格是小圆角方钮,其余保持胶囊 */
    R + ' .lt-theme-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;',
    'min-width:44px;min-height:44px;margin:0;padding:0 14px;border:1px solid var(--lt-theme-edge);border-radius:999px;',
    'background:var(--lt-theme-bg);color:var(--lt-theme-fg);font-weight:600;cursor:pointer;',
    'box-shadow:var(--lt-theme-shadow);',
    'transition:transform .18s ease,border-color .2s ease,box-shadow .2s ease,background-color .2s ease,color .2s ease}',
    'html[data-style="tech"] ' + R + ' .lt-theme-btn{border-radius:var(--lt-radius,8px)}',
    'html[data-style="paper"] ' + R + ' .lt-theme-btn{border-radius:var(--lt-radius,4px)}',
    R + '.lt-theme-inline .lt-theme-btn{box-shadow:none}',
    R + ' .lt-theme-btn:hover{border-color:var(--lt-theme-accent);transform:translateY(-1px)}',
    R + ' .lt-theme-btn:active{transform:scale(.97)}',
    /* 焦点环:2px 焦点色 + 2px 底色光晕(落在 outline-offset 的间隙里)。环的内侧邻居恒为 surface(令牌保证 >= 3:1),
       所以无论宿主背景是深是浅、是纯色还是花哨图案,环都能被看见 */
    R + ' .lt-theme-btn:focus-visible,' + R + ' .lt-theme-item:focus-visible{outline:2px solid var(--lt-theme-focus);outline-offset:2px}',
    R + ' .lt-theme-btn:focus-visible{box-shadow:0 0 0 2px var(--lt-theme-halo),var(--lt-theme-shadow)}',
    R + '.lt-theme-inline .lt-theme-btn:focus-visible{box-shadow:0 0 0 2px var(--lt-theme-halo)}',
    R + ' .lt-theme-icon{display:inline-block;font-size:18px;line-height:1;transition:transform .35s cubic-bezier(.34,1.56,.64,1)}',
    R + '[data-open="true"] .lt-theme-icon{transform:rotate(24deg) scale(1.12)}',
    R + ' .lt-theme-label{font-family:var(--lt-theme-font-h)}',
    /* 按钮里的"当前风格"小标:默认是按钮右上角的角标色块(零宽度占用,内联进窄顶栏不挤标题);
       悬浮且视口 > 480px 时展开为 色块 + 名称 */
    R + ' .lt-theme-chip{position:absolute;top:3px;right:4px;display:block;font-weight:500}',
    /* 角标色块会骑在胶囊圆角上、一部分落到宿主背景里,所以环外再加一圈 surface 色光晕:环的邻居恒为 surface,不依赖宿主底色 */
    R + ' .lt-theme-chip .lt-theme-swatch{display:block;width:10px;height:10px;box-shadow:0 0 0 1px var(--lt-theme-muted),0 0 0 2px var(--lt-theme-halo)}',
    R + ' .lt-theme-chip-text{display:none}',
    '@media (min-width:481px){',
    R + '.lt-theme-floating .lt-theme-chip{position:static;display:inline-flex;align-items:center;gap:6px}',
    R + '.lt-theme-floating .lt-theme-chip .lt-theme-swatch{width:14px;height:14px}',
    R + '.lt-theme-floating .lt-theme-chip-text{display:inline}}',
    /* 风格色块:左上背景代表色、右下强调代表色;外描边环取 muted(令牌保证对 surface >= 5:1,叠在选中淡底、半透明毛玻璃压在反色宿主上仍 >= 3:1),
       让色块在深浅宿主和选中底色上都有清晰轮廓 */
    R + ' .lt-theme-swatch{display:inline-block;flex:none;width:18px;height:18px;border-radius:50%;',
    'background:#999;background:linear-gradient(135deg,var(--lt-sw1,#999) 50%,var(--lt-sw2,#ccc) 50%);',
    'box-shadow:0 0 0 1px var(--lt-theme-muted)}',
    /* 收起时 display:none:既不占滚动区域(否则靠右的内联菜单会撑出横向滚动条),也不会进入 Tab 序列 */
    R + ' .lt-theme-menu{position:absolute;z-index:1;display:none;min-width:192px;max-width:calc(100vw - 32px);padding:6px;',
    'border:1px solid var(--lt-theme-edge);border-radius:var(--lt-theme-r);',
    'background:var(--lt-theme-bg);color:var(--lt-theme-fg);box-shadow:var(--lt-theme-shadow);',
    /* 菜单变长后矮屏放不下时在内部滚动,键盘聚焦的项会被浏览器自动滚入视野 */
    'max-height:calc(100vh - 96px);max-height:calc(100dvh - 96px);overflow-y:auto;overscroll-behavior:contain;',
    'opacity:0;transform:translateY(6px) scale(.97);',
    'transition:opacity .18s ease,transform .18s ease;',
    'transition:opacity .18s ease,transform .18s ease,display .18s allow-discrete}', /* 不支持 allow-discrete 时上一行生效:只是少了淡出 */
    R + '[data-open="true"] .lt-theme-menu{display:block;opacity:1;transform:none}',
    '@starting-style{' + R + '[data-open="true"] .lt-theme-menu{opacity:0;transform:translateY(6px) scale(.97)}}',
    R + '[data-v="up"] .lt-theme-menu{bottom:calc(100% + 8px)}',
    R + '[data-v="down"] .lt-theme-menu{top:calc(100% + 8px);transform:translateY(-6px) scale(.97)}',
    R + '[data-v="down"][data-open="true"] .lt-theme-menu{transform:none}',
    '@starting-style{' + R + '[data-v="down"][data-open="true"] .lt-theme-menu{transform:translateY(-6px) scale(.97)}}',
    R + '[data-h="right"] .lt-theme-menu{right:0}',
    R + '[data-h="left"] .lt-theme-menu{left:0}',
    R + ' .lt-theme-status{display:block;margin:0;padding:8px 12px 6px;font-size:12px;letter-spacing:.02em;color:var(--lt-theme-muted)}',
    R + ' .lt-theme-group{display:block;margin:0;padding:0}',
    R + ' .lt-theme-group-title{display:block;margin:4px 0 0;padding:8px 12px 4px;border-top:1px solid var(--lt-theme-border);',
    'font-family:var(--lt-theme-font-h);font-size:12px;letter-spacing:.02em;color:var(--lt-theme-muted)}',
    R + ' .lt-theme-item{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;',
    'margin:0;padding:0 12px;border:0;border-radius:var(--lt-theme-r-sm);background:transparent;color:inherit;',
    'cursor:pointer;transition:background-color .15s ease,color .15s ease}',
    R + ' .lt-theme-item:hover{background:var(--lt-theme-hover)}',
    /* 选中态:accent-soft 淡底 + accent-strong 文字 + 1px 内描边 + ✓(令牌保证叠在 surface 上 >= 5:1;内描边让选中项边界 >= 3:1,不只靠淡底) */
    R + ' .lt-theme-item[aria-checked="true"]{background:var(--lt-theme-accent-soft);color:var(--lt-theme-accent);font-weight:600;box-shadow:inset 0 0 0 1px var(--lt-theme-accent)}',
    R + ' .lt-theme-item:focus-visible{box-shadow:0 0 0 2px var(--lt-theme-halo)}',
    R + ' .lt-theme-item[aria-checked="true"]:focus-visible{box-shadow:inset 0 0 0 1px var(--lt-theme-accent),0 0 0 2px var(--lt-theme-halo)}',
    R + ' .lt-theme-item-icon{display:block;width:20px;text-align:center;font-size:16px;line-height:1}',
    R + ' .lt-theme-style-item{min-height:40px}',
    R + ' .lt-theme-item-swatch{display:inline-flex;width:20px;justify-content:center}',
    R + ' .lt-theme-check{margin-left:auto;opacity:0;font-weight:700;transition:opacity .15s ease}',
    R + ' .lt-theme-item[aria-checked="true"] .lt-theme-check{opacity:1}',
    '@supports ' + GLASS + '{' + R + ' .lt-theme-btn,' + R + ' .lt-theme-menu{-webkit-backdrop-filter:blur(14px) saturate(1.5);backdrop-filter:blur(14px) saturate(1.5)}}',
    '@media (max-width:480px){',
    R + '.lt-theme-floating .lt-theme-btn{padding:0}' + R + '.lt-theme-floating .lt-theme-label{display:none}}',
    /* 系统要求更高对比度时,边界直接用正文色并加粗 */
    '@media (prefers-contrast:more){' + R + ',' + DARK + R + '{--lt-theme-edge:var(--lt-theme-fg)}',
    R + ' .lt-theme-btn,' + R + ' .lt-theme-menu{border-width:2px}}',
    '@media (prefers-reduced-motion:reduce){',
    R + ' *{transition-duration:.01ms!important;transition-delay:0s!important;animation:none!important}}'
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

  // 给色块节点写入两个代表色(走 CSSOM,不依赖 style 属性解析,CSP 友好)
  function paintSwatch(node, styleId) {
    var def = STYLE_BY_ID[styleId];
    if (!def) return;
    node.style.setProperty('--lt-sw1', def.swatch[0]);
    node.style.setProperty('--lt-sw2', def.swatch[1]);
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
    var btnChip = el('span', 'lt-theme-chip');
    var btnSwatch = el('span', 'lt-theme-swatch');
    btnSwatch.setAttribute('aria-hidden', 'true');
    var btnChipText = el('span', 'lt-theme-chip-text');
    btnChip.appendChild(btnSwatch);
    btnChip.appendChild(btnChipText);
    btn.appendChild(btnIcon);
    btn.appendChild(btnLabel);
    btn.appendChild(btnChip);

    var menu = el('div', 'lt-theme-menu');
    menu.id = menuId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '主题模式');
    var status = el('p', 'lt-theme-status');
    status.setAttribute('aria-live', 'polite');
    menu.appendChild(status);

    // 一个可选项:[图标或色块] 文字 [✓];图标节点由调用方决定,aria-checked 由 refresh 维护
    function makeItem(extraClass, iconNode, label) {
      var item = el('button', 'lt-theme-item' + extraClass);
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', 'false');
      iconNode.setAttribute('aria-hidden', 'true');
      var check = el('span', 'lt-theme-check', '✓');
      check.setAttribute('aria-hidden', 'true');
      item.appendChild(iconNode);
      item.appendChild(el('span', 'lt-theme-item-text', label));
      item.appendChild(check);
      return item;
    }

    function makeGroup(section, label) {
      var g = el('div', 'lt-theme-group');
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', label);
      g.setAttribute('data-section', section);
      menu.appendChild(g);
      return g;
    }

    // 分区 1:明暗模式(原有 4 项,data-mode 与顺序保持不变)
    var modeGroup = makeGroup('mode', '明暗模式');
    var modeItems = MENU_OPTIONS.map(function (opt) {
      var item = makeItem('', el('span', 'lt-theme-item-icon', opt.icon), opt.label);
      item.setAttribute('data-mode', opt.mode);
      modeGroup.appendChild(item);
      return item;
    });

    // 分区 2:风格(跟随首页 + 4 风格);标题仅作视觉分隔,语义由 group 的 aria-label 提供
    var styleGroup = makeGroup('style', '风格');
    var styleTitle = el('div', 'lt-theme-group-title', '风格');
    styleTitle.setAttribute('aria-hidden', 'true');
    styleGroup.appendChild(styleTitle);
    var styleItems = STYLE_OPTIONS.map(function (opt) {
      var icon;
      if (opt.id === 'follow') {
        icon = el('span', 'lt-theme-item-icon', '🏠');
      } else {
        icon = el('span', 'lt-theme-item-swatch');
        var sw = el('span', 'lt-theme-swatch');
        paintSwatch(sw, opt.id);
        icon.appendChild(sw);
      }
      var item = makeItem(' lt-theme-style-item', icon, opt.label);
      item.setAttribute('data-style', opt.id);
      styleGroup.appendChild(item);
      return item;
    });

    // 键盘导航与焦点管理覆盖的全部菜单项(DOM 顺序)
    var items = modeItems.concat(styleItems);

    root.appendChild(btn);
    root.appendChild(menu);

    var entry = { root: root, pending: false, destroyed: false, destroy: null };
    var open = false;

    function refresh() {
      var mode = getPageTheme(pageId);
      var theme = resolveEffectiveTheme(pageId);
      var styleMode = getPageStyle(pageId);
      var style = resolveEffectiveStyle(pageId);
      var styleDef = STYLE_BY_ID[style];
      var modeText = '';
      var styleModeText = '';
      modeItems.forEach(function (item) {
        var on = item.getAttribute('data-mode') === mode;
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        if (on) modeText = item.querySelector('.lt-theme-item-text').textContent;
      });
      styleItems.forEach(function (item) {
        var on = item.getAttribute('data-style') === styleMode;
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        if (on) styleModeText = item.querySelector('.lt-theme-item-text').textContent;
      });
      btnIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
      btnLabel.textContent = modeText;
      paintSwatch(btnSwatch, style);
      btnChipText.textContent = styleDef.label;
      var styleNote = styleMode === 'follow' ? styleDef.label + '(' + styleModeText + ')' : styleDef.label;
      status.textContent = '当前:' + THEME_LABEL[theme];
      btn.setAttribute('aria-label', '主题设置,当前' + THEME_LABEL[theme] + '(' + modeText + '),风格:' + styleNote);
      btn.title = '主题:' + modeText + ' · 当前' + THEME_LABEL[theme] + ' · 风格:' + styleNote;
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
      if (modeItems.indexOf(item) >= 0) setPageTheme(pageId, item.getAttribute('data-mode'));
      else setPageStyle(pageId, item.getAttribute('data-style'));
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
    STYLES: STYLES,
    getGlobalStyle: getGlobalStyle,
    setGlobalStyle: setGlobalStyle,
    getPageStyle: getPageStyle,
    setPageStyle: setPageStyle,
    resolveEffectiveStyle: resolveEffectiveStyle,
    applyTheme: applyTheme,
    initAntiFOUC: initAntiFOUC,
    mountThemeControl: mountThemeControl,
    unmountThemeControl: unmountThemeControl,
    onChange: onChange
  };
})(window);
