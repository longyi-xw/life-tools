#!/usr/bin/env node
/*
 * audit-contrast.mjs -- LifeTools 全站对比度审计(开发期工具,不进入页面运行时)
 *
 * Node >= 22 + 无头 Chrome(CDP,Node 原生 WebSocket) + 内置静态 HTTP 服务;零 npm 依赖、零构建。
 * 对「页面 x 风格(classic/tech/fresh/paper) x 明暗(light/dark)」逐组合加载页面,遍历可见文本,
 * 计算前景色与叠加后的有效背景色的 WCAG 对比度,并检查控件边界 / 焦点环 / 内联 SVG 图形。
 *
 * ---------------------------------------------------------------------------------------------
 * 用法
 *   node scripts/audit-contrast.mjs [选项]
 *   --root <dir>        被审计的站点根目录(默认:本脚本所在仓库根)。页面 = root 下 *.html(排除 tests/、docs/),
 *                       pageId 取自 initAntiFOUC("<id>");没有该调用时退回文件名(不含扩展名)
 *   --page a,b          只审这些页面(pageId 或文件名);--style tech,paper / --theme dark 同理(逗号分隔多值)
 *   --width 1280 --height 800   视口(默认 1280x800;响应式验证用 --width 390)
 *   --json              机读 JSON 输出到 stdout(进度信息始终走 stderr)
 *   --shots <dir>       为每个组合保存整页 PNG(未做文字透明化的真实渲染),供肉眼复核
 *   --strict            "需人工复核"项也算失败(exit 1)
 *   --console           同时统计控制台 error/warning 与未捕获异常(不计入对比度违规)
 *   --concurrency 2     并发任务数(同一 Chrome 内每个任务一个独立 BrowserContext,存储互不串扰)
 *   --timeout 30000     单页加载超时(毫秒)
 *   --focus 8           焦点环检查:按 Tab 依次聚焦前 N 个可聚焦元素(0 = 关闭;仅默认状态执行)
 *   --settle 500        DOM 静默期(毫秒);Nuxt 等水合型页面会额外等待水合完成
 *   --thin 6            像素采样的"重复版型抽样":同一版型(前景色+触发原因+背景源+字号)超过 N 个实例时按分位数只取 N 个
 *                       (24 万像素高的长文档页不必扫完每一屏);0 = 全量(慢)。解析路径(纯色背景)不受影响,始终全量
 *   --states-dir <dir>  额外审计状态的 JSON 目录(默认 scripts/audit-states/);--no-states 关闭状态扩展;
 *                       --state a,b 只跑指定状态名
 *   --offline           屏蔽 127.0.0.1 以外的所有主机(字体/CDN 不加载;默认放行,因为 geopolitical 依赖 CDN 的 D3)
 *   --no-verify-attrs   仅供自测:不校验 <html data-theme/data-style> 与预期一致(风格维度落地前的旧版
 *                       theme-manager 没有 data-style,校验会必然失败)。风格维度落地后应始终默认开启校验
 *   --no-warmup         关闭"滚动入场"预热(内联脚本含 IntersectionObserver / scroll 监听的页面,采集前会先慢速滚一遍再回顶部)
 *   --pixel-all         调试:强制所有文本走像素采样(用于与解析路径互相印证)
 *   --include-pass      JSON 中附带通过项的逐条测量(夹具自测用)
 *   --chrome <path>     Chrome 可执行文件(也可用环境变量 CHROME_PATH)
 *
 * 退出码:0 全部通过;1 有违规(--strict 时含人工复核项);2 页面加载失败 / data 属性不符 / 状态步骤失败 / Chrome 启动失败。
 *
 * ---------------------------------------------------------------------------------------------
 * 额外审计状态:scripts/audit-states/<pageId>.json(可选)
 *   { "states": [ { "name": "标签页-持仓", "steps": [
 *       { "click": "css选择器" },                          // 元素 .click()(不移动鼠标,避免悬停态污染)
 *       { "eval": "js 表达式或语句,可返回 Promise" },        // 在页面里执行
 *       { "wait": 300 },                                   // 毫秒
 *       { "scrollTo": "css选择器" },                       // 把元素滚到视口中央
 *       { "type": { "selector": "css", "text": "510300" } } // 聚焦并真实输入文本(触发 input 事件)
 *   ] } ] }
 *   每个状态都会"重新创建隔离上下文 -> 重载页面 -> 回放 steps -> 重新审计",保证状态彼此独立;
 *   默认状态审计之后依次执行。选择器找不到 / 步骤抛错 = 该状态失败(exit 2)。示例见 scripts/audit-states/_example.json。
 *
 * ---------------------------------------------------------------------------------------------
 * 判定标准(对应规格 §4)
 *   文本    小字 >= 4.5:1;大字(>=24px,或 >=18.66px 且 font-weight>=700)>= 3:1;muted/placeholder/标签/图表轴文字同小字;
 *           无字母数字的纯符号文字(图标字形)按非文本 3:1;disabled / aria-disabled 豁免但在 info 里列出;
 *           纯 emoji 不审(位图字形不受 color 控制),混排时 emoji 段不参与取样。
 *   控件    input/select/textarea/button 边界(边框、底色、描边环,取最强者)相对相邻背景 >= 3:1;无任何可见边界的文本输入框判违规;
 *           无边框无底色的纯文字按钮不算控件边界问题(文字对比度另查)。
 *   焦点环  Tab 聚焦前后各截一次图,取受影响区域内"聚焦态相对非聚焦态"最强的像素对比度 >= 3:1;完全无变化判违规。
 *   SVG     可判定的内联 SVG 图标 / 图表关键线条与填充,对所在背景 >= 3:1(描边与填充任一达标即可);
 *           细线(stroke<1.5px 且无填充,如网格线 / 坐标轴)只记 advisory。
 *   advisory(不判失败,汇总打印计数):卡片/面板的装饰性边界 < 3:1、SVG 细线 < 3:1。这是对 WCAG 1.4.11 的务实解读:
 *           卡片边界通常只是装饰,内容本身(文字/控件)才是需要被感知的对象;控件边界与图标仍严格按 3:1 判定。
 *
 * 有效背景
 *   默认沿祖先链做 background-color + 祖先 opacity 的"组合成"解析(精确,含半透明层叠);遇到 background-image、
 *   backdrop-filter、mix-blend-mode、filter、局部覆盖、同位置的定位叠层(含 ::before/::after)、canvas/video/iframe/img/svg 等情形,
 *   改走像素采样:先把所有文字透明化(-webkit-text-fill-color 等,不动 color,以免 currentColor 的边框/描边消失)后截视口图,
 *   在文本行矩形内多点取样,取"对比度最差点"作有效背景。长页面分段滚动,内部滚动容器逐个滚到位再采样(全屏 100dvh +
 *   overflow:hidden 的应用页同理,内容在内部滚动容器里)。
 *   需人工复核(单独列出,附选择器与坐标):渐变文字(background-clip:text,给出各渐变色标的估算值)、
 *   描边型 text-shadow 且基础对比度不达标、文字下方有 canvas/video/iframe 或跨域背景图、被其它元素遮挡无法稳定取样、
 *   透明文字仅靠 text-shadow 显示。
 *
 * 已知边界(不审 / 只能人工看图)
 *   canvas 内绘制的文字(如 ECharts)、cross-origin iframe、shadow DOM 内部、<video>;这些区域会在汇总里以"canvas/video/iframe 区域"列出并附坐标。
 *   文字被其它元素永久遮挡(如固定底栏盖住页尾文字)=> 标 obscured 转人工复核,不判违规。
 *   像素采样是网格取样(每行文字约 6~30 个点),极细的背景纹理可能漏采;"最差点"是采样意义上的最差。
 *   调试用环境变量:LT_DEBUG=1 打印每遍滚动/截图的摘要与采集细节;LT_DEBUG_DIR=<dir> 保存焦点环前后原始像素。
 *
 * 与规格字面的两处有意差异(目标一致:取稳定采样且不改变颜色)
 *   1) 不用 `*{animation:none!important}`:这会让"opacity:0 起始 + animation-fill 到 1"的入场动画元素停在 opacity:0 而被漏审。
 *      改为:transition 全部关闭;稳定期后对 document.getAnimations() 有限动画 finish()(落在终态)、无限动画 cancel()。
 *   2) 文字透明化只用 -webkit-text-fill-color / -webkit-text-stroke-color / text-shadow / text-decoration-color,不动 `color`,
 *      避免 border/outline/box-shadow/SVG 的 currentColor 随之变透明而污染控件边界与背景采样。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES = ['classic', 'tech', 'fresh', 'paper'];
const THEMES = ['light', 'dark'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =============================================================================================
 * 颜色数学(Node 与页面共用同一份源码:页面侧通过 Function.toString() 注入)
 * ============================================================================================= */
function lt_lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lt_lum(rgb) { return 0.2126 * lt_lin(rgb[0]) + 0.7152 * lt_lin(rgb[1]) + 0.0722 * lt_lin(rgb[2]); }
function lt_contrast(a, b) {
  const la = lt_lum(a), lb = lt_lum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
function lt_premult(c) { return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]; }
function lt_over(top, bottom) { // 预乘 RGBA 的 source-over
  const k = 1 - top[3];
  return [top[0] + bottom[0] * k, top[1] + bottom[1] * k, top[2] + bottom[2] * k, top[3] + bottom[3] * k];
}
function lt_round(rgb) { return [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])]; }
const MATH_SRC = [lt_lin, lt_lum, lt_contrast, lt_premult, lt_over, lt_round].map((f) => f.toString()).join('\n');
const hex = (rgb) => '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/* =============================================================================================
 * 页面侧代码(序列化后注入页面;不得引用 Node 作用域里的任何变量,只能用 lt_* 数学函数)
 * ============================================================================================= */
