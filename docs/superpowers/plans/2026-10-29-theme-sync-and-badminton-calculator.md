# 全站主题同步体系与羽毛球智能平摊算法升级实现方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建统一且灵活的全站主题同步体系（首页支持跟随系统/手动深浅色，工具页默认跟随首页且支持独立配置），并全面重构羽毛球费用计算器（新增极速纯平摊模式、智能自适应最少转账与点对点直连算法、双主题响应式 UI）。

**Architecture:**
1. **全站主题中间件 (`theme-manager.js`)**：无外部依赖的通用主题引擎。管理全局主题存储 (`lifetools_global_theme`) 与单页独立配置 (`lifetools_page_theme_*`)；支持防白屏闪烁 (Anti-FOUC) 同步初始化、跨标签页实时同步 (`storage` 事件) 与系统主题自动监听 (`prefers-color-scheme`)；向各子页面提供统一的主题选择悬浮挂件。
2. **首页主题控制升级 (`index.html`)**：增加浅色模式语义变量，在页头增加【跟随系统 / 深色 / 浅色】主题切换器，并作为全站主题的主控广播源。
3. **子页面主题自适应 (`badminton-cost-calculator.html` & `frontend-interview-guide.html` 等)**：全量接入 `theme-manager.js`，提供【跟随首页 / 独立浅色 / 独立深色 / 跟随系统】选择能力，并为羽毛球计算器提供完整的 CSS 变量化深浅色双主题样式。
4. **羽毛球算法与交互升级 (`badminton-cost-calculator.html`)**：
   - 模式一（⚡ 快速平摊）：输入总额 + 人数（支持快捷人数芯片），一键计算人均与转账汇总。
   - 模式二（📋 精细分账）：保留空位补齐算法 (`getNextPlayerNumber`)，新增【智能自适应清算路由】引擎——仅 2 人有差额时自动直连互转；多人复杂差额时自动执行贪心最小现金流算法 (Min-Cash-Flow) 压缩转账笔数；同时保留“指定组织者统一收款”星型模型。
   - 社交输出：提供一键复制微信/社群排版账单文本。

**Tech Stack:** 原生 JavaScript (ES6+), CSS Custom Properties (CSS 变量), Web Storage API, matchMedia API, HTML5.

---

## Global Constraints

- 绝不引入庞大的第三方重型库（保持纯静态单页开箱即用，零构建即可直接运行）。
- 主题切换响应必须无延迟，刷新页面绝不能出现浅色/深色白光闪烁（FOUC）。
- 跨页面通信完全基于浏览器标准的 `localStorage` 与 `window.storage` 事件，支持离线运行。
- 羽毛球平摊算法精度保留 2 位小数，金额校验精确到分，严格防止浮点数精度遗漏。

---

### Task 1: 编写全站主题管理核心中间件 (`theme-manager.js`)

**Files:**
- Create: `theme-manager.js`
- Test: `tests/test-theme-manager.html`

**Interfaces:**
- Produces: `window.LifeToolsTheme`
  - `getGlobalTheme(): 'auto' | 'dark' | 'light'`
  - `setGlobalTheme(mode: 'auto' | 'dark' | 'light')`
  - `getPageTheme(pageId: string): 'follow' | 'dark' | 'light' | 'system'`
  - `setPageTheme(pageId: string, mode: 'follow' | 'dark' | 'light' | 'system')`
  - `resolveEffectiveTheme(pageId: string): 'dark' | 'light'`
  - `applyTheme(pageId: string)`
  - `initAntiFOUC(pageId: string)`
  - `mountThemeControl(pageId: string, options?: { container?: HTMLElement, position?: string })`

- [ ] **Step 1: 编写中间件测试页面 `tests/test-theme-manager.html`**

