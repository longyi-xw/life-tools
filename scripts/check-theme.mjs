#!/usr/bin/env node
/*
 * check-theme.mjs -- LifeTools 全站主题接入静态检查(开发期工具,只读,不进入页面运行时)
 *
 * Node >= 22,零 npm 依赖,不启动浏览器,不修改任何文件。逐页断言「新页面必须同步首页主题」的机器可验证部分,
 * 与 CLAUDE.md 的强制清单、theme-manager.js / theme-tokens.css 的头注释保持一致。
 * 对比度是否达标不在这里查,由 scripts/audit-contrast.mjs 负责。
 *
 * ---------------------------------------------------------------------------------------------
 * 用法
 *   node scripts/check-theme.mjs [选项]
 *   --root <dir>   被检查的站点根目录(默认:本脚本所在仓库根;用于对夹具目录自测)。
 *                  页面 = root 下(不递归)的 *.html / *.htm,tests/、docs/ 等子目录天然不在其中
 *   --json         机读 JSON 输出到 stdout(不再打印表格)
 *   --page a,b     只展示/判定这些页面(文件名、不含扩展名的文件名或 pageId,逗号分隔);
 *                  pageId 唯一性与首页卡片仍基于 root 下全部页面计算
 *   -h, --help     打印本说明
 *   退出码:0 全部通过;1 有页面未通过;2 参数错误 / root 不存在 / root 下没有 html 页面。
 *
 * ---------------------------------------------------------------------------------------------
 * 逐页断言(每项在表格里一列,失败时在表格下方列出原因与行号)
 *   head      <head> 内按序出现且早于文档中第一个 <style>:
 *               1) <meta name="color-scheme" content="light dark">
 *               2) <script src="theme-manager.js"></script>(同步,不得 async / defer / type=module)
 *               3) 内联脚本 initAntiFOUC('<pageId>')(非 type=module)
 *               4) <link rel="stylesheet" href="theme-tokens.css">(同步,不得带 async / defer / media / onload / disabled)
 *             被 HTML 注释包起来的不算;放在 <body> 里的不算。
 *   map       某个 <style> 内的 CSS 注释含 LT-THEME-MAP(写法见 CLAUDE.md,注释文字为 LT-THEME-MAP)。
 *   media     没有任何 prefers-color-scheme:<style> 内(去掉 CSS 注释后)、内联 <script> 内(去掉 JS 注释后,
 *             如 matchMedia('(prefers-color-scheme: dark)'))、任意标签的 media 属性(如 <meta name="theme-color" media=...>)。
 *             「跟随系统」由 theme-manager 的 auto / system 模式承担,页面不得自己读。不做任何白名单。
 *   storage   除 lifetools_* 外无自建主题存储键:只看内联 <script> 里 localStorage / sessionStorage 的
 *             getItem / setItem / removeItem 字面量键(含 ['x'] / .x 属性写法与 `模板`),键名匹配
 *             /theme|dark|light|mode|skin|style/i 且不以 lifetools_ 开头才算违规。变量键(getItem(k))无法静态判定,
 *             不算;业务键(CK_KEY、kegelTimer* 等)不匹配该正则就不算。注释、<pre> 里的示例代码、正文文字都不扫。
 *   pageId    1) 能从 initAntiFOUC('<id>') 读到字面量 id,且是小写 slug(^[a-z][a-z0-9]*(-[a-z0-9]+)*$);
 *             2) 全站唯一;3) index.html 必须是 home,且 home 只能属于 index.html;
 *             4) home 不得调用 mountThemeControl;非 home 必须调用,且每次调用的字面量参数都等于 initAntiFOUC 的 id。
 *   card      (index.html 自身无此项)index.html 里存在 <a href="该文件" ... data-cat data-name ...>:
 *             data-cat 非空且每个词 ∈ life / macro / value / quant / risk(可空格组合),data-name 非空。
 *   favicon   存在 <link rel="icon" href="data:image/svg+xml,...">(也接受 ;base64),且解码后含 <svg。
 *
 * 提示(warning,不影响退出码,表格下方「提示」段与 JSON 的 warnings 字段):
 *   - initAntiFOUC 调用没有 window.LifeToolsTheme && 之类的守卫(theme-manager.js 缺失时会抛 ReferenceError)
 *   - 页面里有不带回退值的 var(--lt-*)(theme-tokens.css 缺失时页面会崩)
 *   - LT-THEME-MAP 所在 <style> 里没有 [data-style] 选择器
 *   - 文件含 UTF-8 BOM 或不是合法 UTF-8
 *
 * ---------------------------------------------------------------------------------------------
 * 实现要点与已知边界
 *   - 不用「整文件一条大正则」:面试宝典约 1.5MB 且含超长单行,脚本先用线性的 HTML 标签扫描器(indexOf + 引号感知)
 *     切出 <head> 区间 / <style> / <script> 元素,再只对元素内容做匹配;所有正则都是线性的、无嵌套量词,不会灾难性回溯。
 *   - 只检查内联 <script> / <style>;外链的本地 .js / .css 文件不在范围内(目前站内只有 theme-manager.js 与
 *     badminton-algorithm.js)。内联事件属性(onclick="localStorage...")不扫。
 *   - 键名是变量时(getItem(k)、getItem(KEY))不解析:压缩代码里变量名会跨作用域复用,强行解析只会产生误报。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOME_FILE = 'index.html';
const HOME_ID = 'home';
const CATS = ['life', 'macro', 'value', 'quant', 'risk'];
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const THEME_KEY_RE = /theme|dark|light|mode|skin|style/i;
const OWN_KEY_PREFIX = 'lifetools_';
const STORAGE_METHODS = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length']);

const CHECKS = [
  { key: 'head', label: 'head四行' },
  { key: 'map', label: 'THEME-MAP' },
  { key: 'media', label: '无系统明暗查询' },
  { key: 'storage', label: '存储键' },
  { key: 'pageId', label: 'ID与挂件' },
  { key: 'card', label: '首页卡片' },
  { key: 'favicon', label: 'Favicon' }
];

/* =============================================================================================
 * 命令行
 * ============================================================================================= */