function pageSide(cfg) {
  'use strict';
  const doc = document, html = doc.documentElement;
  const LT = {};
  const S = { entries: [], pending: [], overlays: [], regions: [], stats: {}, selCache: new WeakMap(), ids: new WeakMap(), idSeq: 0 };
  const stat = (k, n) => { S.stats[k] = (S.stats[k] || 0) + (n === undefined ? 1 : n); };

  /* ---------- 基础:样式缓存、颜色解析 ---------- */
  const csCache = new WeakMap();
  function cs(el) { let v = csCache.get(el); if (!v) { v = getComputedStyle(el); csCache.set(el, v); } return v; }
  const parentEl = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  const colorCache = new Map();
  let cctx = null;
  function viaCanvas(str) {
    try {
      if (!cctx) { const c = doc.createElement('canvas'); c.width = c.height = 1; cctx = c.getContext('2d', { willReadFrequently: true }); }
      const get = (bg) => {
        cctx.globalCompositeOperation = 'source-over';
        cctx.fillStyle = bg; cctx.fillRect(0, 0, 1, 1);
        cctx.fillStyle = bg === '#000' ? '#000' : '#fff';
        cctx.fillStyle = str; cctx.fillRect(0, 0, 1, 1);
        return cctx.getImageData(0, 0, 1, 1).data;
      };
      const d1 = get('#000'), d2 = get('#fff');
      const a = Math.max(0, Math.min(1, 1 - (d2[1] - d1[1]) / 255));
      if (a < 0.002) return [0, 0, 0, 0];
      return [d1[0] / a, d1[1] / a, d1[2] / a, a].map((v, i) => (i < 3 ? Math.min(255, v) : v));
    } catch (e) { return [0, 0, 0, 1]; }
  }
  function parseColor(str) {
    if (!str || str === 'transparent' || str === 'none') return [0, 0, 0, 0];
    let v = colorCache.get(str);
    if (v) return v;
    let m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(str);
    if (m) v = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
    else if ((m = /^color\(\s*srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(str))) {
      v = [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
    } else v = viaCanvas(str);
    colorCache.set(str, v);
    return v;
  }

  const infoCache = new WeakMap();
  function info(el) {
    let v = infoCache.get(el);
    if (v) return v;
    const c = cs(el);
    const op = parseFloat(c.opacity);
    v = {
      bg: parseColor(c.backgroundColor),
      img: c.backgroundImage || 'none',
      backdrop: !!((c.backdropFilter && c.backdropFilter !== 'none') || (c.webkitBackdropFilter && c.webkitBackdropFilter !== 'none')),
      blend: c.mixBlendMode !== 'normal',
      filter: c.filter !== 'none',
      op: isNaN(op) ? 1 : op,
      pos: c.position,
      display: c.display
    };
    infoCache.set(el, v);
    return v;
  }
  const opCache = new WeakMap();
  function opChain(el) {
    if (!el) return 1;
    let v = opCache.get(el);
    if (v !== undefined) return v;
    v = info(el).op * opChain(parentEl(el));
    opCache.set(el, v);
    return v;
  }
  function crossOrigin(imgStr) {
    const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    let m;
    while ((m = re.exec(imgStr))) {
      const u = m[2];
      if (/^(data|blob):/i.test(u)) continue;
      try { if (new URL(u, location.href).origin !== location.origin) return true; } catch (e) { /* ignore */ }
    }
    return false;
  }

  /* ---------- 选择器(仅对违规项按需生成) ---------- */
  function simpleSel(el) {
    const tag = el.localName;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return { s: '#' + el.id, abs: true };
    const cls = Array.from(el.classList || []).filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 2);
    return { s: tag + cls.map((c) => '.' + c).join(''), abs: false };
  }
  function selectorFor(el) {
    let cached = S.selCache.get(el);
    if (cached) return cached;
    const parts = [];
    let cur = el, out = null;
    for (let depth = 0; cur && depth < 6; depth++) {
      const sm = simpleSel(cur);
      let seg = sm.s;
      const par = parentEl(cur);
      if (!sm.abs && par) {
        const sib = Array.from(par.children).filter((c) => c.localName === cur.localName && simpleSel(c).s === sm.s);
        if (sib.length > 1) seg += ':nth-child(' + (Array.from(par.children).indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      if (sm.abs) break;
      const sel = parts.join(' > ');
      try { if (doc.querySelectorAll(sel).length === 1) { out = sel; break; } } catch (e) { /* ignore */ }
      cur = par;
    }
    if (!out) out = parts.join(' > ');
    S.selCache.set(el, out);
    return out;
  }
  function idOf(el) {
    let id = S.ids.get(el);
    if (id === undefined) { id = ++S.idSeq; S.ids.set(el, id); }
    return id;
  }

  /* ---------- 裁剪链与可见性 ---------- */
  const rootSrc = (cs(html).overflowX !== 'visible' || cs(html).overflowY !== 'visible') ? html : doc.body;
  const rootCanY = !rootSrc || ['visible', 'auto', 'scroll'].indexOf(cs(rootSrc).overflowY) >= 0;
  const rootCanX = !rootSrc || ['visible', 'auto', 'scroll'].indexOf(cs(rootSrc).overflowX) >= 0;

  const clipCache = new WeakMap(), clipCacheSelf = new WeakMap();
  /* 返回会裁剪 el 的祖先链;self=true 时把 el 自身也算上(文本节点的父元素自己的 overflow 同样会裁剪文字) */
  function zeroClip(c) {
    if (c.clip && c.clip !== 'auto') { const m = /rect\(([^)]*)\)/.exec(c.clip); if (m) { const n = m[1].split(/[ ,]+/).map(parseFloat); if (n.length === 4 && (n[1] - n[3] <= 1 || n[2] - n[0] <= 1)) return true; } }
    if (c.clipPath && /inset\(\s*(50|100)%/.test(c.clipPath)) return true;
    return false;
  }
  function clipInfo(el, self) {
    const cache = self ? clipCacheSelf : clipCache;
    let v = cache.get(el);
    if (v) return v;
    const list = [];
    let fixed = cs(el).position === 'fixed';
    let mode = cs(el).position;
    let dead = false;
    const considerSelf = (p) => {
      const pc = cs(p);
      if (zeroClip(pc)) dead = true;
      const containPaint = /paint|strict|content/.test(pc.contain || '');
      if (pc.display !== 'inline' && pc.display !== 'contents' && (pc.overflowX !== 'visible' || pc.overflowY !== 'visible' || containPaint)) {
        list.push({ el: p, ovx: containPaint && pc.overflowX === 'visible' ? 'hidden' : pc.overflowX, ovy: containPaint && pc.overflowY === 'visible' ? 'hidden' : pc.overflowY });
      }
    };
    if (self) considerSelf(el);
    for (let p = parentEl(el); p; p = parentEl(p)) {
      if (p === html) break;
      const pc = cs(p);
      if (zeroClip(pc)) dead = true;
      if (pc.position === 'fixed') fixed = true;
      const establishes = pc.transform !== 'none' || (pc.perspective && pc.perspective !== 'none') || pc.filter !== 'none' ||
        /transform|perspective|filter/.test(pc.willChange || '') || /paint|layout|strict|content/.test(pc.contain || '');
      let isCB;
      if (mode === 'fixed') isCB = establishes;
      else if (mode === 'absolute') isCB = pc.position !== 'static' || establishes;
      else isCB = true;
      if (!isCB) continue;
      const containPaint = /paint|strict|content/.test(pc.contain || '');
      const propagated = p === doc.body && cs(html).overflowX === 'visible' && cs(html).overflowY === 'visible';
      if (!propagated && pc.display !== 'inline' && pc.display !== 'contents' &&
          (pc.overflowX !== 'visible' || pc.overflowY !== 'visible' || containPaint)) {
        list.push({ el: p, ovx: containPaint && pc.overflowX === 'visible' ? 'hidden' : pc.overflowX, ovy: containPaint && pc.overflowY === 'visible' ? 'hidden' : pc.overflowY });
      }
      mode = pc.position;
    }
    v = { list: list, fixed: fixed, dead: dead };
    cache.set(el, v);
    return v;
  }
  function clipRectOf(a) {
    const r = a.el.getBoundingClientRect();
    const l = r.left + a.el.clientLeft, t = r.top + a.el.clientTop;
    return { l: l, t: t, r: l + a.el.clientWidth, b: t + a.el.clientHeight };
  }
  function docSize() {
    return {
      w: Math.max(html.scrollWidth, doc.body ? doc.body.scrollWidth : 0),
      h: Math.max(html.scrollHeight, doc.body ? doc.body.scrollHeight : 0)
    };
  }
  /* lines: [{left,top,right,bottom}](视口坐标) -> {state:'visible'|'scroll'|'hidden', rects:[{l,t,r,b}], frac} */
  function visibility(lines, ci) {
    const vw = innerWidth, vh = innerHeight, sx = scrollX, sy = scrollY, ds = docSize();
    const out = [];
    if (ci.dead) return { state: 'hidden', rects: out, frac: 0 };
    let total = 0, vis = 0, reachable = false;
    const clips = ci.list.map((a) => ({ a: a, cr: clipRectOf(a), canX: (a.ovx === 'auto' || a.ovx === 'scroll') && a.el.scrollWidth > a.el.clientWidth + 1, canY: (a.ovy === 'auto' || a.ovy === 'scroll') && a.el.scrollHeight > a.el.clientHeight + 1 }));
    for (const L of lines) {
      let l = L.left, t = L.top, r = L.right, b = L.bottom;
      const area = Math.max(0, (r - l) * (b - t));
      total += area;
      let ok = true, needScroll = false;
      for (const c of clips) {
        const a = c.a, cr = c.cr;
        const clipX = a.ovx !== 'visible', clipY = a.ovy !== 'visible';
        const outX = clipX && (r <= cr.l + 0.25 || l >= cr.r - 0.25);
        const outY = clipY && (b <= cr.t + 0.25 || t >= cr.b - 0.25);
        if (outX || outY) {
          if ((outX && !c.canX) || (outY && !c.canY)) { ok = false; break; }
          if (outY) { const ct = t - cr.t + a.el.scrollTop; if (ct + (b - t) <= 0 || ct >= a.el.scrollHeight) { ok = false; break; } }
          if (outX) { const cl = l - cr.l + a.el.scrollLeft; if (cl + (r - l) <= 0 || cl >= a.el.scrollWidth) { ok = false; break; } }
          needScroll = true;
          /* 假设已滚到位:把矩形平移进该滚动容器的可视区,再继续判断更外层的裁剪 */
          if (outY) { const h = b - t, nt = h < cr.b - cr.t ? cr.t + (cr.b - cr.t - h) / 2 : cr.t; t = nt; b = Math.min(nt + h, cr.b); }
          if (outX) { const wd = r - l, nl = wd < cr.r - cr.l ? cr.l + (cr.r - cr.l - wd) / 2 : cr.l; l = nl; r = Math.min(nl + wd, cr.r); }
          continue;
        }
        if (clipX) { l = Math.max(l, cr.l); r = Math.min(r, cr.r); }
        if (clipY) { t = Math.max(t, cr.t); b = Math.min(b, cr.b); }
      }
      if (!ok) continue;
      if (!needScroll && r > 0 && l < vw && b > 0 && t < vh) {
        const rl = Math.max(l, 0), rr = Math.min(r, vw), rt = Math.max(t, 0), rb = Math.min(b, vh);
        if (rr - rl >= 0.4 && rb - rt >= 0.4 && (rr - rl >= 2 || rb - rt >= 2)) {
          out.push({ l: rl, t: rt, r: rr, b: rb });
          vis += (rr - rl) * (rb - rt);
          reachable = true;
        }
        continue;
      }
      if (needScroll) { reachable = true; continue; }
      const okY = (b > 0 && t < vh) || (!ci.fixed && rootCanY && (b + sy) > 0 && (t + sy) < ds.h);
      const okX = (r > 0 && l < vw) || (!ci.fixed && rootCanX && (r + sx) > 0 && (l + sx) < ds.w);
      if (okY && okX) reachable = true;
    }
    return { state: out.length ? 'visible' : (reachable ? 'scroll' : 'hidden'), rects: out, frac: total > 0 ? vis / total : 0 };
  }
  function union(rects) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const x of rects) { l = Math.min(l, x.l !== undefined ? x.l : x.left); t = Math.min(t, x.t !== undefined ? x.t : x.top); r = Math.max(r, x.r !== undefined ? x.r : x.right); b = Math.max(b, x.b !== undefined ? x.b : x.bottom); }
    return { l: l, t: t, r: r, b: b };
  }
  function covers(n, b) {
    const r = n.getBoundingClientRect();
    return b.l >= r.left - 1 && b.r <= r.right + 1 && b.t >= r.top - 1 && b.b <= r.bottom + 1;
  }
  function clampInto(b, c) {
    const cr = clipRectOf(c);
    let l = b.l, t = b.t, r = b.r, bb = b.b;
    if (c.ovx !== 'visible' && (r > cr.r || l < cr.l)) { const w = r - l; l = Math.min(Math.max(l, cr.l), Math.max(cr.l, cr.r - w)); r = Math.min(l + w, cr.r); }
    if (c.ovy !== 'visible' && (bb > cr.b || t < cr.t)) { const h = bb - t; t = Math.min(Math.max(t, cr.t), Math.max(cr.t, cr.b - h)); bb = Math.min(t + h, cr.b); }
    return { l: l, t: t, r: r, b: bb };
  }

  /* ---------- 解析路径:沿祖先链"组合成" ---------- */
  function solveAnalytic(el, fg, bbox, ci) {
    let b = { l: bbox.l, t: bbox.t, r: bbox.r, b: bbox.b };
    let imgBg = [0, 0, 0, 0], imgTx = lt_premult(fg);
    const clipSet = new Map();
    if (ci) for (const a of ci.list) clipSet.set(a.el, a);
    const htmlInfo = info(html);
    for (let n = el; n; n = parentEl(n)) {
      const i = info(n);
      if (clipSet.has(n)) b = clampInto(b, clipSet.get(n));
      if (imgBg[3] < 0.9999) {
        if (i.img !== 'none') return { pixel: 'bg-image', cross: crossOrigin(i.img), sig: i.img.slice(0, 120) + '|' + i.bg.map((v) => Math.round(v * 100)).join(',') };
        if (i.backdrop) return { pixel: 'backdrop-filter', sig: i.bg.map((v) => Math.round(v * 100)).join(',') };
        if (i.bg[3] > 0 && i.display !== 'contents') {
          const rootPaint = n === html || (n === doc.body && htmlInfo.bg[3] === 0 && htmlInfo.img === 'none');
          if (!rootPaint && !covers(n, b)) return { pixel: 'partial-cover', sig: n.localName };
          const p = lt_premult(i.bg);
          imgBg = lt_over(imgBg, p);
          imgTx = lt_over(imgTx, p);
        }
      }
      if (i.blend) return { pixel: 'blend-mode' };
      if (i.filter) return { pixel: 'filter' };
      if (i.op < 1) {
        imgBg = imgBg.map((v) => v * i.op);
        imgTx = imgTx.map((v) => v * i.op);
      }
    }
    if (imgBg[3] < 0.9999) return { pixel: 'transparent-canvas' };
    return { ok: true, bg: lt_round(imgBg), fg: lt_round(imgTx) };
  }

  /* ---------- 叠层登记:同位置的定位叠层 / 媒体元素 / 带背景的伪元素 ---------- */
  function pseudoCandidates() {
    const sels = new Set();
    const visit = (rules) => {
      for (const r of rules) {
        try {
          if (r.cssRules && !r.selectorText) { if (r.type === 7 || r.type === 8) continue; visit(r.cssRules); continue; }
          if (!r.selectorText || !/::?(before|after)/.test(r.selectorText)) continue;
          const st = r.style;
          if (!(st.background || st.backgroundColor || st.backgroundImage)) continue;
          for (let s of r.selectorText.split(',')) {
            if (!/::?(before|after)/.test(s)) continue;
            s = s.replace(/::?(before|after)\s*$/, '').trim();
            if (/::?[a-z-]+\s*$/.test(s) && /::/.test(s)) continue;
            sels.add(s || '*');
          }
        } catch (e) { /* ignore */ }
      }
    };
    for (const sh of Array.from(doc.styleSheets)) { try { visit(sh.cssRules); } catch (e) { /* 跨域样式表读不到,忽略 */ } }
    const els = new Set();
    for (const s of sels) { try { doc.querySelectorAll(s).forEach((e) => els.add(e)); } catch (e) { /* 非法选择器 */ } }
    return els;
  }
  function buildOverlays() {
    const vh = innerHeight;
    const push = (o) => { if (o.r - o.l >= 1 && o.b - o.t >= 1) S.overlays.push(o); };
    for (const e of doc.querySelectorAll('body *')) {
      const tag = e.localName;
      if (e instanceof SVGElement && tag !== 'svg') continue;
      const i = info(e);
      let kind = null;
      if (tag === 'canvas' || tag === 'video' || tag === 'iframe' || tag === 'embed' || tag === 'object') kind = 'media';
      else if (tag === 'img' || tag === 'svg' || tag === 'picture') kind = 'image';
      else if (i.pos !== 'static' && (i.bg[3] > 0 || i.img !== 'none')) kind = 'paint';
      if (!kind) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (kind !== 'paint' && !e.checkVisibility()) continue;
      const cross = (kind === 'image' && tag === 'img' && (() => { try { return new URL(e.currentSrc || e.src, location.href).origin !== location.origin && !/^data:/.test(e.currentSrc || e.src); } catch (x) { return false; } })()) || (kind === 'paint' && crossOrigin(i.img));
      push({ el: e, kind: kind, fixed: i.pos === 'fixed', l: r.left, t: r.top, r: r.right, b: r.bottom, cross: !!cross });
      if (kind === 'media') S.regions.push({ el: e, tag: tag, l: r.left, t: r.top, w: r.width, h: r.height });
    }
    for (const e of pseudoCandidates()) {
      for (const ps of ['::before', '::after']) {
        let pc;
        try { pc = getComputedStyle(e, ps); } catch (x) { continue; }
        if (!pc || pc.content === 'none' || pc.content === 'normal') continue;
        if (pc.position !== 'absolute' && pc.position !== 'fixed') continue;
        if (!(parseColor(pc.backgroundColor)[3] > 0 || pc.backgroundImage !== 'none')) continue;
        const r = e.getBoundingClientRect();
        const fixed = pc.position === 'fixed';
        push({ el: e, pseudo: true, kind: 'paint', fixed: fixed, l: fixed ? 0 : r.left, t: fixed ? 0 : r.top, r: fixed ? innerWidth : r.right, b: fixed ? vh : r.bottom, cross: crossOrigin(pc.backgroundImage) });
      }
    }
  }
  function overlayHits(el, bb) {
    const res = { hit: false, media: null, cross: false, sigs: [] };
    const vh = innerHeight;
    for (const o of S.overlays) {
      if (!o.pseudo && (o.el === el || o.el.contains(el))) continue;
      if (o.pseudo && o.el === el && false) continue;
      let ok;
      const xo = bb.l < o.r - 0.5 && bb.r > o.l + 0.5;
      if (o.fixed) {
        const inFirst = bb.b > 0 && bb.t < vh;
        ok = xo && (inFirst ? (bb.t < o.b - 0.5 && bb.b > o.t + 0.5) : (o.b - o.t >= vh * 0.5));
      } else ok = xo && bb.t < o.b - 0.5 && bb.b > o.t + 0.5;
      if (!ok) continue;
      res.hit = true;
      if (res.sigs.length < 4) res.sigs.push(o.el.localName + (o.pseudo ? '~' : '') + '.' + Array.from(o.el.classList).slice(0, 2).join('.') + (o.fixed ? 'F' : ''));
      if (o.kind === 'media') res.media = o;
      if (o.cross) res.cross = true;
    }
    return res;
  }

  /* ---------- 文本条目 ---------- */
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title', 'head', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'canvas', 'defs', 'clippath', 'mask', 'metadata', 'desc', 'lineargradient', 'radialgradient', 'pattern', 'marker', 'symbol', 'filter', 'iframe', 'object', 'embed', 'video', 'audio']);
  const PICTO = /(?:\p{Extended_Pictographic}[\uFE0F\u200D]?|[\uFE0F\u200D])+/gu;
  let hasDisabled = false;

  function parseShadows(str) {
    if (!str || str === 'none') return [];
    const layers = [];
    let depth = 0, cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) layers.push(cur);
    return layers.map((s) => {
      const cm = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i.exec(s);
      const col = cm ? parseColor(cm[1]) : [0, 0, 0, 1];
      const nums = (s.replace(cm ? cm[1] : '', '').match(/-?[\d.]+px/g) || []).map(parseFloat);
      return { a: col[3], blur: nums.length >= 3 ? nums[2] : 0 };
    });
  }
  function fgOf(el) {
    const c = cs(el);
    if (el instanceof SVGElement && el.localName !== 'svg' && el.closest('svg')) {
      if (/^url\(/.test(c.fill)) return { fg: [0, 0, 0, 1], paintServer: true };
      const col = parseColor(c.fill).slice();
      const fo = parseFloat(c.fillOpacity);
      col[3] *= isNaN(fo) ? 1 : fo;
      return { fg: col };
    }
    return { fg: parseColor(c.webkitTextFillColor || c.color) };
  }
  function pxSize(el) {
    const c = cs(el);
    let fs = parseFloat(c.fontSize) || 16;
    if (el instanceof SVGElement && el.getScreenCTM) {
      try { const m = el.getScreenCTM(); if (m) fs *= Math.sqrt(m.a * m.a + m.b * m.b); } catch (e) { /* ignore */ }
    }
    return fs;
  }
  function estimateGradient(gct) {
    const img = cs(gct).backgroundImage;
    const stops = (img.match(/rgba?\([^)]*\)/g) || []).map(parseColor);
    if (!stops.length) return null;
    const par = parentEl(gct);
    if (!par) return null;
    const r = gct.getBoundingClientRect();
    const sol = solveAnalytic(par, [0, 0, 0, 1], { l: r.left, t: r.top, r: r.right, b: r.bottom }, clipInfo(par));
    if (!sol.ok) return { note: '背景需像素采样,无法估算' };
    let min = Infinity;
    for (const s of stops) {
      const f = lt_round(lt_over(lt_premult(s), sol.bg.concat([1])).slice(0, 3));
      min = Math.min(min, lt_contrast(f, sol.bg));
    }
    return { min: min, bg: sol.bg };
  }

  /* o: {kind, el, ranges:[Range]|null, rectsFn, text, fgPack, ...} */
  function allLines(e) {
    if (e.rectsFn) return e.rectsFn();
    const out = [];
    for (const rg of e.ranges) for (const r of rg.getClientRects()) if (r.width >= 0.4 && r.height >= 0.4) out.push(r);
    return out;
  }
  function addText(o) {
    const el = o.el;
    const lines = allLines(o);
    if (!lines.length) { stat('noRects'); return; }
    if (lines.every((r) => r.width <= 2 && r.height <= 2)) { stat('tinyHidden'); return; }
    const ci = clipInfo(el, o.kind === 'text');
    const v = visibility(lines, ci);
    if (v.state === 'hidden') {
      stat('clippedOrOffscreen');
      if (cfg.debug && (S.hiddenSamples = S.hiddenSamples || []).length < 25) S.hiddenSamples.push({ sel: selectorFor(el), r: [Math.round(lines[0].left), Math.round(lines[0].top), Math.round(lines[0].width), Math.round(lines[0].height)], dead: ci.dead, fixed: ci.fixed, clips: ci.list.map((a) => selectorFor(a.el) + ' ' + a.ovx + '/' + a.ovy) });
      return;
    }
    const c = cs(el);
    const op = opChain(el);
    const fg = o.fg;
    const shadows = parseShadows(c.textShadow);
    const outline = shadows.some((s) => s.blur <= 2 && s.a >= 0.3);
    const glow = shadows.some((s) => s.a > 0.05);
    const effA = fg[3] * op;
    const manual = [];
    let gct = null;
    for (let n = el; n; n = parentEl(n)) { const nc = cs(n); if ((nc.backgroundClip === 'text' || nc.webkitBackgroundClip === 'text') && nc.backgroundImage !== 'none') { gct = n; break; } }
    if (gct) manual.push('gradient-text');
    else if (effA < 0.02) {
      if (glow) manual.push('shadow-only-text');
      else { stat('transparentText'); return; }
    }
    if (o.paintServer) manual.push('svg-paint-server');
    const fs = o.fs !== undefined ? o.fs : pxSize(el);
    const fw = parseInt(c.fontWeight, 10) || (c.fontWeight === 'bold' ? 700 : 400);
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700);
    const symbolOnly = !/[\p{L}\p{N}]/u.test(o.text);
    const e = {
      id: S.entries.length, kind: o.kind, el: el, ranges: o.ranges, rectsFn: o.rectsFn, text: o.text.slice(0, 60),
      fs: Math.round(fs * 100) / 100, bold: fw >= 700, required: (large || symbolOnly) ? 3 : 4.5, symbol: symbolOnly,
      fg: lt_round(fg), fgA: Math.min(1, effA), manual: manual, disabled: false, an: null, why: null, outline: outline,
      state: v.state, nlines: lines.length
    };
    if (hasDisabled) {
      const d = el.closest('button,input,select,textarea,fieldset,optgroup,[aria-disabled="true"]');
      if (d && (d.matches(':disabled') || d.getAttribute('aria-disabled') === 'true')) e.disabled = true;
    }
    const bbAll = union(lines);
    e.bb0 = [Math.round(bbAll.l + scrollX), Math.round(bbAll.t + scrollY), Math.round(bbAll.r - bbAll.l), Math.round(bbAll.b - bbAll.t)];
    S.entries.push(e);
    if (e.disabled) return;
    if (gct) { e.est = estimateGradient(gct); (S.gct = S.gct || new Set()).add(gct); return; }
    const bb = v.state === 'visible' ? union(v.rects) : bbAll;
    const oh = overlayHits(el, bbAll);
    if (oh.media) {
      e.manual.push('media-overlay');
      e.mediaSel = { el: oh.media.el, tag: oh.media.el.localName };
    }
    if (oh.cross) e.manual.push('cross-origin-bg');
    let srcSig = '';
    if (cfg.forcePixel || o.forcePixel || oh.hit) { e.why = oh.hit ? 'overlay' : 'forced'; srcSig = oh.sigs.join('+'); }
    else {
      const r = solveAnalytic(el, [fg[0], fg[1], fg[2], fg[3]], bb, ci);
      if (r.ok) e.an = { bg: r.bg, fg: r.fg, ratio: lt_contrast(r.fg, r.bg) };
      else { e.why = r.pixel; srcSig = r.sig || ''; if (r.cross) e.manual.push('cross-origin-bg'); }
    }
    if (e.why) {
      e.sig = [o.kind, e.fg.join(','), e.fgA.toFixed(2), e.why, srcSig, e.fs, e.required, e.manual.join('+')].join('|');
      const chunks = Math.max(1, Math.ceil(lines.length / 10));
      for (let k = 0; k < chunks; k++) S.pending.push({ e: e, a: k * 10, b: (k + 1) * 10, key: e.id + ':' + k, top: bbAll.t + scrollY, left: bbAll.l + scrollX, tries: 0 });
    }
  }

  function collectTexts() {
    const walker = doc.createTreeWalker(doc.body || html, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) return SKIP_TAGS.has(n.localName.toLowerCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const tn of nodes) {
      const el = tn.parentElement;
      if (!el) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) { stat('notVisible'); continue; }
      const data = tn.data;
      const segs = [];
      let last = 0, m;
      PICTO.lastIndex = 0;
      let hadPicto = false;
      while ((m = PICTO.exec(data))) { hadPicto = true; if (m.index > last) segs.push([last, m.index]); last = m.index + m[0].length; }
      if (last < data.length) segs.push([last, data.length]);
      const useSegs = segs.filter((s) => /\S/.test(data.slice(s[0], s[1])));
      if (!useSegs.length) { stat('emojiOnly'); continue; }
      const text = useSegs.map((s) => data.slice(s[0], s[1])).join(' ').replace(/\s+/g, ' ').trim();
      const ranges = useSegs.map((s) => { const rg = doc.createRange(); rg.setStart(tn, s[0]); rg.setEnd(tn, s[1]); return rg; });
      const pk = fgOf(el);
      addText({ kind: (el instanceof SVGElement && el.closest('svg') && el.localName !== 'svg') ? 'svgtext' : 'text', el: el, ranges: ranges, text: text, fg: pk.fg, paintServer: pk.paintServer, forcePixel: el instanceof SVGElement && !!el.closest('svg') });
      if (hadPicto) stat('mixedEmoji');
    }
  }

  const TEXT_INPUT_SKIP = new Set(['hidden', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit', 'button']);
  function contentBox(el) {
    const r = el.getBoundingClientRect();
    const c = cs(el);
    const l = r.left + el.clientLeft + (parseFloat(c.paddingLeft) || 0);
    const rr = r.right - el.clientLeft - (parseFloat(c.paddingRight) || 0);
    const t = r.top + el.clientTop + (parseFloat(c.paddingTop) || 0);
    const b = r.bottom - el.clientTop - (parseFloat(c.paddingBottom) || 0);
    return { left: l, right: Math.max(l + 1, rr), top: t, bottom: Math.max(t + 1, b), width: Math.max(1, rr - l), height: Math.max(1, b - t) };
  }
  function collectFormText() {
    for (const el of doc.querySelectorAll('input,textarea,select')) {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) continue;
      const tag = el.localName, type = (el.type || '').toLowerCase();
      const c = cs(el);
      const fillOf = (cstyle) => parseColor(cstyle.webkitTextFillColor || cstyle.color);
      const mk = (kind, text, fg, extra) => {
        const lh = parseFloat(c.lineHeight) || (parseFloat(c.fontSize) || 14) * 1.3;
        const rectsFn = () => {
          const b = contentBox(el);
          if (tag === 'textarea') return [{ left: b.left, right: b.right, top: b.top, bottom: Math.min(b.bottom, b.top + lh), width: b.width, height: Math.min(b.height, lh) }];
          const h = Math.min(b.height, Math.max(lh, (parseFloat(c.fontSize) || 14) * 1.25));
          const top = b.top + (b.height - h) / 2;
          return [{ left: b.left, right: b.right, top: top, bottom: top + h, width: b.width, height: h }];
        };
        addText(Object.assign({ kind: kind, el: el, ranges: null, rectsFn: rectsFn, text: text, fg: fg }, extra || {}));
      };
      if (tag === 'select') {
        const opt = el.selectedOptions && el.selectedOptions[0];
        const t = opt ? (opt.text || '').trim() : '';
        if (t) mk('value', t, fillOf(c));
        continue;
      }
      if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
        if (el.value) mk('value', el.value, fillOf(c));
        continue;
      }
      if (tag === 'input' && TEXT_INPUT_SKIP.has(type)) continue;
      const dateLike = /^(date|time|datetime-local|month|week)$/.test(type);
      if (el.value !== '' && el.value !== undefined) mk('value', type === 'password' ? '••••' : String(el.value), fillOf(c));
      else if (dateLike) mk('value', type, fillOf(c));
      if ((el.value === '' || el.value === undefined) && el.placeholder) {
        let pc;
        try { pc = getComputedStyle(el, '::placeholder'); } catch (e) { pc = null; }
        if (pc) {
          const col = parseColor(pc.webkitTextFillColor || pc.color).slice();
          const po = parseFloat(pc.opacity);
          col[3] *= isNaN(po) ? 1 : po;
          mk('placeholder', el.placeholder, col);
        }
      }
    }
  }

  /* ---------- 控件边界 / 卡片 / SVG ---------- */
  function boxLines(el) { const r = el.getBoundingClientRect(); return [{ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }]; }
  function borderInfo(c) {
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const bw = sides.map((s) => (c['border' + s + 'Style'] === 'none' || c['border' + s + 'Style'] === 'hidden') ? 0 : parseFloat(c['border' + s + 'Width']) || 0);
    const vis = sides.map((s, i) => bw[i] > 0 && parseColor(c['border' + s + 'Color'])[3] > 0);
    return { bw: bw, any: vis.some(Boolean) };
  }
  function hasShadowRing(c) {
    const bs = c.boxShadow;
    return !!bs && bs !== 'none' && /rgba?\(|#/.test(bs);
  }
  function collectControls() {
    for (const el of doc.querySelectorAll('input,select,textarea,button')) {
      const tag = el.localName, type = (el.type || '').toLowerCase();
      if (tag === 'input' && (type === 'hidden' || type === 'color' || type === 'file' || type === 'image')) continue;
      const c = cs(el);
      if ((type === 'checkbox' || type === 'radio' || type === 'range') && (c.appearance !== 'none' && c.webkitAppearance !== 'none')) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) continue;
      const lines = boxLines(el);
      if (lines[0].width < 8 || lines[0].height < 8) continue;
      const ci = clipInfo(el);
      const v = visibility(lines, ci);
      if (v.state === 'hidden') continue;
      const bi = borderInfo(c);
      const hasFill = parseColor(c.backgroundColor)[3] > 0.01 || c.backgroundImage !== 'none';
      const ind = bi.any || hasFill || hasShadowRing(c) || (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0);
      const textLike = tag === 'select' || tag === 'textarea' || (tag === 'input' && !(type === 'submit' || type === 'button' || type === 'reset' || type === 'checkbox' || type === 'radio'));
      let disabled = el.disabled === true;
      const e = { id: S.entries.length, kind: 'control', el: el, tag: tag + (type ? '[' + type + ']' : ''), rectsFn: () => boxLines(el), ind: !!ind, textLike: textLike, bw: bi.bw, disabled: disabled, manual: [], state: v.state };
      const r0 = lines[0];
      e.bb0 = [Math.round(r0.left + scrollX), Math.round(r0.top + scrollY), Math.round(r0.width), Math.round(r0.height)];
      S.entries.push(e);
      if (disabled) continue;
      if (!ind && !textLike) continue;     // 无边框无底色的纯文字按钮:不属于边界检查
      if (!ind) { e.noBoundary = true; continue; }
      e.sig = ['control', e.tag, bi.bw.join(','), c.borderTopColor, c.borderRightColor, c.borderBottomColor, c.borderLeftColor, c.backgroundColor, (c.backgroundImage || '').slice(0, 80), (c.boxShadow || '').slice(0, 80), c.outlineStyle].join('|');
      S.pending.push({ e: e, a: 0, b: 1, key: e.id + ':0', top: r0.top + scrollY, left: r0.left + scrollX, tries: 0 });
    }
  }
  function collectCards() {
    const seen = new Set();
    let n = 0;
    for (const el of doc.querySelectorAll('div,section,article,aside,li,details,table,figure,form,header,nav,fieldset')) {
      if (n >= 40) break;
      if (el === doc.body || el === html) continue;
      const c = cs(el);
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 40) continue;
      const bi = borderInfo(c);
      const i = info(el);
      const fill = i.bg[3] >= 0.02 || i.img !== 'none';
      if (!(bi.any || fill || hasShadowRing(c))) continue;
      if (!(el.textContent || '').trim()) continue;
      if (el.closest('button,select,textarea,input')) continue;
      const sig = el.localName + '.' + Array.from(el.classList).sort().join('.');
      if (seen.has(sig)) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) continue;
      const lines = boxLines(el);
      const v = visibility(lines, clipInfo(el));
      if (v.state === 'hidden') continue;
      seen.add(sig); n++;
      const e = { id: S.entries.length, kind: 'card', el: el, rectsFn: () => boxLines(el), bw: bi.bw, manual: [], disabled: false, state: v.state, sig: sig };
      e.bb0 = [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
      S.entries.push(e);
      S.pending.push({ e: e, a: 0, b: 1, key: e.id + ':0', top: r.top + scrollY, left: r.left + scrollX, tries: 0 });
    }
  }
  function collectSvgs() {
    for (const svg of doc.querySelectorAll('svg')) {
      if (svg.parentElement && svg.parentElement.closest('svg')) continue;
      if (svg.closest('defs')) continue;
      const sr = svg.getBoundingClientRect();
      if (sr.width < 4 || sr.height < 4) continue;
      if (svg.checkVisibility && !svg.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) continue;
      const ci = clipInfo(svg);
      const lines = [{ left: sr.left, top: sr.top, right: sr.right, bottom: sr.bottom }];
      const v = visibility(lines, ci);
      if (v.state === 'hidden') continue;
      const icon = sr.width <= 64 && sr.height <= 64;
      const groups = new Map();
      let backdrop = null;
      const svgOp = info(svg).op;
      for (const s of svg.querySelectorAll('path,line,polyline,polygon,circle,ellipse,rect')) {
        if (s.closest('defs,clipPath,mask,pattern,marker,symbol')) continue;
        const sc = cs(s);
        if (sc.display === 'none' || sc.visibility === 'hidden') continue;
        const bb = s.getBoundingClientRect();
        if (bb.width === 0 && bb.height === 0) continue;
        let opIn = 1;
        for (let n = s; n && n !== svg; n = n.parentElement) opIn *= info(n).op;
        opIn *= svgOp;
        let scale = 1;
        try { const m = s.getScreenCTM(); if (m) scale = Math.sqrt(m.a * m.a + m.b * m.b); } catch (x) { /* ignore */ }
        const paints = [];
        const fillStr = sc.fill, strokeStr = sc.stroke;
        let fillGrad = false;
        if (fillStr !== 'none' && s.localName !== 'line') {
          if (/^url\(/.test(fillStr)) fillGrad = true;
          else { const col = parseColor(fillStr).slice(); const fo = parseFloat(sc.fillOpacity); col[3] *= (isNaN(fo) ? 1 : fo) * opIn; if (col[3] > 0.02) paints.push({ type: 'fill', col: col }); }
        }
        let strokeW = 0;
        if (strokeStr !== 'none' && !/^url\(/.test(strokeStr)) {
          strokeW = (parseFloat(sc.strokeWidth) || 0) * scale;
          const col = parseColor(strokeStr).slice(); const so = parseFloat(sc.strokeOpacity); col[3] *= (isNaN(so) ? 1 : so) * opIn;
          if (strokeW > 0.1 && col[3] > 0.02) paints.push({ type: 'stroke', col: col, w: strokeW });
        }
        if (!paints.length) continue;
        if (s.localName === 'rect' && bb.width * bb.height >= sr.width * sr.height * 0.9 && paints.some((p) => p.type === 'fill' && p.col[3] > 0.5) && !backdrop) { backdrop = paints.find((p) => p.type === 'fill').col; continue; }
        const hasFill = paints.some((p) => p.type === 'fill' && p.col[3] >= 0.3);
        const hasStroke = paints.some((p) => p.type === 'stroke' && p.w >= 1.5 && p.col[3] >= 0.3);
        const key = icon || hasFill || hasStroke || fillGrad;
        const sig = paints.map((p) => p.type[0] + lt_round(p.col).join(',') + '/' + Math.round(p.col[3] * 100)).join('|') + (key ? '|K' : '|t');
        let g = groups.get(sig);
        if (!g) { g = { paints: paints.map((p) => ({ type: p.type, col: p.col })), key: key, n: 0, el: s, thin: !key }; groups.set(sig, g); }
        g.n++;
      }
      if (!groups.size) continue;
      const e = { id: S.entries.length, kind: 'svg', el: svg, rectsFn: () => boxLines(svg), manual: [], disabled: false, state: v.state, icon: icon, backdrop: backdrop, groups: Array.from(groups.values()), bgAn: null, why: null };
      e.bb0 = [Math.round(sr.left + scrollX), Math.round(sr.top + scrollY), Math.round(sr.width), Math.round(sr.height)];
      S.entries.push(e);
      const bbAll = { l: sr.left, t: sr.top, r: sr.right, b: sr.bottom };
      const oh = overlayHits(svg, bbAll);
      const sol = (cfg.forcePixel || oh.hit) ? { pixel: 'overlay' } : solveAnalytic(svg, [0, 0, 0, 1], bbAll, ci);
      if (sol.ok) {
        let bg = sol.bg;
        if (backdrop) bg = lt_round(lt_over(lt_premult(backdrop), bg.concat([1])).slice(0, 3));
        e.bgAn = bg;
      } else {
        e.why = sol.pixel;
        e.sig = 'svg|' + sol.pixel + '|' + (sol.sig || '') + '|' + e.groups.map((g) => g.paints.map((p) => p.type[0] + lt_round(p.col).join(',') + '/' + Math.round(p.col[3] * 100)).join('+') + (g.key ? 'K' : 't')).join(';');
        S.pending.push({ e: e, a: 0, b: 1, key: e.id + ':0', top: sr.top + scrollY, left: sr.left + scrollX, tries: 0 });
      }
    }
  }

  /* ---------- 采集入口 ---------- */
  LT.collect = function () {
    window.scrollTo(0, 0);
    hasDisabled = !!doc.querySelector(':disabled, [aria-disabled="true"]');
    buildOverlays();
    collectTexts();
    collectFormText();
    collectControls();
    collectCards();
    collectSvgs();
    /* 重复版型抽样:同一"像素判定版型"(前景色 + 触发原因 + 背景源 + 字号)超过 thin 个实例时,按分位数保留 thin 个,
       让 24 万像素高的长文档页不必扫完每一屏;版型唯一的实例永远保留。thin=0 关闭 */
    if (cfg.thin > 0) {
      const ds0 = docSize();
      const groups = new Map();
      for (const p of S.pending) if (p.e.sig) { if (!groups.has(p.e.sig)) groups.set(p.e.sig, new Map()); groups.get(p.e.sig).set(p.e.id, p.e); }
      let dropped = 0;
      for (const m of groups.values()) {
        if (m.size <= cfg.thin) continue;
        /* 在文档高度上均匀放 thin 个锚点,每个版型取离各锚点最近的实例:不同版型的取样点聚在同几屏,截图遍数最少 */
        const list = Array.from(m.values());
        const keep = new Set();
        for (let i = 0; i < cfg.thin; i++) {
          const ay = ds0.h * (i / (cfg.thin - 1 || 1));
          let best = null;
          for (const e of list) { const d = Math.abs(e.bb0[1] - ay); if (!best || d < best.d) best = { d: d, e: e }; }
          keep.add(best.e.id);
        }
        for (const e of list) if (!keep.has(e.id)) { e.sampledOut = true; dropped++; }
      }
      S.pending = S.pending.filter((p) => !p.e.sampledOut);
      stat('sampledOut', dropped);
    }
    S.pending.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    const ds = docSize();
    return { pendingKinds: cfg.debug ? S.pending.reduce((m, p) => { const k = p.e.kind + (p.e.sig ? '' : ':nosig'); m[k] = (m[k] || 0) + 1; return m; }, {}) : undefined, overlaySamples: cfg.debug ? S.overlays.slice(0, 80).map((o) => selectorFor(o.el) + (o.pseudo ? '::pseudo' : '') + ' ' + o.kind + (o.fixed ? ' fixed' : '') + ' [' + [o.l, o.t, o.r - o.l, o.b - o.t].map(Math.round) + ']') : undefined, hiddenSamples: S.hiddenSamples, entries: S.entries.length, pending: S.pending.length, stats: S.stats, overlays: S.overlays.length, doc: ds, rootCanY: rootCanY, rootCanX: rootCanX };
  };

  /* ---------- 像素阶段:文字透明化、滚动到位、就绪判定 ---------- */
  LT.enterTransparent = function () {
    if (S.gct) S.gct.forEach((n) => n.setAttribute('data-lt-gct', ''));
    let st = doc.getElementById('__lt_transparent');
    if (!st) {
      st = doc.createElement('style');
      st.id = '__lt_transparent';
      st.textContent = '*,*::before,*::after{-webkit-text-fill-color:transparent!important;-webkit-text-stroke-color:transparent!important;text-shadow:none!important;text-decoration-color:transparent!important;caret-color:transparent!important}' +
        '::placeholder{color:transparent!important;-webkit-text-fill-color:transparent!important;opacity:1!important}' +
        'svg text,svg tspan,svg textPath{fill:transparent!important;stroke:transparent!important}' +
        '[data-lt-gct],[data-lt-gct]::before,[data-lt-gct]::after{background-image:none!important}' +
        'html,*{scroll-behavior:auto!important}';
      (doc.head || html).appendChild(st);
    }
    void html.offsetWidth;
    return true;
  };
  LT.leaveTransparent = function () {
    const st = doc.getElementById('__lt_transparent');
    if (st) st.remove();
    if (S.gct) S.gct.forEach((n) => n.removeAttribute('data-lt-gct'));
    return true;
  };
  function firstLine(p) { const ls = allLines(p.e).slice(p.a, p.b); return ls[0] || null; }
  function reveal(p) {
    const e = p.e;
    let L = firstLine(p);
    if (!L) return;
    const ci = clipInfo(e.el, e.kind === 'text');
    const mode = p.tries % 3;     // 0 居中 / 1 靠上 / 2 靠下
    const aim = (rectAreaTop, rectAreaH) => (mode === 0 ? rectAreaTop + rectAreaH / 2 : mode === 1 ? rectAreaTop + Math.min(120, rectAreaH * 0.25) : rectAreaTop + rectAreaH - Math.min(120, rectAreaH * 0.25));
    for (const a of ci.list) {
      const canY = (a.ovy === 'auto' || a.ovy === 'scroll') && a.el.scrollHeight > a.el.clientHeight + 1;
      const canX = (a.ovx === 'auto' || a.ovx === 'scroll') && a.el.scrollWidth > a.el.clientWidth + 1;
      if (!canY && !canX) continue;
      const cr = clipRectOf(a);
      L = firstLine(p);
      if (!L) return;
      if (canY) a.el.scrollTop += (L.top + L.height / 2) - aim(cr.t, cr.b - cr.t);
      if (canX) a.el.scrollLeft += (L.left + Math.min(L.width, 40) / 2) - (cr.l + (cr.r - cr.l) / 2);
    }
    if (!ci.fixed) {
      L = firstLine(p);
      if (!L) return;
      const dy = rootCanY ? (L.top + L.height / 2) - aim(0, innerHeight) : 0;
      const dx = rootCanX ? (L.left + Math.min(L.width, 40) / 2) - innerWidth / 2 : 0;
      const needX = (L.left < 0 || L.right > innerWidth) ? dx : 0;   // 水平方向只在文字没进视口时才滚
      if (needX || dy) window.scrollBy({ top: dy, left: needX, behavior: 'instant' });
    }
  }
  function hitOk(e, x, y) {
    const t = doc.elementFromPoint(x, y);
    if (!t) return false;
    if (t === e.el || e.el.contains(t) || t.contains(e.el)) return true;
    try { if (cs(e.el).pointerEvents === 'none') return true; } catch (x2) { /* ignore */ }
    return false;
  }
  function geomNow(p, force) {
    const e = p.e;
    if (!e.el.isConnected) return { drop: true };
    const lines = allLines(e).slice(p.a, p.b);
    if (!lines.length) return { drop: true };
    const v = visibility(lines, clipInfo(e.el, e.kind === 'text'));
    if (v.state === 'hidden') return { drop: true };
    const need = e.kind === 'svg' ? 0.85 : e.kind === 'control' || e.kind === 'card' ? 0.98 : 0.95;
    let ready = v.rects.length > 0 && v.frac >= need;
    if (!ready && force && v.rects.length) ready = true;
    if (!ready) return null;
    const u = union(v.rects);
    let obscured = false;
    if (e.kind !== 'svg') {
      const cl = (v, hi) => Math.min(hi - 1, Math.max(0, v));
      if (e.kind === 'control' || e.kind === 'card') obscured = !hitOk(e, cl((u.l + u.r) / 2, innerWidth), cl((u.t + u.b) / 2, innerHeight));
      else for (const r of v.rects) { for (const yy0 of [r.t + 2, (r.t + r.b) / 2, r.b - 2]) { const yy = cl(yy0, innerHeight); for (const xx of [r.l + 2, (r.l + r.r) / 2, r.r - 2]) { if (!hitOk(e, cl(xx, innerWidth), yy)) { obscured = true; break; } } if (obscured) break; } if (obscured) break; }
    }
    if (obscured && !force) return null;
    return { rects: v.rects, obscured: obscured };
  }
  LT.step = function () {
    const P = S.pending;
    if (!P.length) return { done: true, items: [] };
    const head = P[0];
    reveal(head);
    const items = [], rest = [];
    const vh = innerHeight, vw = innerWidth;
    let headDone = false;
    for (const p of P) {
      if (p !== head) {
        const r = p.e.el.getBoundingClientRect();
        if ((r.bottom < -40 || r.top > vh + 40 || r.right < -40 || r.left > vw + 40) && !(r.width === 0 && r.height === 0)) { rest.push(p); continue; }
      }
      const g = geomNow(p, false);
      if (g && g.drop) { if (p === head) headDone = true; stat('droppedPending'); continue; }
      if (g) {
        if (p === head) headDone = true;
        items.push(payload(p, g));
      } else rest.push(p);
    }
    if (!headDone) {
      head.tries++;
      if (head.tries >= 4) {
        const idx = rest.indexOf(head);
        const g = geomNow(head, true);
        if (idx >= 0) rest.splice(idx, 1);
        if (g && !g.drop) items.push(payload(head, g, true));
        else stat('droppedPending');
      }
    }
    S.pending = rest;
    return { done: false, items: items, left: rest.length, dbg: cfg.debug ? { head: selectorFor(head.e.el), kind: head.e.kind, scroll: [scrollX, scrollY], clips: clipInfo(head.e.el, head.e.kind === 'text').list.map((a) => selectorFor(a.el)) } : undefined };
  };
  function payload(p, g, forced) {
    const e = p.e;
    const it = { key: p.key, id: e.id, kind: e.kind, obscured: !!(g.obscured || forced && g.obscured) };
    if (e.kind === 'control' || e.kind === 'card') {
      const r = e.el.getBoundingClientRect();
      it.box = [r.left, r.top, r.right, r.bottom];
      it.bw = e.bw;
    } else it.rects = g.rects.map((r) => [r.l, r.t, r.r, r.b]);
    if (e.kind === 'svg') {
      const r = e.el.getBoundingClientRect();
      it.box = [r.left, r.top, r.right, r.bottom];
    }
    return it;
  }

  /* ---------- 焦点 ---------- */
  LT.focusReset = function () {
    window.scrollTo(0, 0);
    if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur();
    return true;
  };
  LT.activeInfo = function () {
    const a = doc.activeElement;
    if (!a || a === doc.body || a === html) return null;
    try { if (typeof a.setSelectionRange === 'function') a.setSelectionRange(a.value.length, a.value.length); } catch (e) { /* 部分 input 类型不支持 */ }
    try { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); } catch (e) { /* ignore */ }
    const r = a.getBoundingClientRect();
    const c = getComputedStyle(a);
    return {
      key: idOf(a), tag: a.localName + (a.type ? '[' + a.type + ']' : ''), sel: selectorFor(a),
      box: [r.left, r.top, r.right, r.bottom], scroll: [scrollX, scrollY], visible: r.width > 0 && r.height > 0 && c.visibility !== 'hidden',
      outline: c.outlineStyle + ' ' + c.outlineWidth + ' ' + c.outlineColor, shadow: c.boxShadow === 'none' ? '' : c.boxShadow.slice(0, 80)
    };
  };
  LT.blurActive = function () { if (doc.activeElement && doc.activeElement !== doc.body) doc.activeElement.blur(); return true; };

  /* ---------- 导出 ---------- */
  LT.dump = function () {
    return S.entries.map((e) => {
      const o = {
        id: e.id, kind: e.kind, text: e.text, fs: e.fs, bold: e.bold, req: e.required, symbol: e.symbol, fg: e.fg, fgA: e.fgA, manual: e.manual,
        dis: e.disabled, an: e.an, why: e.why, bb0: e.bb0, state: e.state, est: e.est, outline: e.outline, so: !!e.sampledOut
      };
      if (e.kind === 'control') { o.tag = e.tag; o.ind = e.ind; o.textLike = e.textLike; o.noBoundary = !!e.noBoundary; }
      if (e.kind === 'card') o.sig = e.sig;
      if (e.kind === 'svg') {
        o.icon = e.icon; o.bgAn = e.bgAn;
        o.groups = e.groups.map((g, gi) => ({ gi: gi, paints: g.paints, key: g.key, n: g.n, thin: g.thin }));
      }
      if (e.mediaSel) { o.media = e.mediaSel.tag; }
      return o;
    });
  };
  LT.sel = function (ids) {
    const out = {};
    for (const id of ids) {
      const e = S.entries[id];
      if (!e) continue;
      out[id] = selectorFor(e.el);
      if (e.kind === 'svg') out[id + ':g'] = e.groups.map((g) => selectorFor(g.el));
      if (e.mediaSel) out[id + ':m'] = selectorFor(e.mediaSel.el);
    }
    return out;
  };
  LT.regions = function () {
    return S.regions.map((r) => ({ tag: r.tag, sel: selectorFor(r.el), x: Math.round(r.l + scrollX), y: Math.round(r.t + scrollY), w: Math.round(r.w), h: Math.round(r.h) }));
  };
  LT.finishAnimations = function () {
    let n = 0;
    for (const a of doc.getAnimations()) {
      try {
        const it = a.effect && a.effect.getComputedTiming().iterations;
        if (it === Infinity) a.cancel(); else a.finish();
        n++;
      } catch (e) { /* ignore */ }
    }
    return n;
  };
  LT.attrs = function () { return { theme: html.getAttribute('data-theme'), style: html.getAttribute('data-style'), colorScheme: html.style.colorScheme || '' }; };
  return LT;
}

