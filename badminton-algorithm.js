/*
 * 羽毛球费用算法引擎(纯函数,零 DOM,零依赖)
 *
 * 浏览器:<script src="badminton-algorithm.js"> 后既有全局函数,也有 window.BadmintonAlgo 命名空间。
 * Node:module.exports。
 *
 * 设计要点:
 * - 金额内部一律用"整数分"运算,对外才转成保留 2 位的 number;任何相等判断都发生在整数上,
 *   从根上避开 0.1 + 0.2 之类的浮点陷阱。
 * - 所有失败都返回 { ok:false, error:'中文提示', code } ,不抛异常,调用方只需判断 ok。
 * - 结果确定:同输入同输出,并列一律按输入顺序处理。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) {
    root.BadmintonAlgo = api;
    Object.keys(api).forEach(function (k) { root[k] = api[k]; });
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEFAULT_TITLE = '🏸 羽毛球费用结算';
  var SEP = '────────────';
  // 单个金额上限(分):10 亿元。超出视为输入有误,同时保证所有求和都落在安全整数内
  var MAX_CENTS = 1e11;
  // 位掩码 DP 的规模上限:2^16 * 16 约百万次运算,毫秒级;再大改用贪心降级
  var DP_LIMIT = 16;
  // 精细分账明细行只在人数不多时输出,避免账单文案过长
  var DETAIL_LINES_LIMIT = 10;

  function fail(error, code, extra) {
    var r = { ok: false, error: error, code: code || 'INVALID' };
    if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
    return r;
  }

  /* ---------------- 金额工具 ---------------- */

  // 宽松解析用户输入:允许千分位逗号、空格、前导 ¥/￥;不接受科学计数法与十六进制
  function parseNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return NaN;
    var s = v.replace(/[,，\s]/g, '').replace(/^[¥￥]/, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  // 金额 -> 整数分,第 3 位小数起"四舍五入(远离 0)"。
  // 走十进制字符串而非 x * 100,否则 1.005 * 100 = 100.49999999999999 会被错误舍掉
  function toCents(value) {
    var n = parseNumber(value);
    if (typeof n !== 'number' || !isFinite(n)) return NaN;
    var neg = n < 0;
    var s = String(Math.abs(n));
    var cents;
    if (/e/i.test(s)) {
      // 极大/极小数的科学计数法写法,退回乘法(这类输入随后会被金额上限拦掉)
      cents = Math.round(Math.abs(n) * 100);
    } else {
      var parts = s.split('.');
      var frac = parts[1] || '';
      cents = parseInt(parts[0] + (frac + '00').slice(0, 2), 10);
      if (frac.length > 2 && frac.charAt(2) >= '5') cents += 1;
    }
    return neg && cents ? -cents : cents;
  }

  function fromCents(cents) {
    return Math.round(cents) / 100;
  }

  // 整数分 -> '40.00',不经过 toFixed,避免借助浮点再引入误差
  function formatMoney(n) {
    var c = toCents(n);
    if (isNaN(c)) return '0.00';
    var neg = c < 0;
    c = Math.abs(c);
    return (neg ? '-' : '') + Math.floor(c / 100) + '.' + ('0' + (c % 100)).slice(-2);
  }

  function fmt(cents) {
    return formatMoney(fromCents(cents));
  }

  /* ---------------- 编号补位 ---------------- */

  // 取最小的未占用正整数,删除中间编号后新增球友会优先补位
  function getNextPlayerNumber(playersList) {
    var used = {};
    if (Array.isArray(playersList)) {
      playersList.forEach(function (item) {
        var raw = item && typeof item === 'object' ? item.id : item;
        var n = NaN;
        if (typeof raw === 'number') {
          n = raw;
        } else if (typeof raw === 'string') {
          var m = /^(?:player)?(\d+)$/i.exec(raw.trim());
          if (m) n = parseInt(m[1], 10);
        }
        if (isFinite(n) && n >= 1 && Math.floor(n) === n) used[n] = true;
      });
    }
    var number = 1;
    while (used[number]) number++;
    return number;
  }

  /* ---------------- 模式一:极速平摊 ---------------- */

  // 收款人先垫付全款,其余 N-1 人每人转 floor(总额/N);零头(最多 N-1 分)由收款人自己承担,总额精确闭合
  function calculateQuickSplit(totalAmount, playerCount, payerName) {
    try {
      var totalNum = parseNumber(totalAmount);
      if (!isFinite(totalNum) || totalNum <= 0) return fail('请输入大于 0 的总费用', 'BAD_TOTAL');
      var totalCents = toCents(totalNum);
      if (!(totalCents > 0)) return fail('总费用不能小于 0.01 元', 'BAD_TOTAL');
      if (totalCents > MAX_CENTS) return fail('总费用数额过大,请核对', 'BAD_TOTAL');

      var cnt = typeof playerCount === 'string' ? parseNumber(playerCount) : playerCount;
      if (typeof cnt !== 'number' || !isFinite(cnt) || Math.floor(cnt) !== cnt || cnt < 1) {
        return fail('人数需为不小于 1 的整数', 'BAD_COUNT');
      }
      if (cnt > 1e6) return fail('人数过多,请核对', 'BAD_COUNT');

      var payer = String(payerName == null ? '' : payerName).trim() || '收款人';
      var baseCents = Math.floor(totalCents / cnt);
      var remainderCents = totalCents - baseCents * cnt;
      var othersCount = cnt - 1;
      var othersCents = baseCents * othersCount;
      var payerShareCents = totalCents - othersCents;

      var lines = [];
      lines.push('总费用 ' + fmt(totalCents) + ' 元,共 ' + cnt + ' 人,人均 ' + fmt(baseCents) + ' 元');
      if (cnt === 1) {
        lines.push('仅 1 人,无需转账,' + payer + ' 承担全部费用');
      } else if (baseCents === 0) {
        lines.push('每人不足 0.01 元,其余 ' + othersCount + ' 人无需转账,由 ' + payer + ' 承担');
      } else {
        lines.push('其余 ' + othersCount + ' 人每人转给 ' + payer + ' ' + fmt(baseCents) + ' 元,合计 ' + fmt(othersCents) + ' 元');
        lines.push(payer + ' 自己承担 ' + fmt(payerShareCents) + ' 元');
      }
      if (remainderCents > 0 && cnt > 1) {
        lines.push(fmt(totalCents) + ' 元不能被 ' + cnt + ' 人整除,多出的 ' + remainderCents + ' 分由 ' + payer + ' 承担');
      }

      return {
        ok: true,
        totalAmount: fromCents(totalCents),
        playerCount: cnt,
        perPerson: fromCents(baseCents),
        payerName: payer,
        payerShare: fromCents(payerShareCents),
        othersCount: othersCount,
        othersTotal: fromCents(othersCents),
        payerAdvance: fromCents(othersCents),
        hasRemainder: remainderCents > 0,
        remainderCents: remainderCents,
        lines: lines
      };
    } catch (e) {
      return fail('计算出错,请检查输入', 'INTERNAL');
    }
  }

  /* ---------------- 模式二:精细分账 ---------------- */

  // 最大欠款者 -> 最大应收者的贪心;并列取输入顺序靠前者。members 为升序下标,bal 为各人净额(分,>0 应付)
  function greedySettle(members, bal, out) {
    var rem = {};
    members.forEach(function (i) { rem[i] = bal[i]; });
    for (;;) {
      var from = -1;
      var to = -1;
      for (var k = 0; k < members.length; k++) {
        var i = members[k];
        if (rem[i] > 0 && (from < 0 || rem[i] > rem[from])) from = i;
        if (rem[i] < 0 && (to < 0 || rem[i] < rem[to])) to = i;
      }
      if (from < 0 || to < 0) break;
      var amt = Math.min(rem[from], -rem[to]);
      out.push({ from: from, to: to, cents: amt });
      rem[from] -= amt;
      rem[to] += amt;
    }
  }

  // 位掩码 DP:把非零净额的人划分为尽可能多个"和为 0"的小组。
  // 转账数 = 人数 - 组数(每组 k 人至少需要 k-1 笔,且恰好 k-1 笔可达),因此这就是真正的最小值。
  function partitionZeroSum(idxs, bal) {
    var n = idxs.length;
    var size = 1 << n;
    var sum = new Float64Array(size);
    var dp = new Int8Array(size);
    var pick = new Int8Array(size);
    var mask, i;
    for (mask = 1; mask < size; mask++) {
      var low = mask & -mask;
      sum[mask] = sum[mask ^ low] + bal[idxs[31 - Math.clz32(low)]];
    }
    for (mask = 1; mask < size; mask++) {
      var best = -1;
      var bestI = 0;
      for (i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          var v = dp[mask ^ (1 << i)];
          if (v > best) { best = v; bestI = i; } // 严格大于:并列取最小下标,保证确定性
        }
      }
      dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
      pick[mask] = bestI;
    }
    // 沿最优选择回溯:每回到一个和为 0 的子集,刚摘下的那批人就构成一个独立小组
    var groups = [];
    var cur = [];
    mask = size - 1;
    while (mask) {
      var p = pick[mask];
      cur.push(idxs[p]);
      mask ^= (1 << p);
      if (sum[mask] === 0) {
        groups.push(cur.sort(function (a, b) { return a - b; }));
        cur = [];
      }
    }
    return groups.sort(function (a, b) { return a[0] - b[0]; });
  }

  // 最少转账路径。返回 [{from,to,cents}],下标均指向原 players 数组
  function minTransferPlan(bal) {
    var nz = [];
    bal.forEach(function (b, i) { if (b !== 0) nz.push(i); });
    var out = [];
    if (nz.length === 0) return out;

    if (nz.length <= DP_LIMIT) {
      partitionZeroSum(nz, bal).forEach(function (g) { greedySettle(g, bal, out); });
      return out;
    }

    // 大规模降级:先把金额恰好相等的"付款人-收款人"精确配对(一笔结清两人),剩余的再贪心
    var rest = {};
    nz.forEach(function (i) { rest[i] = bal[i]; });
    var receivers = nz.filter(function (i) { return bal[i] < 0; });
    nz.filter(function (i) { return bal[i] > 0; }).forEach(function (p) {
      for (var k = 0; k < receivers.length; k++) {
        var r = receivers[k];
        if (rest[r] !== 0 && -rest[r] === rest[p]) {
          out.push({ from: p, to: r, cents: rest[p] });
          rest[p] = 0;
          rest[r] = 0;
          break;
        }
      }
    });
    var left = nz.filter(function (i) { return rest[i] !== 0; });
    var balLeft = bal.slice();
    nz.forEach(function (i) { balLeft[i] = rest[i]; });
    greedySettle(left, balLeft, out);
    return out;
  }

  function calculateDetailedSplit(players, totalAmountInput, strategy, designatedPayerId) {
    try {
      return computeDetailed(players, totalAmountInput, strategy, designatedPayerId);
    } catch (e) {
      return fail('计算出错,请检查输入', 'INTERNAL');
    }
  }

  function computeDetailed(players, totalAmountInput, strategy, designatedPayerId) {
    var mode = strategy == null || strategy === '' ? 'auto' : strategy;
    if (mode !== 'auto' && mode !== 'min_transfer' && mode !== 'star') {
      return fail('未知的清算方式', 'BAD_STRATEGY');
    }
    if (!Array.isArray(players) || players.length === 0) {
      return fail('请至少添加一位球友', 'NO_PLAYERS');
    }

    // ---- 1. 规整球友:以 id 为键,name 可重名 ----
    var seen = {};
    var list = [];
    for (var i = 0; i < players.length; i++) {
      var src = players[i];
      if (!src || typeof src !== 'object' || src.id == null || String(src.id) === '') {
        return fail('第 ' + (i + 1) + ' 位球友缺少编号', 'BAD_PLAYER');
      }
      var key = String(src.id);
      if (seen[key]) return fail('球友编号重复:' + key, 'DUP_ID');
      seen[key] = true;

      var name = String(src.name == null ? '' : src.name).trim();
      // 姓名留空时沿用 playerN 的编号,没有编号就按位置兜底
      if (!name) name = '球友' + ((/^player(\d+)$/i.exec(key) || [0, i + 1])[1]);

      var exp = 0;
      var rawExp = src.expense;
      var hasExp = !(rawExp == null || (typeof rawExp === 'string' && rawExp.trim() === ''));
      if (hasExp) {
        var n = parseNumber(rawExp);
        if (n === Infinity || n === -Infinity) return fail('「' + name + '」的已支出金额无效', 'BAD_EXPENSE');
        if (!isNaN(n)) {
          exp = toCents(n);
          if (exp < 0) return fail('「' + name + '」的已支出金额不能为负数', 'NEG_EXPENSE');
          if (exp > MAX_CENTS) return fail('「' + name + '」的已支出金额过大,请核对', 'BAD_EXPENSE');
        }
      }
      list.push({ id: src.id, key: key, name: name, expense: exp, extra: 0 });
    }
    var count = list.length;
    var sumExpense = list.reduce(function (s, p) { return s + p.expense; }, 0);

    // ---- 2. 总额:无效或 <= 0 视为"自动合计" ----
    var totalCents = 0;
    var useInput = false;
    var inputNum = totalAmountInput == null ? NaN : parseNumber(totalAmountInput);
    if (isFinite(inputNum) && inputNum > 0) {
      var tc = toCents(inputNum);
      if (tc > MAX_CENTS) return fail('总费用数额过大,请核对', 'BAD_TOTAL');
      if (tc > 0) {
        totalCents = tc;
        useInput = true;
      }
    }
    if (!useInput) totalCents = sumExpense;
    if (totalCents <= 0) {
      return fail('请填写总费用,或至少录入一位球友的已支出金额', 'NO_AMOUNT');
    }

    // ---- 3. 指定收款人与差额 ----
    var dIdx = -1;
    if (designatedPayerId != null && designatedPayerId !== '') {
      for (var d = 0; d < count; d++) {
        if (list[d].key === String(designatedPayerId)) { dIdx = d; break; }
      }
    }
    if (mode === 'star' && dIdx < 0) {
      return fail('请选择一位组织者(统一收款人)', 'NEED_PAYER');
    }
    var gapCents = totalCents - sumExpense;
    if (gapCents < 0) {
      return fail('已记录支出(' + fmt(sumExpense) + ' 元)超过总费用(' + fmt(totalCents) + ' 元),请核对', 'EXPENSE_OVER_TOTAL',
        { gap: fromCents(gapCents) });
    }
    if (gapCents > 0) {
      if (dIdx < 0) {
        return fail('总费用比已记录的支出合计多 ' + fmt(gapCents) + ' 元,请指定收款人承担差额或补录支出', 'GAP_NEEDS_PAYER',
          { gap: fromCents(gapCents) });
      }
      list[dIdx].extra = gapCents;
    }

    // ---- 4. 分摊:先按人头整除,余数分依次 +1 分(指定收款人优先,其次支出大者) ----
    var baseCents = Math.floor(totalCents / count);
    var remainderCents = totalCents - baseCents * count;
    var order = list.map(function (p, idx) { return idx; }).filter(function (idx) { return idx !== dIdx; });
    order.sort(function (a, b) { return (list[b].expense - list[a].expense) || (a - b); });
    if (dIdx >= 0) order.unshift(dIdx);
    var share = list.map(function () { return baseCents; });
    for (var r = 0; r < remainderCents; r++) share[order[r]] += 1;

    var bal = list.map(function (p, idx) { return share[idx] - (p.expense + p.extra); });
    var nonzero = bal.filter(function (b) { return b !== 0; }).length;

    // ---- 5. 清算路径 ----
    var plan = [];
    var routeType;
    if (mode === 'star') {
      routeType = 'star';
      list.forEach(function (p, idx) {
        if (idx === dIdx || bal[idx] === 0) return;
        if (bal[idx] > 0) plan.push({ from: idx, to: dIdx, cents: bal[idx] });
        else plan.push({ from: dIdx, to: idx, cents: -bal[idx] });
      });
    } else {
      plan = minTransferPlan(bal);
      routeType = nonzero === 2 ? 'direct' : 'min_transfer';
    }

    // 基线:统一收款需要的笔数。组织者 = 指定收款人,未指定则取应收最多者
    var baseIdx = dIdx;
    if (baseIdx < 0) {
      var most = 0;
      bal.forEach(function (b, idx) { if (b < most) { most = b; baseIdx = idx; } });
    }
    var starCount = nonzero - (baseIdx >= 0 && bal[baseIdx] !== 0 ? 1 : 0);
    var saved = Math.max(0, starCount - plan.length);
    var settled = plan.length === 0;

    // ---- 6. 提示语 ----
    var hint;
    if (settled) {
      hint = '账已结清,大家已垫付的金额恰好等于应摊份额,无需任何转账';
    } else if (routeType === 'star') {
      hint = '统一收款:所有人只与 ' + list[dIdx].name + ' 结算,共 ' + plan.length + ' 笔转账';
    } else if (routeType === 'direct') {
      hint = '命中点对点直连:仅 2 人有差额,' + list[plan[0].from].name + ' 直接转给 ' + list[plan[0].to].name + ',无需第三方中转';
    } else if (saved > 0) {
      hint = '智能压缩:共 ' + plan.length + ' 笔转账,比统一收款少 ' + saved + ' 笔';
    } else {
      hint = '智能清算:共 ' + plan.length + ' 笔转账,已是最少笔数';
    }

    return {
      ok: true,
      totalAmount: fromCents(totalCents),
      perPerson: fromCents(baseCents),
      sumExpense: fromCents(sumExpense),
      gap: fromCents(gapCents),
      remainderCents: remainderCents,
      hasRemainder: remainderCents > 0,
      players: list.map(function (p, idx) {
        return {
          id: p.id,
          name: p.name,
          expense: fromCents(p.expense),
          extraExpense: fromCents(p.extra),
          share: fromCents(share[idx]),
          balance: fromCents(bal[idx])
        };
      }),
      transfers: plan.map(function (t) {
        return {
          fromId: list[t.from].id,
          fromName: list[t.from].name,
          toId: list[t.to].id,
          toName: list[t.to].name,
          amount: fromCents(t.cents)
        };
      }),
      routeType: routeType,
      strategy: mode,
      payerId: dIdx >= 0 ? list[dIdx].id : null,
      payerName: dIdx >= 0 ? list[dIdx].name : null,
      settled: settled,
      savedTransfers: saved,
      hint: hint
    };
  }

  /* ---------------- 社群账单文案(纯文本,可直接粘贴到微信) ---------------- */

  function buildHead(opts, summary) {
    var lines = [opts && opts.title ? opts.title : DEFAULT_TITLE];
    if (opts && opts.dateText) lines.push('📅 ' + opts.dateText);
    lines.push(summary);
    lines.push(SEP);
    return lines;
  }

  function buildQuickBillText(result, opts) {
    if (!result || !result.ok) return '';
    var total = toCents(result.totalAmount);
    var per = toCents(result.perPerson);
    var lines = buildHead(opts, '💰 总费用 ' + fmt(total) + '元 · ' + result.playerCount + '人 · 人均 ' + fmt(per) + '元');
    if (result.playerCount <= 1) {
      lines.push('✅ 仅 1 人,无需转账');
    } else if (per === 0) {
      lines.push('✅ 每人不足 0.01元,其余人无需转账');
    } else {
      lines.push('📌 收款人:' + result.payerName + '(已垫付全款 ' + fmt(total) + '元)');
      lines.push('其余 ' + result.othersCount + ' 人 ➜ ' + result.payerName + ' 每人 ' + fmt(per) + '元');
      lines.push('合计转入 ' + fmt(toCents(result.othersTotal)) + '元');
    }
    if (result.hasRemainder && result.playerCount > 1) {
      lines.push(SEP);
      lines.push('📎 ' + fmt(total) + '元除不尽,多出的 ' + result.remainderCents + ' 分由 ' + result.payerName +
        ' 承担(共承担 ' + fmt(toCents(result.payerShare)) + '元)');
    }
    return lines.join('\n');
  }

  function buildDetailedBillText(result, opts) {
    if (!result || !result.ok) return '';
    var total = toCents(result.totalAmount);
    var per = toCents(result.perPerson);
    var lines = buildHead(opts, '💰 总费用 ' + fmt(total) + '元 · ' + result.players.length + '人 · 人均 ' + fmt(per) + '元');

    if (result.settled) {
      lines.push('✅ 账已结清,无需转账');
    } else {
      lines.push('📌 转账安排(共 ' + result.transfers.length + ' 笔)');
      result.transfers.forEach(function (t, i) {
        lines.push((i + 1) + '. ' + t.fromName + ' ➜ ' + t.toName + ' ' + fmt(toCents(t.amount)) + '元');
      });
    }

    if (result.players.length <= DETAIL_LINES_LIMIT) {
      lines.push(SEP);
      lines.push('📋 个人明细(已垫付 / 应摊)');
      result.players.forEach(function (p) {
        var paid = toCents(p.expense) + toCents(p.extraExpense);
        lines.push(p.name + ':' + fmt(paid) + ' / ' + fmt(toCents(p.share)));
      });
    }

    var notes = [];
    result.players.forEach(function (p) {
      if (p.extraExpense > 0) notes.push('总费用比已录入支出多 ' + fmt(toCents(p.extraExpense)) + '元,已记在 ' + p.name + ' 名下');
    });
    if (result.hasRemainder) notes.push('除不尽的零头(共 ' + result.remainderCents + ' 分)已分摊到部分人');
    if (notes.length) {
      lines.push(SEP);
      notes.forEach(function (n) { lines.push('📎 ' + n); });
    }
    if (!result.settled && result.hint) lines.push('💡 ' + result.hint);
    return lines.join('\n');
  }

  return {
    toCents: toCents,
    fromCents: fromCents,
    formatMoney: formatMoney,
    getNextPlayerNumber: getNextPlayerNumber,
    calculateQuickSplit: calculateQuickSplit,
    calculateDetailedSplit: calculateDetailedSplit,
    buildQuickBillText: buildQuickBillText,
    buildDetailedBillText: buildDetailedBillText
  };
});