验证主题计算逻辑、系统模式监听以及存储读写。

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Theme Manager Unit Test</title>
</head>
<body>
  <div id="test-results">Running tests...</div>
  <script src="../theme-manager.js"></script>
  <script>
    const results = [];
    function assert(name, condition) {
      results.push(`${condition ? '✅ PASS' : '❌ FAIL'}: ${name}`);
    }

    try {
      // 1. 初始化测试
      LifeToolsTheme.setGlobalTheme('dark');
      assert('setGlobalTheme dark', LifeToolsTheme.getGlobalTheme() === 'dark');

      LifeToolsTheme.setPageTheme('testPage', 'light');
      assert('setPageTheme light', LifeToolsTheme.getPageTheme('testPage') === 'light');
      assert('resolve testPage as light', LifeToolsTheme.resolveEffectiveTheme('testPage') === 'light');

      LifeToolsTheme.setPageTheme('testPage2', 'follow');
      assert('resolve testPage2 follow global dark', LifeToolsTheme.resolveEffectiveTheme('testPage2') === 'dark');

      document.getElementById('test-results').innerHTML = '<pre>' + results.join('\n') + '</pre>';
    } catch (e) {
      document.getElementById('test-results').innerHTML = '<pre>Error: ' + e.message + '</pre>';
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: 编写 `theme-manager.js`**

包含全局存储键常量、主题解析算法、跨标签页监听、系统媒体监听以及统一浮动悬浮挂件 UI（附带现代化微动效与毛玻璃质感）。

- [ ] **Step 3: 打开测试页面验证通过**

运行浏览器或 Headless 检查 `tests/test-theme-manager.html` 验证各断言成功。

- [ ] **Step 4: 提交核心中间件**

```bash
git add theme-manager.js tests/test-theme-manager.html
git commit -m "feat(theme): add global theme-manager middleware and test suite"
```

---

### Task 2: 首页 (`index.html`) 适配浅色主题与全站主题控制广播器

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `LifeToolsTheme`
- Produces: 首页浅色 CSS 变量、顶栏主题控制栏

- [ ] **Step 1: 在 `index.html` 的 `<head>` 注入防闪烁脚本与 `theme-manager.js` 引用**
- [ ] **Step 2: 扩充 `index.html` 的 CSS 变量定义**
  - 新增 `[data-theme="light"]` 配套变量：
    - `--bg: #f7f5ef`（雅致米白底色）
    - `--surface: #ffffff`
    - `--surface2: #f1ede3`
    - `--border: #e3ded2`
    - `--text: #24201a`
    - `--muted: #736c5f`
    - `--gold: #9e7520`
    - 针对搜索框、工具卡片、悬浮效果进行浅色对比度调优，保持设计质感。
- [ ] **Step 3: 在 `index.html` 顶栏/头部添加主题切换器组件**
  - 提供 `💻 自动`、`🌙 深色`、`☀️ 浅色` 三段式快捷切换按钮。
  - 点击时调用 `LifeToolsTheme.setGlobalTheme(mode)`。
  - 自动高亮当前激活状态。
- [ ] **Step 4: 测试首页切换与系统主题联动**
  - 在深色、浅色、自动之间切换，确认卡片阴影、渐变、文字对比度无视觉瑕疵。
- [ ] **Step 5: 提交首页改造**

```bash
git add index.html
git commit -m "feat(home): add light theme tokens and global theme controller in header"
```

---

### Task 3: 羽毛球费用计算器算法引擎升级与单元测试

**Files:**
- Create: `tests/test-badminton-algorithm.html`
- Modify: `badminton-cost-calculator.html` (算法函数抽取)

**Interfaces:**
- Functions:
  - `calculateQuickSplit(totalAmount, playerCount, payerName)`: 返回每人金额、收款人垫付差额、账单明细。
  - `calculateDetailedSplit(players, totalAmountInput, strategy, designatedPayerId)`:
    - `strategy`: `'auto' | 'min_transfer' | 'star'`
    - 返回：`{ perPerson, totalAmount, players: [...], transfers: [...], routeType: 'direct' | 'min_transfer' | 'star', hint: string }`
  - `getNextPlayerNumber(playersList)`: 最小未占用编号补位。

- [ ] **Step 1: 编写算法测试用例 `tests/test-badminton-algorithm.html`**
  - 测试用例 1（快速平摊）：240 元，6 人，每人 40 元。
  - 测试用例 2（智能直连）：6 人，其中 4 人垫付 40 元，A 垫付 0 元，B 垫付 80 元 -> 必须输出 `A 直接转 B 40 元`，无第三方介入！
  - 测试用例 3（最少转账次数）：A 垫 120，B 垫 60，C 垫 0，D 垫 0（人均 45）-> 贪心对冲输出最少笔数。
  - 测试用例 4（指定组织者）：选择 A 为收款人，C 和 D 转给 A，A 退钱给 B。
- [ ] **Step 2: 验证算法实现并在浏览器中通过测试**
- [ ] **Step 3: 提交算法模块**

```bash
git add tests/test-badminton-algorithm.html
git commit -m "test(badminton): add comprehensive unit test for badminton split algorithms"
```

---

### Task 4: 羽毛球费用计算器界面全面重构与双主题适配

**Files:**
- Modify: `badminton-cost-calculator.html`

**Interfaces:**
- Consumes: `theme-manager.js`
- Produces: 
  - 顶部返回首页导航 + 模式切换 Tabs（⚡ 极速平摊 / 📋 精细分账）
  - 极速平摊交互面板（人数快捷标签：2人、4人、6人、8人、10人）
  - 精细分账交互面板（智能清算路由、直观转账流向图、差额表格）
  - 微信账单文案一键复制
  - 完整的全站主题联动与单页自定义主题挂件

- [ ] **Step 1: 接入 `theme-manager.js` 与双主题 CSS 变量重构**
  - 将原页面硬编码颜色（`#f5f5f5`, `#ffffff`, `#2c3e50` 等）重构成 `--bg`, `--surface`, `--text`, `--border`, `--primary`, `--accent`。
  - 编写 `[data-theme="dark"]` 样式，完美融合 LifeTools 暗黑科技风；保留优美明亮的浅色样式。
- [ ] **Step 2: 构建模式切换 UI (Tabs) 与极速平摊面板**
  - 支持快捷选择人数，实时联动计算结果。
- [ ] **Step 3: 构建精细分账面板与智能路由展示**
  - 渲染转账路径卡片：清晰显示 `[转账人] ──( 金额 )──► [收款人]`。
  - 当命中“点对点直连”或“最少转账次数”时展示智能优化提示徽标。
- [ ] **Step 4: 添加一键复制微信通知文案功能**
- [ ] **Step 5: 页面测试验证（深色/浅色、两种模式、各种边界情况）**
- [ ] **Step 6: 提交羽毛球计算器**

```bash
git add badminton-cost-calculator.html
git commit -m "feat(badminton): overhaul UI with dual theme, quick split mode and smart transfer routing"
```

---

### Task 5: 优化面试宝典与其它工具的主题兼容性

**Files:**
- Modify: `frontend-interview-guide.html`
- Modify: `README.md` (更新功能与文档说明)

- [ ] **Step 1: 接入 `theme-manager.js` 到 `frontend-interview-guide.html`**
  - 页面默认跟随首页主题，但用户可在悬浮挂件或主题按钮中自由选择“独立浅色/独立深色”。
  - 满足用户提出的“面试页面不完全适配深色时，可设置独立主题且默认跟随首页”的需求。
- [ ] **Step 2: 更新 `README.md`**
  - 补充全站主题同步机制、羽毛球平摊算法特性的说明。
- [ ] **Step 3: 整体功能联调与最终验证**
  - 首页切深色 -> 打开羽毛球计算器（自动深色）-> 打开面试宝典（跟随或自定义）。
  - 首页切浅色 -> 所有跟随页面实时同步更新。
  - 跨标签页验证：在一个标签页改主题，其他打开的标签页即刻无刷新响应。
- [ ] **Step 4: 提交所有优化**

```bash
git add frontend-interview-guide.html README.md
git commit -m "feat(theme): unify tool themes with per-page overrides and update documentation"
```