/* 页面加载后的"稳定期"脚本:字体 / 图片 / Nuxt 水合 / DOM 静默 */
const SETTLE_JS = (quiet, max) => `(async () => {
  const t0 = performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try { await Promise.race([document.fonts.ready, sleep(4000)]); } catch (e) {}
  const imgs = Array.from(document.images).filter((i) => !i.complete);
  if (imgs.length) await Promise.race([Promise.all(imgs.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))), sleep(3000)]);
  const nuxt = document.getElementById('__nuxt');
  if (nuxt && document.getElementById('__NUXT_DATA__')) { const end = performance.now() + 8000; while (performance.now() < end && !nuxt.__vue_app__) await sleep(100); }
  await new Promise((resolve) => {
    let timer = setTimeout(done, ${quiet});
    const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${quiet}); });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const cap = setTimeout(done, ${max});
    function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); }
  });
  for (const a of document.getAnimations()) { try { const it = a.effect && a.effect.getComputedTiming().iterations; if (it === Infinity) a.cancel(); else a.finish(); } catch (e) {} }
  await sleep(50);
  return Math.round(performance.now() - t0);
})()`;

/* 每个新文档最先执行:写主题存储、清页面级覆盖、关过渡 */
const INJECT_JS = (style, theme) => `(function () {
  try {
    localStorage.setItem('lifetools_global_style', ${JSON.stringify(style)});
    localStorage.setItem('lifetools_global_theme', ${JSON.stringify(theme)});
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && k.indexOf('lifetools_page_') === 0) localStorage.removeItem(k);
    }
  } catch (e) {}
  var css = '*,*::before,*::after{transition:none!important;scroll-behavior:auto!important}';
  function add() { if (document.getElementById('__lt_noanim')) return; var s = document.createElement('style'); s.id = '__lt_noanim'; s.textContent = css; (document.head || document.documentElement).appendChild(s); }
  if (document.documentElement) add();
  else new MutationObserver(function (m, o) { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
})();`;