function usage() {
  return [
    '用法: node scripts/check-theme.mjs [--root <dir>] [--json] [--page a,b]',
    '  --root <dir>  被检查的站点根目录(默认:仓库根)',
    '  --json        输出 JSON',
    '  --page a,b    只展示/判定这些页面(文件名或 pageId)',
    '  -h, --help    显示帮助',
    '退出码: 0 全部通过; 1 有页面未通过; 2 参数错误'
  ].join('\n');
}

function parseArgs(argv) {
  const o = { root: null, json: false, page: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline = null;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const take = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new Error(`${a} 缺少参数值`);
      return argv[++i];
    };
    if (a === '--root') o.root = take();
    else if (a === '--json') o.json = true;
    else if (a === '--page') o.page = take().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  return o;
}

/* =============================================================================================
 * 位置换算(offset -> 行/列)
 * ============================================================================================= */
function makeLocator(src) {
  const nl = [];
  for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) nl.push(i);
  // 返回 pos 之前换行符的个数
  const before = (pos) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nl[mid] < pos) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  return (pos) => {
    const k = before(pos);
    const lineStart = k === 0 ? 0 : nl[k - 1] + 1;
    const lineEnd = k < nl.length ? nl[k] : src.length;
    return { line: k + 1, col: pos - lineStart + 1, long: lineEnd - lineStart > 200 };
  };
}

function fmtLoc(l) {
  return l.long ? `行${l.line}列${l.col}` : `行${l.line}`;
}

/* =============================================================================================
 * HTML 标签扫描器(线性、引号感知;只对关注的标签解析属性)
 * ============================================================================================= */
const ATTR_TAGS = new Set(['link', 'meta', 'script', 'style', 'a', 'source', 'head', 'body', 'html', 'base']);
const RAW_TEXT = new Set(['script', 'style']);

function readTag(src, p, wantAttrs) {
  const n = src.length;
  const attrs = wantAttrs ? Object.create(null) : null;
  while (p < n) {
    let c = src.charCodeAt(p);
    if (c === 62) return { end: p + 1, attrs }; // >
    if (c <= 32 || c === 47) { p++; continue; } // 空白或 /
    const s = p;
    while (p < n) {
      c = src.charCodeAt(p);
      if (c <= 32 || c === 47 || c === 62 || c === 61) break;
      p++;
    }
    const name = src.slice(s, p).toLowerCase();
    let q = p;
    while (q < n && src.charCodeAt(q) <= 32) q++;
    let value = '';
    if (src.charCodeAt(q) === 61) { // =
      q++;
      while (q < n && src.charCodeAt(q) <= 32) q++;
      const qc = src.charCodeAt(q);
      if (qc === 34 || qc === 39) {
        const e = src.indexOf(qc === 34 ? '"' : "'", q + 1);
        value = src.slice(q + 1, e < 0 ? n : e);
        p = e < 0 ? n : e + 1;
      } else {
        const s2 = q;
        while (q < n) {
          c = src.charCodeAt(q);
          if (c <= 32 || c === 62) break;
          q++;
        }
        value = src.slice(s2, q);
        p = q;
      }
    }
    if (attrs && name && !(name in attrs)) attrs[name] = value;
  }
  return { end: n, attrs };
}

