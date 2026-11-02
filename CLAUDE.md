# life-tools 项目规则（Claude 必读）

## 1. 项目与硬约束
纯静态生活/投资工具集，`main` 分支由 GitHub Pages 直出；根目录每个 `*.html` 是一个独立工具页，样式脚本内联。
- **零构建、零新增第三方依赖**：不新增 npm 包 / CDN / Web 字体（首页既有 Google Fonts 与各页既有 CDN 库保持原样）。`scripts/*.mjs` 仅是开发期工具（Node 22，零依赖），不进入页面运行时。
- 所有文件 **UTF-8（无 BOM）**。不动 `data/`、`scripts/update_etf_data.py`、`.github/workflows/`，不改 ETF 页三层数据加载；业务存储键（`CK_KEY`、`kegelTimer*` 等）与业务逻辑不属于主题改造范围。
- `index.html` 每张工具卡片必须声明 `data-name`（搜索词）与 `data-cat`（既有取值 `life/macro/value/quant/risk`，可空格组合，如 `"value quant"`）。
- 每个页面 `<head>` 内必须有内联 SVG favicon：`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,…">`。

## 2. 新页面主题强制清单
**新增或大改任何页面时，Claude 必须先按本清单同步首页主题，再做业务功能。** 主题 = 明暗（dark/light）× 风格（classic/tech/fresh/paper），首页主控、子页默认跟随、可单页覆盖。契约见 `theme-manager.js` 与 `theme-tokens.css` 的头注释。
1. **head 四行标准接入**：按此顺序、同步加载（禁 async/defer/media/onload 技巧）、位于任何 `<style>` 之前；缺文件时页面不得报错。
```html
<meta name="color-scheme" content="light dark">
<script src="theme-manager.js"></script>
<script>window.LifeToolsTheme && LifeToolsTheme.initAntiFOUC('<pageId>');</script>
<link rel="stylesheet" href="theme-tokens.css">
```
2. **样式只依赖** `<html data-theme="dark|light" data-style="classic|tech|fresh|paper">`，不依赖 class。`classic` = 页面原生配色：深色即页面 `:root`（零视觉回归），浅色写 `html[data-theme="light"]{…}`。
3. **`LT-THEME-MAP` 映射块**（检查脚本靠这个注释识别）：把页面变量别名到共享令牌，必须带回退值。
```css
/* LT-THEME-MAP */
html[data-style]:not([data-style="classic"]) {
  --bg: var(--lt-bg, #0b0f14);          /* 回退值 = 页面原值，theme-tokens.css 缺失时不崩 */
  --text: var(--lt-text, #e2e6ec);
  --muted: var(--lt-text-muted, #8b95a8);
  --accent: var(--lt-accent, #c8a84b);  /* 填充/装饰；文字、链接用 --lt-accent-strong */
}
```
   优先级：该选择器特异性 (0,2,1) 高于页面 `:root` (0,1,0) 与 `html[data-theme="light"]` (0,1,1)，无需 `!important`，写在它们前后均可；不要改成 `:root` 或单个 `html[data-theme]`。页面自有语义色（涨跌红绿、图表系列色）留在页面内，同样要过审计。
4. **挂件**：`<body>` 内调用 `LifeToolsTheme.mountThemeControl('<pageId>', {container: el})`，优先内联进页面自带顶栏，否则 `{position: 'bottom-right'}` 悬浮（另有 bottom-left/top-left/top-right）并避开页面自有悬浮元素；320/390/1280 宽度不遮挡不重叠，触控目标 ≥ 40px。首页 `home` 自带切换器，不得调用。
5. **JS 绘制内容**（ECharts/Canvas/SVG/地图/动态着色）：绘制时用 `getComputedStyle(document.documentElement)` 读 CSS 变量，并 `LifeToolsTheme.onChange(redraw)`（事件 `lifetools:themechange`，`e.detail.theme/style`）重绘，换主题后不得残留旧色。
6. **禁止**页面自建主题/风格存储键（只允许 `lifetools_*`），禁止 `prefers-color-scheme`（CSS、`matchMedia`、`media` 属性）；跟随系统由 theme-manager 的 `auto`/`system` 承担。
7. **`pageId` 命名**：取文件名短 slug（小写字母/数字/连字符，如 `badminton-cost-calculator.html` → `badminton`），全站唯一，`home` 专属 `index.html`。`initAntiFOUC` 与 `mountThemeControl` 的 id 必须一致。
8. **门禁**（4 风格 × 明暗全部通过，违规数为 0；“需人工复核”项逐条看图确认）：
```bash
node scripts/check-theme.mjs                    # 静态规则，全站逐页表格；--page <pageId|文件名>、--json、--root <dir>
node scripts/audit-contrast.mjs --page <pageId> # 对比度审计（无头 Chrome）；另有 --style tech --theme dark、--width 390、--shots <dir>、--console
```
9. **`scripts/audit-states/<pageId>.json`**：声明默认视图之外需要额外审计的交互状态（切标签页、展开弹窗、筛选结果等），由 click/eval/wait/scrollTo/type 步骤组成，每个状态重载页面后回放再审；格式见 `scripts/audit-states/_example.json`。页面有隐藏态时必须补。
10. **同步更新** `index.html` 卡片（见第 1 节）与 `README.md`（工具清单、目录结构、主题接入说明）。

## 3. 提交规范
- 前缀 `[feat]` 新功能 / `[fix]` 修复 / `[chore]` 杂项与数据 / `[docs]` 文档，后接中文简述，例：`[feat] 新增股息再投资计算器并接入全站主题`。
- **不加 AI 署名，不加 `Co-Authored-By`**。仅在用户明确要求时才 commit / push；推送前先 `git fetch` 并 `git pull --rebase origin main`（远端每个交易日自动提交 ETF 数据）。

## 4. 验证配方（Windows + Git Bash，Node 22，无需 npm）
- Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`；通用参数 `--headless=new --disable-gpu --no-first-run --no-default-browser-check`，**每次启动都用独立** `--user-data-dir=D:/tmp/lt-<角色>/profile-<随机>`，用完只结束自己启动的进程。
- 单测页（须全绿）：`chrome <通用参数> --virtual-time-budget=20000 --dump-dom file:///D:/FrontendProjects/life-tools/tests/test-theme-manager.html`，读 `document.title` 或 `#summary`；`tests/test-badminton-algorithm.html` 同法（265/265）。
- 截图：`chrome <通用参数> --window-size=1280,800 --screenshot=D:/tmp/lt-x/a.png file:///D:/FrontendProjects/life-tools/<页面>.html`；窄屏改 `--window-size=390,844`；对比度审计可用 `--shots <dir>`；截图后用 Read 逐张看图。
- CDP：加 `--remote-debugging-port=0`，端口读 `<user-data-dir>/DevToolsActivePort` 首行，用 Node 22 原生 `WebSocket`/`fetch` 连 `http://127.0.0.1:<port>/json`，零依赖。预置主题：先写 `lifetools_global_style/theme` 再加载；系统明暗：`Emulation.setEmulatedMedia`；防闪烁：`Page.addScriptToEvaluateOnNewDocument` + `MutationObserver`。
- 临时脚本、截图、profile 一律放 `D:/tmp/lt-*/`，不进仓库；收工前 `git status` 确认只有预期文件。