/* =============================================================================================
 * PNG 解码(Chrome 截图:8 位 RGB / RGBA,非交错)
 * ============================================================================================= */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12); depth = buf[pos + 16]; ctype = buf[pos + 17]; interlace = buf[pos + 20]; }
    else if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error(`不支持的 PNG 格式 depth=${depth} type=${ctype} interlace=${interlace}`);
  const bpp = ctype === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = (x >= bpp && y > 0) ? out[prev + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[dst + x] = v & 255;
    }
  }
  return {
    w, h, bpp, data: out,
    px(x, y) { const o = (y * w + x) * bpp; return [out[o], out[o + 1], out[o + 2]]; },
    inside(x, y) { return x >= 0 && y >= 0 && x < w && y < h; }
  };
}

/* =============================================================================================
 * 静态服务 / Chrome / CDP
 * ============================================================================================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};
function startServer(rootAbs) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        let p = decodeURIComponent(u.pathname);
        if (p.endsWith('/')) p += 'index.html';
        const fp = path.normalize(path.join(rootAbs, p));
        if (fp !== rootAbs && !fp.startsWith(rootAbs + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
        fs.stat(fp, (err, st) => {
          if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
          if (req.method === 'HEAD') { res.end(); return; }
          fs.createReadStream(fp).pipe(res);
        });
      } catch (e) { res.writeHead(400); res.end('bad request'); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function findChrome(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;   // 显式指定的路径必须存在,不静默回退
  const cands = [];
  if (process.env.CHROME_PATH) cands.push(process.env.CHROME_PATH);
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', lad = process.env.LOCALAPPDATA || '';
  if (process.platform === 'win32') {
    cands.push(path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), lad && path.join(lad, 'Google/Chrome/Application/chrome.exe'),
      path.join(pf, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try { const p = execFileSync('which', [n], { encoding: 'utf8' }).trim(); if (p) cands.push(p); } catch (e) { /* 不在 PATH */ }
    }
    cands.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium');
  }
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return null;
}