function scanHtml(src) {
  const tags = [];
  const n = src.length;
  const reOpen = /<([A-Za-z][A-Za-z0-9:-]*)/y;
  const reClose = /<\/([A-Za-z][A-Za-z0-9:-]*)/y;
  let headCloseStart = -1;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) {
      const e = src.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const c1 = src.charCodeAt(lt + 1);
    if (c1 === 33 || c1 === 63) { // <! 或 <?
      const e = src.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c1 === 47) { // </
      reClose.lastIndex = lt;
      const m = reClose.exec(src);
      if (m) {
        if (headCloseStart < 0 && m[1].toLowerCase() === 'head') headCloseStart = lt;
        const e = src.indexOf('>', lt + 2);
        i = e < 0 ? n : e + 1;
      } else {
        i = lt + 1;
      }
      continue;
    }
    reOpen.lastIndex = lt;
    const m = reOpen.exec(src);
    if (!m) { i = lt + 1; continue; }
    const name = m[1].toLowerCase();
    const { end, attrs } = readTag(src, lt + m[0].length, ATTR_TAGS.has(name));
    const tag = { name, start: lt, end, attrs: attrs || {} };
    i = end;
    if (RAW_TEXT.has(name)) {
      const re = new RegExp('</' + name + '(?=[\\s>/])', 'gi');
      re.lastIndex = end;
      const cm = re.exec(src);
      const closeStart = cm ? cm.index : n;
      tag.text = src.slice(end, closeStart);
      tag.textStart = end;
      const e = cm ? src.indexOf('>', closeStart) : -1;
      i = e < 0 ? n : e + 1;
    }
    tags.push(tag);
  }
  return { tags, headCloseStart };
}

/* =============================================================================================
 * 注释剥离:返回与原文等长的字符串(注释内容换成空格、保留换行),偏移量与原文一一对应
 * ============================================================================================= */
function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

function stripCssComments(s) {
  if (s.indexOf('/*') < 0) return s;
  const parts = [];
  let seg = 0;
  let i = 0;
  while (true) {
    const a = s.indexOf('/*', i);
    if (a < 0) break;
    let b = s.indexOf('*/', a + 2);
    b = b < 0 ? s.length : b + 2;
    parts.push(s.slice(seg, a), blank(s.slice(a, b)));
    seg = b;
    i = b;
  }
  parts.push(s.slice(seg));
  return parts.join('');
}

const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'new', 'else', 'do', 'instanceof', 'yield', 'await']);
const REGEX_PRECEDING_CHARS = '(,=:[!&|?{};+-*%<>~^';

function slashStartsRegex(s, i) {
  let j = i - 1;
  while (j >= 0 && (s.charCodeAt(j) <= 32)) j--;
  if (j < 0) return true;
  const ch = s[j];
  if (REGEX_PRECEDING_CHARS.includes(ch) || ch === '}') return true;
  if (/[A-Za-z_$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[\w$]/.test(s[k])) k--;
    return REGEX_PRECEDING_WORDS.has(s.slice(k + 1, j + 1));
  }
  return false; // ) ] 数字等:除号
}

function stripJsComments(s) {
  if (s.indexOf('/') < 0) return s;
  const n = s.length;
  const parts = [];
  let seg = 0;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 39 || c === 34 || c === 96) { // ' " `
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === c) { j++; break; }
        if (d === 10 && c !== 96) break; // 未闭合的普通字符串:到行尾止损
        j++;
      }
      i = j;
      continue;
    }
    if (c === 47) { // /
      const d = s.charCodeAt(i + 1);
      if (d === 47) { // 行注释
        let e = s.indexOf('\n', i);
        if (e < 0) e = n;
        parts.push(s.slice(seg, i), blank(s.slice(i, e)));
        seg = e;
        i = e;
        continue;
      }
      if (d === 42) { // 块注释
        let e = s.indexOf('*/', i + 2);
        e = e < 0 ? n : e + 2;
        parts.push(s.slice(seg, i), blank(s.slice(i, e)));
        seg = e;
        i = e;
        continue;
      }
      if (slashStartsRegex(s, i)) { // 正则字面量:跳过,避免把里面的 // 或引号当成注释 / 字符串
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          const e = s.charCodeAt(j);
          if (e === 10) break;
          if (e === 92) { j += 2; continue; }
          if (e === 91) inClass = true;
          else if (e === 93) inClass = false;
          else if (e === 47 && !inClass) { ok = true; j++; break; }
          j++;
        }
        if (ok) { i = j; continue; }
      }
    }
    i++;
  }
  if (seg === 0) return s;
  parts.push(s.slice(seg));
  return parts.join('');
}

/* =============================================================================================
 * 小工具
 * ============================================================================================= */
function isJsType(type) {
  if (type == null) return true;
  const t = type.trim().toLowerCase();
  return t === '' || t === 'module' || /^(text|application)\/(x-)?(javascript|ecmascript)$/.test(t);
}