class Session {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sid = sessionId; this.handlers = new Map(); }
  send(method, params) { return this.cdp.send(method, params || {}, this.sid); }
  on(ev, cb) { const k = ev; if (!this.handlers.has(k)) this.handlers.set(k, []); this.handlers.get(k).push(cb); }
  emit(ev, params) { const hs = this.handlers.get(ev); if (hs) for (const h of hs) { try { h(params); } catch (e) { /* ignore */ } } }
  waitFor(ev, ms, pred) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`等待事件 ${ev} 超时 (${ms}ms)`)), ms);
      const h = (p) => { if (!pred || pred(p)) { clearTimeout(t); const hs = this.handlers.get(ev); if (hs) hs.splice(hs.indexOf(h), 1); resolve(p); } };
      this.on(ev, h);
    });
  }
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.sessions = new Map(); this.closed = false;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result); }
      } else if (m.method) {
        const s = this.sessions.get(m.sessionId || '');
        if (s) s.emit(m.method, m.params);
      }
    });
    ws.addEventListener('close', () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭')); this.pending.clear(); });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true }); });
    return new CDP(ws);
  }
  send(method, params, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  session(sid) { const s = new Session(this, sid); this.sessions.set(sid, s); return s; }
}

async function launchChrome(opts) {
  const exe = findChrome(opts.chrome);
  if (!exe) throw new Error('未找到 Chrome:请设置环境变量 CHROME_PATH 或使用 --chrome <path>');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-audit-chrome-'));
  const args = [
    `--user-data-dir=${userDir}`, '--headless=new', '--remote-debugging-port=0', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-extensions', '--disable-component-update', '--disable-sync', '--metrics-recording-only',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--password-store=basic', '--use-mock-keychain', 'about:blank'
  ];
  if (opts.offline) args.splice(args.length - 1, 0, '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1');
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderrBuf = '';
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000); });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const portFile = path.join(userDir, 'DevToolsActivePort');
  let wsUrl = null;
  for (let i = 0; i < 150 && !wsUrl; i++) {
    if (exited) break;
    try {
      const t = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (t[0] && t[1]) wsUrl = `ws://127.0.0.1:${t[0].trim()}${t[1].trim()}`;
    } catch (e) { /* 还没写出来 */ }
    if (!wsUrl) await sleep(100);
  }
  const cleanup = async () => {
    try { if (!exited) { child.kill(); } } catch (e) { /* ignore */ }
    for (let i = 0; i < 30 && !exited; i++) await sleep(100);
    if (!exited && child.pid) {
      try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(child.pid, 'SIGKILL'); } catch (e) { /* ignore */ }
    }
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(userDir, { recursive: true, force: true }); break; } catch (e) { await sleep(250); }
    }
  };
  if (!wsUrl) { await cleanup(); throw new Error('Chrome 启动失败(未获得 DevToolsActivePort):' + stderrBuf.trim().slice(-300)); }
  const cdp = await CDP.connect(wsUrl);
  const root = cdp.session('');
  return {
    cdp, exe, userDir,
    async close() {
      try { await Promise.race([cdp.send('Browser.close'), sleep(3000)]); } catch (e) { /* ignore */ }
      await cleanup();
    },
    root
  };
}

/* =============================================================================================
 * 命令行
 * ============================================================================================= */
function parseArgs(argv) {
  const o = {
    root: path.resolve(__dirname, '..'), page: null, style: null, theme: null, width: 1280, height: 800, json: false, shots: null, strict: false,
    console: false, concurrency: 2, timeout: 30000, focus: 8, settle: 500, thin: 6, statesDir: path.join(__dirname, 'audit-states'), noStates: false, state: null,
    offline: false, verifyAttrs: true, warmup: true, pixelAll: false, includePass: false, chrome: null, help: false
  };
  const bools = { json: 'json', strict: 'strict', console: 'console', offline: 'offline', 'pixel-all': 'pixelAll', 'include-pass': 'includePass', 'no-states': 'noStates', help: 'help', h: 'help' };
  const list = new Set(['page', 'style', 'theme', 'state']);
  const nums = new Set(['width', 'height', 'concurrency', 'timeout', 'focus', 'settle', 'thin']);
  const strs = { root: 'root', shots: 'shots', 'states-dir': 'statesDir', chrome: 'chrome' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    a = a.replace(/^-+/, '');
    let val = null;
    const eq = a.indexOf('=');
    if (eq >= 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === 'no-verify-attrs') { o.verifyAttrs = false; continue; }
    if (a === 'no-warmup') { o.warmup = false; continue; }
    if (bools[a]) { o[bools[a]] = true; continue; }
    if (!list.has(a) && !nums.has(a) && !strs[a]) throw new Error(`未知参数: --${a}`);
    if (val === null) val = argv[++i];
    if (val === undefined) throw new Error(`参数 --${a} 缺少取值`);
    if (list.has(a)) o[a] = val.split(',').map((s) => s.trim()).filter(Boolean);
    else if (nums.has(a)) { o[a] = Number(val); if (!Number.isFinite(o[a])) throw new Error(`--${a} 需要数字`); }
    else if (strs[a]) o[strs[a]] = path.resolve(val);
    else throw new Error(`未知参数: --${a}`);
  }
  if (o.style) for (const s of o.style) if (!STYLES.includes(s)) throw new Error(`未知风格 ${s}(可选 ${STYLES.join('/')})`);
  if (o.theme) for (const s of o.theme) if (!THEMES.includes(s)) throw new Error(`未知明暗 ${s}(可选 ${THEMES.join('/')})`);
  o.root = path.resolve(o.root);
  return o;
}

function discoverPages(root) {
  const out = [];
  for (const f of fs.readdirSync(root).sort()) {
    if (!f.toLowerCase().endsWith('.html')) continue;
    const fp = path.join(root, f);
    if (!fs.statSync(fp).isFile()) continue;
    const src = fs.readFileSync(fp, 'utf8');
    const m = /initAntiFOUC\(\s*(['"])([\w-]+)\1\s*\)/.exec(src);
    out.push({ file: f, id: m ? m[2] : f.replace(/\.html?$/i, ''), declared: !!m });
  }
  return out;
}
function loadStates(pageId, opts) {
  if (opts.noStates) return [];
  const fp = path.join(opts.statesDir, pageId + '.json');
  if (!fs.existsSync(fp)) return [];
  let j;
  try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { throw new Error(`状态文件 ${fp} 不是合法 JSON: ${e.message}`); }
  const states = (j && j.states) || [];
  for (const s of states) if (!s.name || !Array.isArray(s.steps)) throw new Error(`状态文件 ${fp} 格式错误:每个状态需要 name 与 steps[]`);
  return opts.state ? states.filter((s) => opts.state.includes(s.name)) : states;
}

/* =============================================================================================
 * 单任务:一个 (页面, 风格, 明暗, 状态)
 * ============================================================================================= */
const pageSrc = `(function(){ ${MATH_SRC}\n window.__lt = (${pageSide.toString()})(__CFG__); })();`;
const safeName = (s) => String(s).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_');

async function evalJS(s, expression, awaitPromise = true) {
  const r = await s.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面脚本异常: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
  }
  return r.result.value;
}
const PERF = { shot: 0, decode: 0, step: 0, n: 0 };
async function shot(s) {
  const t = Date.now();
  const r = await s.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
  const t1 = Date.now();
  const img = decodePNG(Buffer.from(r.data, 'base64'));
  PERF.shot += t1 - t; PERF.decode += Date.now() - t1; PERF.n++;
  return img;
}

/* 局部截图:x/y 为视口坐标;返回的图像坐标系以 (x0,y0) 为原点 */
async function shotClip(s, scroll, x0, y0, w, h) {
  const r = await s.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip: { x: x0 + scroll[0], y: y0 + scroll[1], width: w, height: h, scale: 1 } });
  return decodePNG(Buffer.from(r.data, 'base64'));
}
function sampleGrid(rects, img, maxLines = 6) {
  const pts = [];
  const n = rects.length;
  const idxs = n <= maxLines ? [...Array(n).keys()] : Array.from({ length: maxLines }, (_, k) => Math.round(k * (n - 1) / (maxLines - 1)));
  for (const k of idxs) {
    const [l, t, r, b] = rects[k];
    const w = r - l, h = b - t;
    const cols = Math.max(2, Math.min(10, Math.ceil(w / 12)));
    const rows = h >= 14 ? 3 : 2;
    for (let ri = 0; ri < rows; ri++) {
      const y = t + h * (rows === 3 ? [0.25, 0.5, 0.75][ri] : [0.3, 0.7][ri]);
      for (let ci = 0; ci < cols; ci++) {
        const x = l + 0.5 + (w - 1) * (ci / (cols - 1));
        const px = Math.floor(x), py = Math.floor(y);
        if (img.inside(px, py)) pts.push([px, py]);
      }
    }
  }
  return pts;
}
/* 控件 / 卡片边界:沿四条边中点的法线取剖面,取"相对外侧参考像素"的最强对比度 */
function boundaryContrast(img, box, bw) {
  const L = Math.floor(box[0]), T = Math.floor(box[1]), R = Math.ceil(box[2]), B = Math.ceil(box[3]);
  const cx = Math.round((L + R) / 2), cy = Math.round((T + B) / 2);
  const sides = [
    { n: 'top', at: (d) => [cx, T + d], bw: bw[0] }, { n: 'right', at: (d) => [R - 1 - d, cy], bw: bw[1] },
    { n: 'bottom', at: (d) => [cx, B - 1 - d], bw: bw[2] }, { n: 'left', at: (d) => [L + d, cy], bw: bw[3] }
  ];
  let best = null;
  for (const sd of sides) {
    const rp = sd.at(-6);
    if (!img.inside(rp[0], rp[1])) continue;
    const ref = img.px(rp[0], rp[1]);
    const dmax = Math.max(1, Math.ceil(sd.bw)) + 3;
    for (let d = -3; d <= dmax; d++) {
      const p = sd.at(d);
      if (!img.inside(p[0], p[1])) continue;
      const c = img.px(p[0], p[1]);
      const ratio = lt_contrast(c, ref);
      if (!best || ratio > best.ratio) best = { ratio, cand: c, ref, side: sd.n, d };
    }
  }
  return best;
}
function svgBgPoints(box, img) {
  const [l, t, r, b] = box.map((v, i) => (i < 2 ? Math.floor(v) : Math.ceil(v)));
  const ins = 2, mx = Math.round((l + r) / 2), my = Math.round((t + b) / 2);
  return [[l + ins, t + ins], [r - 1 - ins, t + ins], [l + ins, b - 1 - ins], [r - 1 - ins, b - 1 - ins], [mx, t + ins], [mx, b - 1 - ins], [l + ins, my], [r - 1 - ins, my]].filter((p) => img.inside(p[0], p[1]));
}