function stripRef(ref) {
  return String(ref || '').trim().replace(/[?#].*$/, '').replace(/^(\.\/)+/, '');
}

// 'exact' = 与期望文件名完全一致(相对根目录);'path' = 文件名相同但带了目录前缀;null = 无关
function refMatch(ref, name) {
  const r = stripRef(ref);
  if (r === name) return 'exact';
  if (r.split('/').pop() === name) return 'path';
  return null;
}

function snippet(s, max = 60) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function relTokens(attrs) {
  return String(attrs.rel || '').toLowerCase().split(/\s+/).filter(Boolean);
}

const INIT_CALL_RE = /\binitAntiFOUC\s*\(\s*(['"`])([^'"`\\\n]*)\1\s*\)/g;
const INIT_ANY_RE = /\binitAntiFOUC\s*\(/g;
const MOUNT_ANY_RE = /\bmountThemeControl\s*\(/g;
const MOUNT_LIT_RE = /\bmountThemeControl\s*\(\s*(['"`])([^'"`\\\n]*)\1/y;
const STORAGE_CALL_RE = /\b(?:local|session)Storage\s*(?:\.\s*(?:getItem|setItem|removeItem)|\[\s*['"](?:getItem|setItem|removeItem)['"]\s*\])\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const STORAGE_PROP_RE = /\b(?:local|session)Storage\s*\.\s*([A-Za-z_$][\w$]*)/g;
const STORAGE_BRACKET_RE = /\b(?:local|session)Storage\s*\[\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1\s*\]/g;

function* matchAll(re, text) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) re.lastIndex++;
    yield m;
  }
}

/* =============================================================================================
 * 单页分析(不涉及跨页的部分)
 * ============================================================================================= */
function analyzePage(file, src, warnings) {
  const loc = makeLocator(src);
  const { tags, headCloseStart } = scanHtml(src);
  const res = {
    file,
    pageId: null,
    initIds: [],
    mountCalls: [],
    checks: {},
    warnings,
    scan: { tags }
  };
  for (const c of CHECKS) res.checks[c.key] = { status: 'pass', problems: [] };
  const fail = (key, message, pos) => {
    const c = res.checks[key];
    c.status = 'fail';
    const l = pos == null ? null : loc(pos);
    c.problems.push({ message, line: l ? l.line : null, col: l ? l.col : null, where: l ? fmtLoc(l) : null });
  };
  const warn = (message, pos) => {
    const l = pos == null ? null : loc(pos);
    warnings.push({ message, line: l ? l.line : null, where: l ? fmtLoc(l) : null });
  };

  const styles = tags.filter((t) => t.name === 'style');
  const jsScripts = [];
  for (const t of tags) {
    if (t.name !== 'script' || 'src' in t.attrs || !isJsType(t.attrs.type)) continue;
    jsScripts.push({ tag: t, code: stripJsComments(t.text), base: t.textStart });
  }

  /* ---------- head:四行接入 ---------- */
  const headOpen = tags.find((t) => t.name === 'head');
  const bodyOpen = tags.find((t) => t.name === 'body');
  const headEnd = headCloseStart >= 0 ? headCloseStart : bodyOpen ? bodyOpen.start : src.length;
  const inHead = (pos) => !!headOpen && pos > headOpen.start && pos < headEnd;
  if (!headOpen) fail('head', '缺少 <head> 标签,无法确认接入位置');

  const firstStyle = styles[0] || null;
  const found = []; // 已找到的接入项:{ label, pos }

  // 1) meta color-scheme
  {
    const label = '<meta name="color-scheme" content="light dark">';
    const metas = tags.filter((t) => t.name === 'meta' && String(t.attrs.name || '').trim().toLowerCase() === 'color-scheme');
    if (!metas.length) fail('head', `缺少 ${label}`);
    else {
      const m = metas.find((t) => inHead(t.start));
      if (!m) fail('head', `${label} 位于 <head> 之外`, metas[0].start);
      else {
        const toks = String(m.attrs.content || '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
        if (toks !== 'dark light') fail('head', `meta color-scheme 的 content 应为 "light dark"(实际 "${snippet(String(m.attrs.content || ''))}")`, m.start);
        found.push({ label: 'meta color-scheme', pos: m.start });
      }
    }
  }

  // 2) theme-manager.js
  {
    const label = '<script src="theme-manager.js">';
    const cands = tags.filter((t) => t.name === 'script' && 'src' in t.attrs && refMatch(t.attrs.src, 'theme-manager.js'));
    if (!cands.length) fail('head', `缺少 ${label}`);
    else {
      const m = cands.find((t) => inHead(t.start));
      if (!m) fail('head', `${label} 位于 <head> 之外`, cands[0].start);
      else {
        if (refMatch(m.attrs.src, 'theme-manager.js') !== 'exact') fail('head', `theme-manager.js 的 src 应为相对根目录的 "theme-manager.js"(实际 "${snippet(m.attrs.src)}")`, m.start);
        const bad = ['async', 'defer', 'nomodule'].filter((a) => a in m.attrs);
        if (String(m.attrs.type || '').toLowerCase() === 'module') bad.push('type=module');
        if (bad.length) fail('head', `theme-manager.js 必须同步加载,不能带 ${bad.join(' / ')}`, m.start);
        found.push({ label: 'theme-manager.js', pos: m.start });
      }
    }
  }

  // 3) initAntiFOUC 内联脚本
  {
    const label = "内联脚本 initAntiFOUC('<pageId>')";
    const cands = jsScripts.filter((s) => {
      INIT_CALL_RE.lastIndex = 0;
      return s.code.includes('initAntiFOUC') && INIT_CALL_RE.test(s.code);
    });
    if (!cands.length) {
      const any = jsScripts.find((s) => s.code.includes('initAntiFOUC'));
      if (any) fail('head', `${label} 的参数必须是字符串字面量`, any.tag.start);
      else fail('head', `缺少 ${label}`);
    } else {
      const m = cands.find((s) => inHead(s.tag.start));
      if (!m) fail('head', `${label} 位于 <head> 之外`, cands[0].tag.start);
      else {
        if (String(m.tag.attrs.type || '').toLowerCase() === 'module') fail('head', 'initAntiFOUC 脚本不能是 type=module(模块脚本会被延迟执行,起不到防闪烁作用)', m.tag.start);
        if (!/LifeToolsTheme\s*&&|typeof\s+(?:window\.)?LifeToolsTheme|\btry\s*\{/.test(m.code)) {
          warn('initAntiFOUC 调用没有 window.LifeToolsTheme && 守卫:theme-manager.js 缺失时会抛 ReferenceError', m.tag.start);
        }
        found.push({ label: 'initAntiFOUC', pos: m.tag.start });
      }
    }
  }

  // 4) theme-tokens.css
  {
    const label = '<link rel="stylesheet" href="theme-tokens.css">';
    const cands = tags.filter((t) => t.name === 'link' && refMatch(t.attrs.href, 'theme-tokens.css'));
    if (!cands.length) fail('head', `缺少 ${label}`);
    else {
      const m = cands.find((t) => inHead(t.start));
      if (!m) fail('head', `${label} 位于 <head> 之外`, cands[0].start);
      else {
        if (refMatch(m.attrs.href, 'theme-tokens.css') !== 'exact') fail('head', `theme-tokens.css 的 href 应为相对根目录的 "theme-tokens.css"(实际 "${snippet(m.attrs.href)}")`, m.start);
        const rel = relTokens(m.attrs);
        if (!rel.includes('stylesheet') || rel.some((r) => ['preload', 'prefetch', 'alternate'].includes(r))) {
          fail('head', `theme-tokens.css 必须是 rel="stylesheet"(实际 rel="${snippet(String(m.attrs.rel || ''))}")`, m.start);
        }
        const bad = ['async', 'defer', 'media', 'onload', 'disabled'].filter((a) => a in m.attrs);
        if (bad.length) fail('head', `theme-tokens.css 必须同步加载,不能带 ${bad.join(' / ')}(防闪烁)`, m.start);
        found.push({ label: 'theme-tokens.css', pos: m.start });
      }
    }
  }

  // 顺序:meta -> manager -> init -> tokens(只比较已找到的相邻项)
  for (let k = 0; k + 1 < found.length; k++) {
    if (found[k].pos > found[k + 1].pos) {
      fail('head', `顺序错误:${found[k].label}(${fmtLoc(loc(found[k].pos))})必须在 ${found[k + 1].label}(${fmtLoc(loc(found[k + 1].pos))})之前`, found[k].pos);
    }
  }
  // 都早于第一个 <style>
  if (firstStyle) {
    for (const f of found) {
      if (f.pos > firstStyle.start) fail('head', `${f.label}(${fmtLoc(loc(f.pos))})晚于第一个 <style>(${fmtLoc(loc(firstStyle.start))}),必须放在任何 <style> 之前`, f.pos);
    }
  }

  /* ---------- map:LT-THEME-MAP ---------- */
  {
    let hit = null;
    for (const st of styles) {
      let idx = st.text.indexOf('LT-THEME-MAP');
      while (idx >= 0) {
        const lo = st.text.lastIndexOf('/*', idx);
        const lc = st.text.lastIndexOf('*/', idx);
        if (lo >= 0 && lo > lc) { hit = { style: st, idx }; break; }
        idx = st.text.indexOf('LT-THEME-MAP', idx + 1);
      }
      if (hit) break;
    }
    if (!hit) {
      const anywhere = src.indexOf('LT-THEME-MAP');
      if (anywhere >= 0) fail('map', 'LT-THEME-MAP 出现在 <style> 的 CSS 注释之外;必须写成 <style> 内的 /* LT-THEME-MAP */', anywhere);
      else fail('map', '缺少 LT-THEME-MAP 映射块(<style> 内的 /* LT-THEME-MAP */ 注释 + html[data-style]:not([data-style="classic"]){...})');
    } else if (!/data-style/.test(hit.style.text)) {
      warn('LT-THEME-MAP 所在 <style> 内没有 [data-style] 选择器,映射块可能没有真正写出来', hit.style.textStart + hit.idx);
    }
    // 回退值提示
    const noFallback = [];
    for (const st of styles) {
      const css = stripCssComments(st.text);
      if (css.indexOf('--lt-') < 0) continue;
      for (const m of matchAll(/var\(\s*--lt-[\w-]+\s*\)/g, css)) noFallback.push({ pos: st.textStart + m.index, text: m[0] });
    }
    if (noFallback.length) {
      warn(`${noFallback.length} 处 var(--lt-*) 没有回退值(如 ${noFallback[0].text}):theme-tokens.css 缺失时页面会崩,应写成 var(--lt-x, <原值>)`, noFallback[0].pos);
    }
  }

  /* ---------- media:prefers-color-scheme ---------- */
  {
    const hits = [];
    for (const t of tags) {
      const media = t.attrs && t.attrs.media;
      if (media && /prefers-color-scheme/i.test(media)) hits.push({ pos: t.start, text: `<${t.name} media="${snippet(media, 50)}">` });
    }
    for (const st of styles) {
      const css = stripCssComments(st.text);
      if (css.indexOf('prefers-color-scheme') < 0) continue;
      for (const m of matchAll(/prefers-color-scheme/g, css)) {
        hits.push({ pos: st.textStart + m.index, text: 'CSS: ' + snippet(css.slice(Math.max(0, m.index - 30), m.index + 40)) });
      }
    }
    for (const sc of jsScripts) {
      if (sc.code.indexOf('prefers-color-scheme') < 0) continue;
      for (const m of matchAll(/prefers-color-scheme/g, sc.code)) {
        hits.push({ pos: sc.base + m.index, text: 'JS: ' + snippet(sc.code.slice(Math.max(0, m.index - 30), m.index + 40)) });
      }
    }
    hits.sort((a, b) => a.pos - b.pos);
    const SHOW = 5;
    for (const h of hits.slice(0, SHOW)) fail('media', `不得使用 prefers-color-scheme(跟随系统由 theme-manager 的 auto / system 承担):${h.text}`, h.pos);
    if (hits.length > SHOW) fail('media', `……另有 ${hits.length - SHOW} 处 prefers-color-scheme`, hits[SHOW].pos);
  }

  /* ---------- storage:自建主题存储键 ---------- */
  {
    const hits = [];
    const consider = (key, pos, how) => {
      if (key.startsWith(OWN_KEY_PREFIX)) return;
      if (THEME_KEY_RE.test(key)) hits.push({ key, pos, how });
    };
    for (const sc of jsScripts) {
      const code = sc.code;
      if (code.indexOf('Storage') < 0) continue;
      for (const m of matchAll(STORAGE_CALL_RE, code)) consider(m[2], sc.base + m.index, '「' + snippet(m[0], 70) + '」');
      for (const m of matchAll(STORAGE_BRACKET_RE, code)) {
        if (!STORAGE_METHODS.has(m[2])) consider(m[2], sc.base + m.index, '「' + snippet(m[0], 70) + '」');
      }
      for (const m of matchAll(STORAGE_PROP_RE, code)) {
        if (!STORAGE_METHODS.has(m[1])) consider(m[1], sc.base + m.index, '「' + snippet(m[0], 70) + '」');
      }
    }
    hits.sort((a, b) => a.pos - b.pos);
    for (const h of hits) {
      fail('storage', `自建主题存储键 "${h.key}":${h.how};全站只允许 lifetools_* 键,请改用 LifeToolsTheme API(setPageTheme / setPageStyle)`, h.pos);
    }
  }

  /* ---------- pageId(本页部分)---------- */
  {
    for (const sc of jsScripts) {
      if (sc.code.indexOf('initAntiFOUC') < 0) continue;
      for (const m of matchAll(INIT_CALL_RE, sc.code)) res.initIds.push({ id: m[2], pos: sc.base + m.index });
    }
    let anyInit = null;
    for (const sc of jsScripts) {
      if (sc.code.indexOf('initAntiFOUC') < 0) continue;
      const m = matchAll(INIT_ANY_RE, sc.code).next();
      if (!m.done) { anyInit = sc.base + m.value.index; break; }
    }
    if (!res.initIds.length) {
      if (anyInit != null) fail('pageId', "initAntiFOUC 的参数必须是字符串字面量,才能静态确认 pageId", anyInit);
      else fail('pageId', "未找到 initAntiFOUC('<pageId>') 调用,无法确定 pageId");
    } else {
      res.pageId = res.initIds[0].id;
      const distinct = [...new Set(res.initIds.map((x) => x.id))];
      if (distinct.length > 1) fail('pageId', `同一页面调用了多个不同的 initAntiFOUC pageId:${distinct.join(' / ')}`, res.initIds[1].pos);
      if (!ID_RE.test(res.pageId)) fail('pageId', `pageId "${res.pageId}" 不符合命名规则(小写字母 / 数字 / 连字符的文件名短 slug,如 badminton)`, res.initIds[0].pos);
    }

    for (const sc of jsScripts) {
      if (sc.code.indexOf('mountThemeControl') < 0) continue;
      for (const m of matchAll(MOUNT_ANY_RE, sc.code)) {
        MOUNT_LIT_RE.lastIndex = m.index;
        const lit = MOUNT_LIT_RE.exec(sc.code);
        res.mountCalls.push({ id: lit ? lit[2] : null, pos: sc.base + m.index });
      }
    }
    const isHome = file === HOME_FILE;
    if (isHome) {
      if (res.pageId != null && res.pageId !== HOME_ID) fail('pageId', `index.html 的 pageId 必须是 "${HOME_ID}"(实际 "${res.pageId}")`, res.initIds[0].pos);
      for (const c of res.mountCalls) fail('pageId', '首页(home)不得调用 mountThemeControl:首页顶栏自带切换器', c.pos);
    } else {
      if (res.pageId === HOME_ID) fail('pageId', `pageId "${HOME_ID}" 只属于 index.html,请换成本页的文件名短 slug`, res.initIds[0].pos);
      if (!res.mountCalls.length) fail('pageId', `缺少 mountThemeControl('${res.pageId || '<pageId>'}') 调用:非首页必须挂载主题挂件`);
      for (const c of res.mountCalls) {
        if (c.id == null) fail('pageId', 'mountThemeControl 的第一个参数必须是字符串字面量,才能静态核对 pageId', c.pos);
        else if (res.pageId != null && c.id !== res.pageId) fail('pageId', `mountThemeControl('${c.id}') 与 initAntiFOUC('${res.pageId}') 的 pageId 不一致`, c.pos);
      }
    }
  }

  /* ---------- favicon ---------- */
  {
    const icons = tags.filter((t) => t.name === 'link' && relTokens(t.attrs).includes('icon'));
    const svgOk = (href) => {
      const h = String(href || '').trim();
      if (!/^data:image\/svg\+xml/i.test(h)) return false;
      const comma = h.indexOf(',');
      if (comma < 0) return false;
      const meta = h.slice(0, comma).toLowerCase();
      const body = h.slice(comma + 1);
      let text = body;
      try {
        text = meta.includes(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
      } catch (e) { /* 解码失败:按原文判断 */ }
      return /<svg[\s>]/i.test(text);
    };
    if (!icons.length) fail('favicon', '缺少内联 SVG favicon:<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,…">');
    else if (!icons.some((t) => svgOk(t.attrs.href))) {
      const h = String(icons[0].attrs.href || '');
      fail('favicon', `favicon 必须是内联 data:image/svg+xml(含 <svg>),不能是外链或位图(实际 href="${snippet(h, 50)}")`, icons[0].start);
    }
  }

  return res;
}

/* =============================================================================================
 * 跨页检查:pageId 唯一、首页卡片
 * ============================================================================================= */
function crossChecks(pages) {
  // pageId 唯一
  const byId = new Map();
  for (const p of pages) {
    if (p.pageId == null) continue;
    if (!byId.has(p.pageId)) byId.set(p.pageId, []);
    byId.get(p.pageId).push(p);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const p of list) {
      const others = list.filter((x) => x !== p).map((x) => x.file).join('、');
      const c = p.checks.pageId;
      c.status = 'fail';
      c.problems.push({ message: `pageId "${id}" 与 ${others} 重复:pageId 必须全站唯一(存储键 lifetools_page_theme_<pageId> 会互相覆盖)`, line: null, col: null, where: null });
    }
  }

  // 首页卡片
  const home = pages.find((p) => p.file === HOME_FILE);
  const anchors = home ? home.scan.tags.filter((t) => t.name === 'a') : [];
  for (const p of pages) {
    const c = p.checks.card;
    if (p.file === HOME_FILE) { c.status = 'na'; continue; }
    if (!home) {
      c.status = 'fail';
      c.problems.push({ message: `根目录下没有 ${HOME_FILE},无法校验首页卡片`, line: null, col: null, where: null });
      continue;
    }
    const cands = anchors.filter((a) => stripRef(a.attrs.href) === p.file);
    const problemsOf = (a) => {
      const out = [];
      const cat = a.attrs['data-cat'];
      if (cat === undefined) out.push('缺少 data-cat');
      else {
        const toks = cat.trim().split(/\s+/).filter(Boolean);
        if (!toks.length) out.push('data-cat 为空');
        const unknown = toks.filter((t) => !CATS.includes(t));
        if (unknown.length) out.push(`data-cat 含未知取值 "${unknown.join(' ')}"(既有取值 ${CATS.join(' / ')},可空格组合)`);
      }
      const nm = a.attrs['data-name'];
      if (nm === undefined) out.push('缺少 data-name');
      else if (!nm.trim()) out.push('data-name 为空');
      return out;
    };
    if (!cands.length) {
      c.status = 'fail';
      c.problems.push({ message: `${HOME_FILE} 中没有指向 ${p.file} 的卡片(需要 <a class="tool-card" href="${p.file}" data-name="…" data-cat="…">)`, line: null, col: null, where: null });
    } else if (!cands.some((a) => problemsOf(a).length === 0)) {
      c.status = 'fail';
      const loc = makeLocator(home.src);
      const l = loc(cands[0].start);
      for (const msg of problemsOf(cands[0])) {
        c.problems.push({ message: `${HOME_FILE} 里 ${p.file} 的卡片:${msg}`, line: l.line, col: l.col, where: `${HOME_FILE} ${fmtLoc(l)}` });
      }
    }
  }
}

/* =============================================================================================
 * 输出
 * ============================================================================================= */
function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s, width, align = 'left') {
  const gap = Math.max(0, width - strWidth(s));
  if (align === 'center') {
    const l = Math.floor(gap / 2);
    return ' '.repeat(l) + s + ' '.repeat(gap - l);
  }
  return s + ' '.repeat(gap);
}

function renderTable(pages) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (s, code) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const cell = (st) => (st === 'pass' ? '✓' : st === 'fail' ? '✗' : '-');
  const headers = ['页面', 'pageId', ...CHECKS.map((c) => c.label)];
  const rows = pages.map((p) => [p.file, p.pageId == null ? '(无)' : p.pageId, ...CHECKS.map((c) => cell(p.checks[c.key].status))]);
  const widths = headers.map((h, i) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[i]))));
  const line = (cells, color) => '| ' + cells.map((c, i) => {
    const text = pad(c, widths[i], i >= 2 ? 'center' : 'left');
    if (!color || i < 2) return text;
    return c === '✓' ? paint(text, 32) : c === '✗' ? paint(text, 31) : text;
  }).join(' | ') + ' |';
  const sep = '|-' + widths.map((w) => '-'.repeat(w)).join('-|-') + '-|';
  const out = [line(headers, false), sep];
  for (const r of rows) out.push(line(r, true));
  return out.join('\n');
}

function renderDetails(pages) {
  const out = [];
  for (const p of pages) {
    const failed = CHECKS.filter((c) => p.checks[c.key].status === 'fail');
    if (!failed.length) continue;
    out.push(`${p.file}(pageId: ${p.pageId == null ? '无' : p.pageId})`);
    for (const c of failed) {
      for (const pr of p.checks[c.key].problems) {
        out.push(`  ✗ [${c.label}] ${pr.message}${pr.where ? `  @ ${pr.where}` : ''}`);
      }
    }
  }
  return out;
}

function renderWarnings(pages) {
  const out = [];
  for (const p of pages) {
    for (const w of p.warnings) out.push(`  ! ${p.file}: ${w.message}${w.where ? `  @ ${w.where}` : ''}`);
  }
  return out;
}

/* =============================================================================================
 * 主流程
 * ============================================================================================= */
function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n${usage()}\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(usage() + '\n'); return 0; }

  const root = path.resolve(opts.root || path.join(__dirname, '..'));
  let entries;
  try {
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    process.stderr.write(`root 不存在或不是目录: ${root}\n`);
    return 2;
  }
  const files = entries.filter((d) => d.isFile() && /\.html?$/i.test(d.name)).map((d) => d.name).sort((a, b) => (a === HOME_FILE ? -1 : b === HOME_FILE ? 1 : a.localeCompare(b)));
  if (!files.length) {
    process.stderr.write(`root 下没有 *.html 页面: ${root}\n`);
    return 2;
  }

  const pages = [];
  for (const f of files) {
    const buf = fs.readFileSync(path.join(root, f));
    const warnings = [];
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) warnings.push({ message: '文件含 UTF-8 BOM,应为 UTF-8 无 BOM', line: null, where: null });
    let src;
    try {
      src = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch (e) {
      warnings.push({ message: '文件不是合法 UTF-8,已按容错方式解码', line: null, where: null });
      src = buf.toString('utf8');
    }
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    const page = analyzePage(f, src, warnings);
    page.src = src;
    pages.push(page);
  }
  crossChecks(pages);

  let shown = pages;
  if (opts.page) {
    shown = pages.filter((p) => opts.page.some((q) => q === p.file || q === p.file.replace(/\.html?$/i, '') || q === p.pageId));
    if (!shown.length) {
      process.stderr.write(`--page 没有匹配到任何页面: ${opts.page.join(',')}\n`);
      return 2;
    }
  }
  for (const p of pages) p.ok = CHECKS.every((c) => p.checks[c.key].status !== 'fail');
  const passed = shown.filter((p) => p.ok).length;
  const failed = shown.length - passed;

  if (opts.json) {
    const json = {
      root: root.replace(/\\/g, '/'),
      ok: failed === 0,
      summary: { total: shown.length, passed, failed },
      pages: shown.map((p) => ({
        file: p.file,
        pageId: p.pageId,
        ok: p.ok,
        checks: Object.fromEntries(CHECKS.map((c) => [c.key, { status: p.checks[c.key].status, problems: p.checks[c.key].problems }])),
        warnings: p.warnings
      }))
    };
    process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    return failed ? 1 : 0;
  }

  const lines = [];
  lines.push(`check-theme  root=${root.replace(/\\/g, '/')}`);
  lines.push('');
  lines.push(renderTable(shown));
  const details = renderDetails(shown);
  if (details.length) { lines.push('', '未通过项:', ...details); }
  const warns = renderWarnings(shown);
  if (warns.length) { lines.push('', '提示(不影响退出码):', ...warns); }
  lines.push('', `共 ${shown.length} 页:通过 ${passed},未通过 ${failed}${failed ? '' : '  —— 全部通过'}`);
  process.stdout.write(lines.join('\n') + '\n');
  return failed ? 1 : 0;
}

process.exitCode = main();