async function runJob(browser, job, opts, server) {
  const t0 = Date.now();
  const rec = {
    page: job.page.id, file: job.page.file, style: job.style, theme: job.theme, state: job.state ? job.state.name : null,
    ok: true, error: null, violations: [], manual: [], advisory: { cards: [], svgThin: [] }, info: {}, measurements: [], console: null, ms: 0
  };
  const root = browser.root;
  let ctxId = null, targetId = null;
  const cons = { errors: [], warnings: [], exceptions: [], blockedExternal: 0, nErrors: 0, nWarnings: 0, nExceptions: 0 };
  try {
    ctxId = (await root.send('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
    targetId = (await root.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxId })).targetId;
    const sid = (await root.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const s = browser.cdp.session(sid);
    const addMsg = (kind, text) => {
      if (/ERR_NAME_NOT_RESOLVED|ERR_BLOCKED_BY_CLIENT|ERR_INTERNET_DISCONNECTED/.test(text)) { cons.blockedExternal++; return; }
      const n = kind === 'e' ? 'errors' : kind === 'w' ? 'warnings' : 'exceptions';
      cons['n' + n[0].toUpperCase() + n.slice(1)]++;
      if (cons[n].length < 6) cons[n].push(text.slice(0, 240));
    };
    s.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'warning' && p.type !== 'assert') return;
      addMsg(p.type === 'warning' ? 'w' : 'e', (p.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    });
    s.on('Runtime.exceptionThrown', (p) => addMsg('x', (p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text || 'exception'));
    s.on('Log.entryAdded', (p) => { const e = p.entry; if (e.level === 'error' || e.level === 'warning') addMsg(e.level === 'warning' ? 'w' : 'e', `[${e.source}] ${e.text}${e.url ? ' ' + e.url : ''}`); });
    await Promise.all([s.send('Page.enable'), s.send('Runtime.enable'), s.send('Log.enable')]);
    await s.send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: 1, mobile: false, screenWidth: opts.width, screenHeight: opts.height });
    await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: job.theme }] });
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_JS(job.style, job.theme) });

    /* ---- 导航与稳定期 ---- */
    const url = `http://127.0.0.1:${server.port}/${encodeURI(job.page.file)}`;
    const loaded = s.waitFor('Page.loadEventFired', opts.timeout).then(() => true, () => false);
    const nav = await s.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`页面加载失败: ${nav.errorText}`);
    if (!(await loaded)) {
      const rs = await evalJS(s, 'document.readyState', false).catch(() => 'unknown');
      if (rs === 'loading' || rs === 'unknown') throw new Error(`页面加载超时(${opts.timeout}ms, readyState=${rs})`);
      rec.info.loadTimeout = true;
    }
    rec.info.settleMs = await evalJS(s, SETTLE_JS(opts.settle, Math.max(opts.settle * 6, 3000)));

    /* ---- 属性探针 ---- */
    const attrs = await evalJS(s, 'JSON.stringify({theme: document.documentElement.getAttribute("data-theme"), style: document.documentElement.getAttribute("data-style")})').then(JSON.parse);
    rec.info.attrs = attrs;
    if (opts.verifyAttrs && (attrs.theme !== job.theme || attrs.style !== job.style)) {
      throw new Error(`data 属性与预期不符: 期望 data-theme=${job.theme} data-style=${job.style},实际 data-theme=${attrs.theme} data-style=${attrs.style}`);
    }

    /* ---- 状态步骤 ---- */
    if (job.state) {
      let i = 0;
      for (const st of job.state.steps) {
        i++;
        const where = `状态「${job.state.name}」第 ${i} 步 ${JSON.stringify(st)}`;
        try {
          if (st.click !== undefined) {
            const ok = await evalJS(s, `(() => { const e = document.querySelector(${JSON.stringify(st.click)}); if (!e) return false; e.click(); return true; })()`);
            if (!ok) throw new Error('选择器未命中');
          } else if (st.eval !== undefined) await evalJS(s, `(async () => { ${st.eval.includes('return') || /;\s*\S/.test(st.eval) ? st.eval : 'return (' + st.eval + ')'} \n})()`);
          else if (st.wait !== undefined) await sleep(Number(st.wait));
          else if (st.scrollTo !== undefined) {
            const ok = await evalJS(s, `(() => { const e = document.querySelector(${JSON.stringify(st.scrollTo)}); if (!e) return false; e.scrollIntoView({block:'center', inline:'center', behavior:'instant'}); return true; })()`);
            if (!ok) throw new Error('选择器未命中');
          } else if (st.type !== undefined) {
            const ok = await evalJS(s, `(() => { const e = document.querySelector(${JSON.stringify(st.type.selector)}); if (!e) return false; e.focus(); if ('value' in e) { e.select && e.select(); } return true; })()`);
            if (!ok) throw new Error('选择器未命中');
            await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
            await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
            await s.send('Input.insertText', { text: String(st.type.text) });
          } else throw new Error('未知步骤(支持 click / eval / wait / scrollTo / type)');
        } catch (e) { throw new Error(`${where} 失败: ${e.message}`); }
        await sleep(60);
      }
      rec.info.settleMs2 = await evalJS(s, SETTLE_JS(Math.min(opts.settle, 300), 2500));
    }

    /* ---- 整页截图(真实渲染) ---- */
    if (opts.shots) {
      try {
        const lm = await s.send('Page.getLayoutMetrics');
        const cs = lm.cssContentSize || lm.contentSize;
        const h = Math.max(opts.height, Math.min(Math.ceil(cs.height), 16000));
        const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: opts.width, height: h, scale: 1 } });
        fs.mkdirSync(opts.shots, { recursive: true });
        const fn = `${safeName(job.page.id)}__${job.style}__${job.theme}${job.state ? '__' + safeName(job.state.name) : ''}.png`;
        fs.writeFileSync(path.join(opts.shots, fn), Buffer.from(r.data, 'base64'));
        rec.info.shot = fn;
      } catch (e) { rec.info.shotError = e.message; }
    }

    /* ---- 采集 ---- */
    const tm = { load: Date.now() - t0 };
    /* 内联脚本里有 IntersectionObserver / scroll 监听 => 先沿页面慢速滚一遍,触发"滚动入场"类内容,再回顶部采集 */
    if (opts.warmup) {
      const need = await evalJS(s, `Array.from(document.scripts).some((x) => !x.src && /IntersectionObserver|addEventListener\\(\\s*['"]scroll['"]|onscroll/.test(x.textContent))`, false);
      if (need) {
        rec.info.warmup = await evalJS(s, `(async () => {
          const vh = innerHeight, h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
          const step = Math.max(vh * 0.9, h / 30);
          let n = 0;
          for (let y = 0; y < h; y += step) { window.scrollTo(0, y); n++; await new Promise((r) => setTimeout(r, 45)); }
          window.scrollTo(0, 0);
          await new Promise((r) => setTimeout(r, 150));
          return n;
        })()`);
      }
    }
    let tmark = Date.now();
    await evalJS(s, pageSrc.replace('__CFG__', JSON.stringify({ forcePixel: opts.pixelAll, debug: !!process.env.LT_DEBUG, thin: opts.thin })), false);
    const col = await evalJS(s, '__lt.collect()', false);
    rec.info.collected = col;
    await evalJS(s, '__lt.enterTransparent()', false);
    tm.collect = Date.now() - tmark; tmark = Date.now();

    /* ---- 像素阶段 ---- */
    const px = new Map();     // entry id -> 聚合结果
    let iters = 0, shots = 0;
    const MAXIT = 800;
    while (iters++ < MAXIT) {
      const ts = Date.now();
      const r = await evalJS(s, '__lt.step()', false);
      PERF.step += Date.now() - ts;
      if (r.done) break;
      if (process.env.LT_DEBUG) console.error('  step', iters, 'items', r.items.length, 'left', r.left, JSON.stringify(r.dbg));
      if (!r.items.length) continue;
      await evalJS(s, 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', true);   // 等两帧:嵌套滚动容器刚被程序化滚动后立即截图可能拿到旧帧(几何与像素错位)
      const img = await shot(s);
      shots++;
      for (const it of r.items) {
        let cur = px.get(it.id);
        if (!cur) { cur = { id: it.id, obscured: false, samples: 0 }; px.set(it.id, cur); }
        if (it.obscured) cur.obscured = true;
        if (it.kind === 'control' || it.kind === 'card') {
          const bc = boundaryContrast(img, it.box, it.bw);
          if (bc && (!cur.bc || bc.ratio > cur.bc.ratio)) cur.bc = bc;
        } else if (it.kind === 'svg') {
          cur.bgs = cur.bgs || [];
          for (const p of svgBgPoints(it.box, img)) cur.bgs.push(img.px(p[0], p[1]));
        } else {
          cur.rects = (cur.rects || []);
          cur.pts = (cur.pts || []).concat(sampleGrid(it.rects, img).map((p) => img.px(p[0], p[1])));
        }
      }
    }
    tm.pixel = Date.now() - tmark; tmark = Date.now();
    if (process.env.LT_DEBUG) console.error('  perf', JSON.stringify(PERF));
    rec.info.pixelPasses = shots;
    if (iters > MAXIT) rec.info.pixelPassCapHit = true;

    /* ---- 焦点环 ---- */
    const focusRes = [];
    if (!job.state && opts.focus > 0) {
      await evalJS(s, '__lt.focusReset()', false);
      let lastKey = null;
      const tab = async () => {
        await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      };
      for (let k = 0; k < opts.focus; k++) {
        await tab();
        await sleep(40);
        const a = await evalJS(s, '__lt.activeInfo()', false);
        if (!a) break;
        if (a.key === lastKey) break;
        lastKey = a.key;
        if (!a.visible) { focusRes.push({ sel: a.sel, tag: a.tag, skipped: 'invisible' }); continue; }
        const [bl, bt, br, bb] = a.box;
        const x0 = Math.max(0, Math.floor(bl - 18)), y0 = Math.max(0, Math.floor(bt - 18));
        const x1 = Math.min(opts.width, Math.ceil(br + 18)), y1 = Math.min(opts.height, Math.ceil(bb + 18));
        if (x1 - x0 < 2 || y1 - y0 < 2) { focusRes.push({ sel: a.sel, tag: a.tag, skipped: 'offscreen' }); continue; }
        const img1 = await shotClip(s, a.scroll, x0, y0, x1 - x0, y1 - y0);
        await evalJS(s, '__lt.blurActive()', false);
        await sleep(30);
        const img0 = await shotClip(s, a.scroll, x0, y0, x1 - x0, y1 - y0);
        if (process.env.LT_DEBUG) { const full = await shot(s); let bad = 0; for (let y = 0; y < img0.h; y++) for (let x = 0; x < img0.w; x++) { const p = img0.px(x, y), q = full.px(x0 + x, y0 + y); if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2]) bad++; } console.error('  clip-check', a.sel, 'size', img0.w + 'x' + img0.h, 'mismatch', bad, 'scroll', a.scroll); }
        if (process.env.LT_DEBUG_DIR) { fs.mkdirSync(process.env.LT_DEBUG_DIR, { recursive: true }); for (const [n, im] of [['on', img1], ['off', img0]]) fs.writeFileSync(path.join(process.env.LT_DEBUG_DIR, `focus-${k}-${n}.rgb`), im.data); }
        let best = 1, changed = 0, bestPair = null;
        for (let y = 0; y < img1.h; y++) for (let x = 0; x < img1.w; x++) {
          const p1 = img1.px(x, y), p0 = img0.px(x, y);
          if (Math.abs(p1[0] - p0[0]) + Math.abs(p1[1] - p0[1]) + Math.abs(p1[2] - p0[2]) <= 6) continue;
          changed++;
          const c = lt_contrast(p1, p0);
          if (c > best) { best = c; bestPair = [p1, p0]; }
        }
        focusRes.push({ sel: a.sel, tag: a.tag, ratio: best, changed, pair: bestPair, outline: a.outline, shadow: a.shadow, box: a.box });
      }
      await evalJS(s, '__lt.focusReset()', false);
    }

    tm.focus = Date.now() - tmark; tmark = Date.now();
    /* ---- 导出并分类 ---- */
    const dump = await evalJS(s, '__lt.dump()', false);
    rec.info.regions = await evalJS(s, '__lt.regions()', false);
    const sels = {};
    const need = new Set();
    const addNeed = () => {};   // 选择器只为违规/复核/advisory 条目按需生成(全量生成在 24 万像素高的页面上要数秒)

    const trunc = (t) => { const a = [...t]; return a.length > 20 ? a.slice(0, 20).join('') + '…' : t; };
    const items = [];       // 待分类的结果
    for (const d of dump) {
      if (d.so) continue;
      if (d.kind === 'text' || d.kind === 'svgtext' || d.kind === 'value' || d.kind === 'placeholder') {
        if (d.dis) { (rec.info.disabled = rec.info.disabled || []).push({ text: trunc(d.text) }); continue; }
        let ratio = null, bg = null, fg = null, how = null, obscured = false;
        const manual = d.manual.slice();
        if (d.an) { ratio = d.an.ratio; bg = d.an.bg; fg = d.an.fg; how = 'analytic'; }
        else if (d.why) {
          const p = px.get(d.id);
          if (p && p.pts && p.pts.length) {
            const a = d.fgA, F = d.fg;
            let worst = null;
            for (const b of p.pts) {
              const f = lt_round([F[0] * a + b[0] * (1 - a), F[1] * a + b[1] * (1 - a), F[2] * a + b[2] * (1 - a)]);
              const r = lt_contrast(f, b);
              if (!worst || r < worst.r) worst = { r, b, f };
            }
            ratio = worst.r; bg = worst.b; fg = worst.f; how = 'pixel:' + d.why;
            obscured = p.obscured;
          } else { rec.info.unsampled = (rec.info.unsampled || 0) + 1; continue; }
        } else if (!d.manual.length) continue;
        if (obscured) manual.push('obscured');
        if (d.manual.includes('gradient-text')) { ratio = d.est && d.est.min !== undefined ? d.est.min : null; bg = d.est && d.est.bg || null; fg = d.fg; how = 'gradient-estimate'; }
        if (d.outline && ratio !== null && ratio < d.req && !manual.includes('text-shadow')) manual.push('text-shadow');
        items.push({ d, kind: d.kind, ratio, bg, fg, required: d.req, manual, how });
        addNeed(d);
      } else if (d.kind === 'control') {
        if (d.dis) { (rec.info.disabled = rec.info.disabled || []).push({ text: `<${d.tag}>` }); continue; }
        if (d.noBoundary) { items.push({ d, kind: 'control', ratio: 1, required: 3, note: '无边框、无底色、无描边环', manual: [], how: 'static' }); addNeed(d); continue; }
        const p = px.get(d.id);
        if (!p || !p.bc) { rec.info.unsampled = (rec.info.unsampled || 0) + 1; continue; }
        items.push({ d, kind: 'control', ratio: p.bc.ratio, fg: p.bc.cand, bg: p.bc.ref, required: 3, note: `边:${p.bc.side}`, manual: p.obscured ? ['obscured'] : [], how: 'pixel' });
        addNeed(d);
      } else if (d.kind === 'card') {
        const p = px.get(d.id);
        if (!p || !p.bc) continue;
        items.push({ d, kind: 'card', ratio: p.bc.ratio, fg: p.bc.cand, bg: p.bc.ref, required: 3, manual: [], how: 'pixel' });
        addNeed(d);
      } else if (d.kind === 'svg') {
        const p = px.get(d.id);
        const bgs = d.bgAn ? [d.bgAn] : (p && p.bgs) || [];
        if (!bgs.length) { rec.info.unsampled = (rec.info.unsampled || 0) + 1; continue; }
        for (const g of d.groups) {
          let bestPaint = null;
          for (const pt of g.paints) {
            let worst = null;
            for (const b of bgs) {
              const a = pt.col[3];
              const f = lt_round([pt.col[0] * a + b[0] * (1 - a), pt.col[1] * a + b[1] * (1 - a), pt.col[2] * a + b[2] * (1 - a)]);
              const r = lt_contrast(f, b);
              if (!worst || r < worst.r) worst = { r, f, b };
            }
            if (!bestPaint || worst.r > bestPaint.r) bestPaint = Object.assign({ type: pt.type }, worst);
          }
          items.push({ d, kind: g.key ? 'svg' : 'svg-thin', ratio: bestPaint.r, fg: bestPaint.f, bg: bestPaint.b, required: 3, note: `${bestPaint.type} x${g.n}`, manual: [], gi: g.gi, how: d.bgAn ? 'analytic' : 'pixel' });
          addNeed(d);
        }
      }
    }
    for (const it of items) if (opts.includePass || it.manual.length || it.ratio === null || it.ratio < it.required - 1e-9) need.add(it.d.id);
    const sel = need.size ? await evalJS(s, `__lt.sel(${JSON.stringify([...need])})`, false) : {};

    const pos = (d) => `${d.bb0[0]},${d.bb0[1]}`;
    const seen = new Map();
    for (const it of items) {
      const d = it.d;
      const selector = it.kind === 'svg' || it.kind === 'svg-thin' ? (sel[d.id + ':g'] || [])[it.gi] || sel[d.id] : sel[d.id];
      const base = {
        kind: it.kind, selector, text: it.kind === 'control' || it.kind === 'card' ? (it.kind === 'card' ? (d.sig.replace(/[.]$/, '') || '<card>') : `<${d.tag}>`) : trunc(d.text || ''),
        fg: it.fg ? hex(it.fg) : null, bg: it.bg ? hex(it.bg) : null, ratio: it.ratio === null ? null : Math.round(it.ratio * 100) / 100, ratioRaw: it.ratio,
        required: it.required, at: pos(d), how: it.how, note: it.note || ''
      };
      if (opts.includePass) rec.measurements.push(Object.assign({}, base, { manual: it.manual, fs: d.fs, bold: d.bold }));
      const fail = it.ratio !== null && it.ratio < it.required - 1e-9;
      if (it.kind === 'card') { if (fail) rec.advisory.cards.push(base); continue; }
      if (it.kind === 'svg-thin') { if (fail) rec.advisory.svgThin.push(base); continue; }
      if (it.manual.length) {
        const mk = `${selector}|${it.manual.join('+')}`;
        if (seen.has(mk)) { seen.get(mk).n++; continue; }
        const m = Object.assign({}, base, { reasons: it.manual, n: 1, est: d.est || null, media: d.media ? (sel[d.id + ':m'] || d.media) : null });
        seen.set(mk, m);
        rec.manual.push(m);
        continue;
      }
      if (!fail && !(it.ratio === null)) continue;
      const vk = `${it.kind}|${(selector || '').replace(/:nth-(?:child|of-type)\(\d+\)/g, '').replace(/#([A-Za-z_-]+)\d+/g, '#$1*')}|${base.fg}|${base.bg}|${it.required}`;
      if (seen.has(vk)) { const pv = seen.get(vk); pv.n++; if (pv.examples.length < 3) pv.examples.push(selector); continue; }
      const v = Object.assign({}, base, { n: 1, examples: [selector] });
      seen.set(vk, v);
      rec.violations.push(v);
    }
    /* 焦点 */
    for (const f of focusRes) {
      if (f.skipped) continue;
      const fail = f.ratio < 3 - 1e-9;
      const base = { kind: 'focus', selector: f.sel, text: `<${f.tag}>`, fg: f.pair ? hex(f.pair[0]) : null, bg: f.pair ? hex(f.pair[1]) : null, ratio: Math.round(f.ratio * 100) / 100, ratioRaw: f.ratio, required: 3, at: `${Math.round(f.box[0])},${Math.round(f.box[1])}`, how: 'pixel-diff', note: f.changed ? `变化像素 ${f.changed}` : '聚焦前后无任何像素变化' };
      if (opts.includePass) rec.measurements.push(base);
      if (fail) rec.violations.push(Object.assign(base, { n: 1 }));
    }
    rec.info.focusChecked = focusRes.filter((f) => !f.skipped).length;
    tm.classify = Date.now() - tmark;
    rec.info.timing = tm;
    rec.info.stats = col.stats;
    rec.info.entries = dump.length;
    rec.info.analytic = dump.filter((d) => d.an).length;
    rec.info.pixel = dump.filter((d) => d.why).length;
    rec.info.pixelWhy = {};
    for (const d of dump) if (d.why) rec.info.pixelWhy[d.kind + ':' + d.why] = (rec.info.pixelWhy[d.kind + ':' + d.why] || 0) + 1;
  } catch (e) {
    rec.ok = false;
    rec.error = e.message;
  } finally {
    rec.console = cons;
    rec.ms = Date.now() - t0;
    try { if (targetId) await root.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ }
    try { if (ctxId) await root.send('Target.disposeBrowserContext', { browserContextId: ctxId }); } catch (e) { /* ignore */ }
  }
  return rec;
}

/* =============================================================================================
 * 输出
 * ============================================================================================= */
function fmtViolation(r, v) {
  const st = r.state ? r.state : '-';
  const cols = [r.page, r.style, r.theme, st, v.selector || '?', `"${v.text}"`, `fg ${v.fg || '-'}`, `bg ${v.bg || '-'}`,
    v.ratio === null ? 'n/a' : `${v.ratio.toFixed(2)}:1`, `要求 ${v.required}:1`];
  let line = cols.join(' | ');
  const extra = [v.kind !== 'text' ? v.kind : null, v.n > 1 ? `x${v.n}` : null, v.note || null].filter(Boolean);
  if (extra.length) line += ` | ${extra.join(' ')}`;
  return line;
}
function printReport(records, opts, meta) {
  const out = [];
  const byPage = new Map();
  for (const r of records) { if (!byPage.has(r.page)) byPage.set(r.page, []); byPage.get(r.page).push(r); }
  out.push('页面 | 风格 | 明暗 | 状态 | 选择器 | 文本 | 前景 | 背景 | 实测 | 要求');
  for (const [page, recs] of byPage) {
    out.push('', `=== ${page} ===`);
    for (const r of recs) {
      if (!r.ok) { out.push(`  [ERROR] ${r.page} | ${r.style} | ${r.theme} | ${r.state || '-'} | ${r.error}`); continue; }
      for (const v of r.violations) out.push('  ' + fmtViolation(r, v));
      if (opts.console && r.console) {
        const c = r.console;
        if (c.nErrors || c.nWarnings || c.nExceptions) {
          out.push(`  [console] ${r.page}/${r.style}/${r.theme}${r.state ? '/' + r.state : ''}: error ${c.nErrors} warning ${c.nWarnings} exception ${c.nExceptions}`);
          for (const m of [...c.errors, ...c.exceptions, ...c.warnings].slice(0, 6)) out.push(`      ${m}`);
        }
      }
    }
  }
  /* 汇总矩阵 */
  const cols = [];
  for (const st of STYLES) for (const th of THEMES) if ((!opts.style || opts.style.includes(st)) && (!opts.theme || opts.theme.includes(th))) cols.push([st, th]);
  const pad = (s, n) => String(s).padEnd(n);
  out.push('', '=== 汇总矩阵(违规数;nE = 其中 n 个任务失败;含额外状态审计) ===');
  const nameW = Math.max(8, ...[...byPage.keys()].map((k) => k.length));
  out.push(pad('', nameW) + ' ' + cols.map(([s, t]) => pad(`${s.slice(0, 4)}/${t === 'dark' ? 'D' : 'L'}`, 8)).join(''));
  const totals = { viol: 0, manual: 0, cards: 0, svgThin: 0, err: 0 };
  for (const [page, recs] of byPage) {
    const cells = cols.map(([s, t]) => {
      const rs = recs.filter((r) => r.style === s && r.theme === t);
      if (!rs.length) return pad('-', 8);
      const nerr = rs.filter((r) => !r.ok).length;
      const nv = rs.reduce((a, r) => a + (r.ok ? r.violations.length : 0), 0);
      return pad(nerr ? `${nv}+E${nerr}` : nv, 8);
    });
    out.push(pad(page, nameW) + ' ' + cells.join(''));
  }
  for (const r of records) {
    if (!r.ok) totals.err++;
    else { totals.viol += r.violations.length; totals.manual += r.manual.length; totals.cards += r.advisory.cards.length; totals.svgThin += r.advisory.svgThin.length; }
  }
  out.push(`  违规条目合计 ${totals.viol}(同选择器同色对已合并)  任务失败 ${totals.err}`);
  /* 人工复核 */
  out.push('', `=== 需人工复核(${totals.manual}) ===`);
  for (const r of records) {
    if (!r.ok) continue;
    for (const m of r.manual) {
      const est = m.est && m.est.min !== undefined ? ` 渐变色标最差估算 ${m.est.min.toFixed(2)}:1` : (m.est && m.est.note ? ` ${m.est.note}` : '');
      out.push(`  ${r.page} | ${r.style} | ${r.theme} | ${r.state || '-'} | ${m.selector} | "${m.text}" | 坐标 ${m.at} | ${m.ratio !== null ? m.ratio.toFixed(2) + ':1' : 'n/a'} 要求 ${m.required}:1 | ${m.reasons.join('+')}${m.media ? ' (' + m.media + ')' : ''}${est}${m.n > 1 ? ' x' + m.n : ''}`);
    }
  }
  /* advisory / info */
  out.push('', '=== advisory(不计失败) ===');
  out.push(`  卡片/面板边界 < 3:1 的版型数(按 tag+class 去重): ${totals.cards}    SVG 细线/网格 < 3:1 的组数: ${totals.svgThin}`);
  const cardByPage = new Map();
  for (const r of records) if (r.ok && r.advisory.cards.length) { const k = `${r.page}/${r.style}/${r.theme}`; cardByPage.set(k, r.advisory.cards.length); }
  if (cardByPage.size) out.push('  ' + [...cardByPage].slice(0, 12).map(([k, n]) => `${k}:${n}`).join('  ') + (cardByPage.size > 12 ? ' ...' : ''));
  const dis = new Map();
  for (const r of records) if (r.ok && r.info.disabled) for (const d of r.info.disabled) dis.set(`${r.page}: ${d.text}`, 1);
  if (dis.size) out.push(`  已豁免的 disabled 控件/文字: ${[...dis.keys()].slice(0, 10).join('; ')}${dis.size > 10 ? ' ...' : ''}`);
  const regs = new Map();
  for (const r of records) if (r.ok && r.info.regions) for (const g of r.info.regions) regs.set(`${r.page} ${g.tag} ${g.sel} @${g.x},${g.y} ${g.w}x${g.h}`, 1);
  if (regs.size) { out.push(`  canvas/video/iframe 区域(内部文字无法静态审计,需人工看图):`); for (const k of [...regs.keys()].slice(0, 12)) out.push('    ' + k); }
  if (opts.console) {
    const tot = records.reduce((a, r) => { if (r.ok && r.console) { a.e += r.console.nErrors; a.w += r.console.nWarnings; a.x += r.console.nExceptions; a.b += r.console.blockedExternal; } return a; }, { e: 0, w: 0, x: 0, b: 0 });
    out.push('', `=== 控制台(不计入对比度违规) === error ${tot.e}  warning ${tot.w}  未捕获异常 ${tot.x}  被屏蔽的外部请求 ${tot.b}`);
  }
  out.push('', `组合/任务 ${records.length}  耗时 ${(meta.ms / 1000).toFixed(1)}s  root=${meta.root}`);
  return out.join('\n');
}

/* =============================================================================================
 * 主流程
 * ============================================================================================= */
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error('参数错误: ' + e.message); process.exit(2); }
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '')); return; }
  if (!fs.existsSync(opts.root)) { console.error(`root 不存在: ${opts.root}`); process.exit(2); }
  if (!opts.verifyAttrs) console.error('[warn] --no-verify-attrs: 不校验 data-theme/data-style(仅限自测)');

  let pages = discoverPages(opts.root);
  if (opts.page) pages = pages.filter((p) => opts.page.includes(p.id) || opts.page.includes(p.file) || opts.page.includes(p.file.replace(/\.html?$/i, '')));
  if (!pages.length) { console.error('没有匹配的页面'); process.exit(2); }
  const styles = opts.style || STYLES, themes = opts.theme || THEMES;
  const jobs = [];
  try {
    for (const p of pages) for (const st of styles) for (const th of themes) {
      jobs.push({ page: p, style: st, theme: th, state: null });
      for (const state of loadStates(p.id, opts)) jobs.push({ page: p, style: st, theme: th, state });
    }
  } catch (e) { console.error(e.message); process.exit(2); }

  const t0 = Date.now();
  let srv = null, browser = null;
  const shutdown = async () => { try { if (browser) await browser.close(); } catch (e) { /* ignore */ } try { if (srv) srv.server.close(); } catch (e) { /* ignore */ } };
  process.on('SIGINT', async () => { await shutdown(); process.exit(130); });
  try {
    srv = await startServer(opts.root);
    browser = await launchChrome(opts);
  } catch (e) { console.error('启动失败: ' + e.message); await shutdown(); process.exit(2); }

  const records = new Array(jobs.length);
  let next = 0, done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      const hard = opts.timeout + 90000;
      let rec, timer;
      try {
        rec = await Promise.race([runJob(browser, job, opts, srv), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`任务超时(${hard}ms)`)), hard); })]);
        clearTimeout(timer);
      } catch (e) {
        clearTimeout(timer);
        rec = { page: job.page.id, file: job.page.file, style: job.style, theme: job.theme, state: job.state ? job.state.name : null, ok: false, error: e.message, violations: [], manual: [], advisory: { cards: [], svgThin: [] }, info: {}, console: null, ms: hard };
      }
      records[i] = rec;
      done++;
      console.error(`[${done}/${jobs.length}] ${rec.page} ${rec.style}/${rec.theme}${rec.state ? ' [' + rec.state + ']' : ''} ${rec.ok ? `违规 ${rec.violations.length} 复核 ${rec.manual.length} (${(rec.ms / 1000).toFixed(1)}s)` : 'ERROR ' + rec.error}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, jobs.length)) }, worker));
  await shutdown();

  const meta = { ms: Date.now() - t0, root: opts.root };
  const failed = records.filter((r) => !r.ok);
  const nViol = records.reduce((a, r) => a + (r.ok ? r.violations.length : 0), 0);
  const nManual = records.reduce((a, r) => a + (r.ok ? r.manual.length : 0), 0);
  let code = 0;
  if (nViol > 0 || (opts.strict && nManual > 0)) code = 1;
  if (failed.length) code = 2;
  if (opts.json) {
    const matrix = {};
    for (const r of records) { const k = `${r.page}|${r.style}|${r.theme}`; matrix[k] = (matrix[k] || 0) + (r.ok ? r.violations.length : 0); }
    process.stdout.write(JSON.stringify({
      root: opts.root, width: opts.width, height: opts.height, strict: opts.strict, exitCode: code, ms: meta.ms,
      summary: { jobs: records.length, failed: failed.length, violations: nViol, manual: nManual, cards: records.reduce((a, r) => a + r.advisory.cards.length, 0), svgThin: records.reduce((a, r) => a + r.advisory.svgThin.length, 0) },
      matrix, results: records
    }, null, 1) + '\n');
  } else {
    process.stdout.write(printReport(records, opts, meta) + '\n');
  }
  await new Promise((r) => process.stdout.write('', r));
  process.exit(code);
}

main().catch((e) => { console.error('未预期的错误: ' + (e && e.stack || e)); process.exit(2); });
