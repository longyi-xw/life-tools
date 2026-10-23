#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
周期性 ETF / 指数基金数据采集与指标计算脚本
=================================================

数据流：
    data/etf_latest.json（上一版数据，作为基准）
        └─ AKShare 抓取：场内行情 / 历史复权净值 / 费率 / 指数估值 / 10Y 国债 / 沪深300 趋势
            └─ 计算：ERP、趋势得分、市场周期、cagr_3y、max_dd_3y、sharpe_3y、tracking_error、fit_score
                └─ 输出 data/etf_latest.json + data/etf_latest.js（file:// 协议下由 <script> 直接挂载）

容错原则：任何接口失败、限流或超时，均保留基准字段，仅更新拿到的数据，脚本始终正常退出。

用法：
    python scripts/update_etf_data.py                       # 联网全量更新
    python scripts/update_etf_data.py --offline             # 不联网，仅按算法重算派生字段
    python scripts/update_etf_data.py --sync-html-fallback  # 额外刷新 etf-screener.html 内置兜底快照

依赖（仅联网模式需要）：pip install akshare pandas
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Optional

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
JSON_PATH = DATA_DIR / "etf_latest.json"
JS_PATH = DATA_DIR / "etf_latest.js"
HTML_PATH = ROOT / "etf-screener.html"

FALLBACK_START = "/*__FALLBACK_ETF_DATA_START__*/"
FALLBACK_END = "/*__FALLBACK_ETF_DATA_END__*/"
JS_GLOBAL = "window.__ETF_LATEST_DATA__"

CST = timezone(timedelta(hours=8))
RISK_FREE = 1.5  # 年化无风险利率 %，用于夏普比率

IN_GHA = os.environ.get("GITHUB_ACTIONS") == "true"


# ════════════════════════════════════════════════════════════════
#  日志
# ════════════════════════════════════════════════════════════════
def log(msg: str) -> None:
    print(f"[{datetime.now(CST):%H:%M:%S}] {msg}", flush=True)


def warn(msg: str) -> None:
    if IN_GHA:
        print(f"::warning::{msg}", flush=True)
    else:
        log(f"WARN {msg}")


# ════════════════════════════════════════════════════════════════
#  MarketRegimeEngine —— 与 etf-screener.html 中的 JS 引擎逐行对齐
#  修改任何阈值 / 权重时，请同步修改前端 <script id="engine">
# ════════════════════════════════════════════════════════════════
BOTTOM = "BOTTOM_ACCUMULATE"
BULL = "BULL_TREND"
RANGE = "RANGE_DEFENSIVE"
OVERHEAT = "OVERHEAT_HEDGE"

REGIME_NAMES = {
    BOTTOM: "底部左侧布局期 · 高赔率磨底",
    BULL: "右侧景气主升期 · 动量共振",
    RANGE: "震荡分化防御期 · 哑铃配置",
    OVERHEAT: "高估过热或破位避险期 · 防守反击",
}

# 周期 × 风格 → 周期类别契合分（0~100）
STYLE_FIT: dict[str, dict[str, float]] = {
    BOTTOM: {
        "core": 98, "growth_broad": 90, "dividend": 88, "hk_growth": 88, "hk_dividend": 82,
        "defensive_sector": 74, "growth_sector": 72, "cyclical": 70, "us_equity": 55,
        "jp_equity": 50, "gold": 55, "commodity": 45, "long_bond": 50, "credit_bond": 45, "cash": 30,
    },
    BULL: {
        "growth_sector": 100, "growth_broad": 96, "hk_growth": 90, "cyclical": 82, "core": 76,
        "commodity": 70, "us_equity": 64, "defensive_sector": 60, "jp_equity": 58, "dividend": 48,
        "gold": 48, "hk_dividend": 46, "long_bond": 28, "credit_bond": 25, "cash": 18,
    },
    RANGE: {
        "dividend": 98, "hk_dividend": 95, "gold": 80, "long_bond": 78, "core": 75,
        "credit_bond": 72, "defensive_sector": 70, "us_equity": 65, "hk_growth": 60, "cash": 60,
        "growth_broad": 58, "jp_equity": 58, "cyclical": 55, "commodity": 55, "growth_sector": 45,
    },
    OVERHEAT: {
        "long_bond": 98, "gold": 95, "credit_bond": 92, "cash": 85, "us_equity": 72,
        "dividend": 70, "hk_dividend": 68, "commodity": 60, "jp_equity": 55, "defensive_sector": 45,
        "core": 40, "cyclical": 35, "hk_growth": 35, "growth_broad": 28, "growth_sector": 22,
    },
}

W_CYCLE, W_VALUE, W_COST, W_RISK = 0.35, 0.25, 0.20, 0.20


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def r1(x: float) -> float:
    """四舍五入到 1 位小数（与 JS Math.round 行为一致，避免 Python 银行家舍入）。"""
    return math.floor(x * 10 + 0.5) / 10


def r2(x: float) -> float:
    return math.floor(x * 100 + 0.5) / 100


def compute_erp(pe: Optional[float], cn10y: Optional[float]) -> Optional[float]:
    if not pe or pe <= 0 or cn10y is None:
        return None
    return r2(100 / pe - cn10y)


def compute_trend_score(d: dict[str, Any]) -> Optional[float]:
    """收盘价相对 MA20/MA60/MA250 偏离度 + 近 20/60 日涨跌幅 → -100~+100。"""
    try:
        close, ma20, ma60, ma250 = (float(d[k]) for k in ("hs300_close", "ma20", "ma60", "ma250"))
        ret20, ret60 = float(d["ret_20d"]), float(d["ret_60d"])
    except (KeyError, TypeError, ValueError):
        return None

    def n(x: float, s: float) -> float:
        return clamp(x / s, -1, 1) * 100

    def dev(ma: float) -> float:
        return (close / ma - 1) * 100

    score = (0.25 * n(dev(ma20), 5) + 0.25 * n(dev(ma60), 8) + 0.20 * n(dev(ma250), 15)
             + 0.15 * n(ret20, 8) + 0.15 * n(ret60, 15))
    return r1(clamp(score, -100, 100))


def detect_regime(m: dict[str, Any]) -> str:
    """
    优先级：估值过热一票否决 → 动量主升 → 趋势破位 → 高赔率底部 → 震荡防御（剩余区间）。
    """
    erp = m.get("erp")
    pe_pct = m.get("hs300_pe_pct")
    trend = m.get("trend_score")
    erp = 4.5 if erp is None else erp
    pe_pct = 50 if pe_pct is None else pe_pct
    trend = 0 if trend is None else trend
    if pe_pct >= 75 or erp <= 3.2:
        return OVERHEAT
    if trend > 15:
        return BULL
    if trend < -20:
        return OVERHEAT
    if erp >= 5.2 or pe_pct <= 25:
        return BOTTOM
    return RANGE


def fee_score(fee: Optional[float]) -> float:
    return 50.0 if fee is None else clamp((1.0 - fee) / 0.8, 0, 1) * 100


def scale_score(scale: Optional[float]) -> float:
    if scale is None:
        return 50.0
    if scale <= 0:
        return 0.0
    return clamp(math.log10(scale) / math.log10(500), 0, 1) * 100


def vol_score(vol: Optional[float]) -> float:
    if vol is None:
        return 40.0
    if vol <= 0:
        return 0.0
    return clamp((math.log10(vol) + 1) / 3, 0, 1) * 100


def te_score(te: Optional[float]) -> float:
    return 50.0 if te is None else 100 * math.exp(-max(te, 0) / 1.5)


def sharpe_score(s: Optional[float]) -> float:
    return 40.0 if s is None else clamp((s + 0.5) / 2.0, 0, 1) * 100


def dd_score(dd: Optional[float]) -> float:
    return 50.0 if dd is None else clamp(1 - abs(dd) / 50, 0, 1) * 100


def cagr_score(c: Optional[float]) -> float:
    return 40.0 if c is None else clamp((c + 5) / 20, 0, 1) * 100


def cycle_score(etf: dict[str, Any], regime: str) -> float:
    return float(STYLE_FIT[regime].get(etf.get("style") or "", 50))


def value_score(etf: dict[str, Any], macro: dict[str, Any]) -> float:
    pe_pct = etf.get("pe_pct")
    if pe_pct is not None:
        pb_pct = etf.get("pb_pct")
        pe_part = 100 - pe_pct
        pb_part = pe_part if pb_pct is None else 100 - pb_pct
        div_part = clamp((etf.get("div_yield") or 0) / 6, 0, 1) * 100
        return 0.45 * pe_part + 0.25 * pb_part + 0.30 * div_part
    style = etf.get("style")
    if style in ("long_bond", "credit_bond"):
        y = macro.get("cn10y_yield")
        y = 2.0 if y is None else y
        return clamp(60 + (y - 2.0) * 20, 30, 90)
    return {"cash": 60.0, "gold": 55.0, "commodity": 50.0}.get(style or "", 50.0)


def cost_score(etf: dict[str, Any]) -> float:
    prem = etf.get("premium_rate")
    penalty = 0 if prem is None else min(abs(prem) * 6, 30)
    s = (0.45 * fee_score(etf.get("total_fee")) + 0.30 * scale_score(etf.get("scale_yi"))
         + 0.25 * vol_score(etf.get("daily_vol_yi")) - penalty)
    return clamp(s, 0, 100)


def risk_score(etf: dict[str, Any]) -> float:
    return (0.45 * sharpe_score(etf.get("sharpe_3y")) + 0.40 * dd_score(etf.get("max_dd_3y"))
            + 0.15 * te_score(etf.get("tracking_error")))


def fit_score(etf: dict[str, Any], regime: str, macro: dict[str, Any]) -> float:
    s = (W_CYCLE * cycle_score(etf, regime) + W_VALUE * value_score(etf, macro)
         + W_COST * cost_score(etf) + W_RISK * risk_score(etf))
    return r1(clamp(s, 0, 100))


# 自动标签：每次运行剥离后按最新数据重新生成，其余手工标签原样保留
AUTO_TAGS = ("降费最低档", "百亿龙头", "可T+0", "高股息", "流动性预警", "清盘风险", "高溢价")


def build_tags(etf: dict[str, Any]) -> list[str]:
    manual = [t for t in (etf.get("tags") or []) if t not in AUTO_TAGS]
    auto: list[str] = []
    fee, scale = etf.get("total_fee"), etf.get("scale_yi")
    if fee is not None and fee <= 0.20:
        auto.append("降费最低档")
    if scale is not None and scale >= 100:
        auto.append("百亿龙头")
    if etf.get("t_plus") == "T+0":
        auto.append("可T+0")
    if (etf.get("div_yield") or 0) >= 4:
        auto.append("高股息")
    if scale is not None and scale < 0.5:
        auto.append("清盘风险")
    elif scale is not None and scale < 2:
        auto.append("流动性预警")
    if abs(etf.get("premium_rate") or 0) >= 1.5:
        auto.append("高溢价")
    return auto + manual


def recompute(data: dict[str, Any]) -> str:
    macro = data.setdefault("macro_context", {})
    erp = compute_erp(macro.get("hs300_pe"), macro.get("cn10y_yield"))
    if erp is not None:
        macro["erp"] = erp
    trend = compute_trend_score(macro.get("trend_detail") or {})
    if trend is not None:
        macro["trend_score"] = trend
    regime = detect_regime(macro)
    data["regime"] = {"code": regime, "name": REGIME_NAMES[regime]}
    for etf in data.get("etf_list", []):
        mg, cu = etf.get("mgmt_fee"), etf.get("custody_fee")
        if mg is not None and cu is not None:
            etf["total_fee"] = r2(mg + cu)
        if etf.get("pe_pct") is not None:
            etf.setdefault("val_src", "base")
        etf["tags"] = build_tags(etf)
        etf["fit_score"] = fit_score(etf, regime, macro)
    return regime


# ════════════════════════════════════════════════════════════════
#  通用工具
# ════════════════════════════════════════════════════════════════
def to_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    s = str(v).strip().replace(",", "").replace("%", "")
    if s in ("", "-", "--", "nan", "None", "NaN"):
        return None
    try:
        return float(s)
    except ValueError:
        m = re.search(r"-?\d+(?:\.\d+)?", s)
        return float(m.group()) if m else None


def pick_col(df: Any, *candidates: str) -> Optional[str]:
    cols = [str(c) for c in df.columns]
    for c in candidates:
        if c in cols:
            return c
    for c in candidates:
        for col in cols:
            if c in col:
                return col
    return None


def run_with_timeout(fn: Callable[[], Any], timeout: float) -> Any:
    """AKShare 底层 requests 多数未设超时，单个连接卡死会拖住整个任务；放入守护线程硬性限时。"""
    box: dict[str, Any] = {}

    def target() -> None:
        try:
            box["result"] = fn()
        except BaseException as exc:  # noqa: BLE001 —— 原样抛回主线程
            box["error"] = exc

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"超过 {timeout:g}s 未响应")
    if "error" in box:
        raise box["error"]
    return box.get("result")


def with_retry(label: str, fn: Callable[[], Any], retries: int, delay: float, timeout: float = 45.0) -> Any:
    for attempt in range(1, retries + 1):
        try:
            result = run_with_timeout(fn, timeout)
            if result is None or (hasattr(result, "empty") and result.empty):
                raise ValueError("接口返回空数据")
            return result
        except Exception as exc:  # 网络 / 限流 / 解析异常统一容错
            log(f"  ! {label} 第 {attempt}/{retries} 次失败：{type(exc).__name__}: {str(exc)[:120]}")
            if attempt < retries:
                time.sleep(delay * (2 ** (attempt - 1)))
    return None


def percentile_of_last(values: list[float]) -> Optional[float]:
    vals = [v for v in values if v is not None and v > 0]
    if len(vals) < 30:
        return None
    last = vals[-1]
    below = sum(1 for v in vals if v <= last)
    return r1(below / len(vals) * 100)


def to_date(v: Any) -> date:
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


def exchange_prefix(code: str) -> str:
    return "sh" if code[:1] in ("5", "6") else "sz"


# ════════════════════════════════════════════════════════════════
#  AKShare 采集层（仅联网模式导入 akshare / pandas）
#  每类数据按「主接口 → 备用接口 → 保留基准」降级；同一接口连续失败 2 次即熔断
# ════════════════════════════════════════════════════════════════
INDEX_EM_SYMBOL = {  # 跟踪误差计算所需的 A 股指数代码（东方财富口径）
    "沪深300": "sh000300", "中证A500": "sh000510", "上证50": "sh000016", "中证500": "sh000905",
    "中证1000": "sh000852", "创业板指": "sz399006", "科创50": "sh000688", "上证红利": "sh000015",
    "中证红利": "sh000922", "国证芯片": "sz980017", "中证医疗": "sz399989", "中证主要消费": "sh000932",
    "中证全指证券公司": "sz399975", "中证军工": "sz399967", "中证新能源汽车": "sz399976",
}
INDEX_LG_SYMBOL = {  # 乐咕乐股 PE / PB 月度历史（可算近 10 年分位）
    "沪深300": "沪深300", "上证50": "上证50", "中证500": "中证500", "中证1000": "中证1000",
    "上证红利": "上证红利",
}
INDEX_CS_SYMBOL = {  # 中证指数官网估值（当期 PE / 股息率，无历史分位）
    "中证A500": "000510", "中证红利": "000922", "红利低波": "H30269", "中证医疗": "399989",
    "中证主要消费": "000932", "中证全指半导体": "H30184", "中证人工智能主题": "930713",
    "中证新能源汽车": "399976", "中证全指证券公司": "399975", "中证军工": "399967",
    "中证央企红利": "000825", "沪深300医药卫生": "000913",
}
BREAKER_LIMIT = 2


class Collector:
    def __init__(self, args: argparse.Namespace):
        import akshare as ak  # noqa: F401  延迟导入：--offline 模式无需安装
        self.ak = ak
        self.retries = args.retries
        self.delay = args.delay
        self.sleep = args.sleep
        self.timeout = args.timeout
        self.today = datetime.now(CST).date()
        self.updated = 0
        self.failures: list[str] = []
        self.latest_trade_date: Optional[date] = None
        self._index_cache: dict[str, Any] = {}
        self._lg_cache: dict[str, dict[str, Optional[float]]] = {}
        self._breaker: dict[str, int] = {}

    def call(self, label: str, fn: Callable[[], Any], breaker: Optional[str] = None,
             retries: Optional[int] = None, quiet: bool = False, pause: Optional[float] = None) -> Any:
        if breaker and self._breaker.get(breaker, 0) >= BREAKER_LIMIT:
            return None
        res = with_retry(label, fn, retries or self.retries, self.delay, self.timeout)
        if res is None and not quiet:
            self.failures.append(label)
        if breaker:
            self._breaker[breaker] = 0 if res is not None else self._breaker.get(breaker, 0) + 1
            if self._breaker[breaker] == BREAKER_LIMIT:
                log(f"  ⚡ 接口 {breaker} 连续失败 {BREAKER_LIMIT} 次，本次运行熔断，改用备用数据源")
        time.sleep(self.sleep if pause is None else pause)
        return res

    def _note_date(self, d: Optional[date]) -> None:
        if d and (self.latest_trade_date is None or d > self.latest_trade_date):
            self.latest_trade_date = d

    def _drop_intraday(self, rows: list[Any]) -> list[Any]:
        """15:30 前运行时，当日 K 线尚未收盘，剔除以免把盘中价当作收盘价。"""
        now = datetime.now(CST)
        if rows and rows[-1][0] == now.date() and (now.hour, now.minute) < (15, 30):
            return rows[:-1]
        return rows

    # ── 宏观：10Y 国债 ──────────────────────────────────────
    def cn10y(self) -> Optional[float]:
        start = (self.today - timedelta(days=60)).strftime("%Y%m%d")
        df = self.call("中债10年期国债收益率", lambda: self.ak.bond_zh_us_rate(start_date=start))
        if df is None:
            return None
        col = pick_col(df, "中国国债收益率10年")
        if not col:
            return None
        vals = [to_float(v) for v in df[col].tolist()]
        vals = [v for v in vals if v is not None]
        return r2(vals[-1]) if vals else None

    # ── 指数 PE（TTM）/ PB 及近 10 年分位（乐咕乐股）────────
    def index_lg(self, name: str) -> dict[str, Optional[float]]:
        if name in self._lg_cache:
            return self._lg_cache[name]
        out: dict[str, Optional[float]] = {}
        sym = INDEX_LG_SYMBOL.get(name)
        if not sym:
            return out
        self._lg_cache[name] = out
        lg_pause = max(self.sleep, 1.2)  # 乐咕乐股限频较严（429），放慢节奏
        cutoff = self.today - timedelta(days=3652)
        df = self.call(f"{name} PE 历史", lambda: self.ak.stock_index_pe_lg(symbol=sym), pause=lg_pause)
        if df is not None:
            dcol, pcol = pick_col(df, "日期"), pick_col(df, "滚动市盈率")
            if dcol and pcol:
                rows = [(to_date(d), to_float(p)) for d, p in zip(df[dcol], df[pcol])]
                rows = sorted((d, p) for d, p in rows if d >= cutoff and p)
                if rows:
                    out["pe"] = r2(rows[-1][1])
                    out["pe_pct"] = percentile_of_last([p for _, p in rows])
        df = self.call(f"{name} PB 历史", lambda: self.ak.stock_index_pb_lg(symbol=sym), pause=lg_pause)
        if df is not None:
            dcol, pcol = pick_col(df, "日期"), pick_col(df, "市净率")
            if dcol and pcol:
                rows = [(to_date(d), to_float(p)) for d, p in zip(df[dcol], df[pcol])]
                rows = sorted((d, p) for d, p in rows if d >= cutoff and p)
                if rows:
                    out["pb"] = r2(rows[-1][1])
                    out["pb_pct"] = percentile_of_last([p for _, p in rows])
        return out

    # ── 全 A 市净率中位数（中证全指 PB 代理口径）───────────
    def all_share_pb(self) -> dict[str, Any]:
        df = self.call("全A市净率", lambda: self.ak.stock_a_all_pb())
        if df is None:
            return {}
        dcol, vcol = pick_col(df, "date", "日期"), pick_col(df, "middlePB")
        qcol = pick_col(df, "quantileInRecent10YearsMiddlePB")
        if not dcol or not vcol:
            return {}
        df = df.sort_values(dcol)
        cutoff = self.today - timedelta(days=3652)
        rows = [(to_date(d), to_float(v)) for d, v in zip(df[dcol], df[vcol])]
        rows = [(d, v) for d, v in rows if d >= cutoff and v]
        if not rows:
            return {}
        q = to_float(df[qcol].iloc[-1]) if qcol else None
        return {
            "all_share_pb": r2(rows[-1][1]),
            "all_share_pb_pct": r1(q * 100) if q is not None else percentile_of_last([v for _, v in rows]),
            "all_share_pb_label": "全A市净率(中位数)",
        }

    # ── 指数日线（趋势 + 跟踪误差共用）─────────────────────
    def index_daily(self, em_symbol: str) -> Optional[list[tuple[date, float]]]:
        if em_symbol in self._index_cache:
            return self._index_cache[em_symbol]
        rows = None
        for label, breaker, fn in (
            (f"指数日线 {em_symbol}(东财)", "index_em", lambda: self.ak.stock_zh_index_daily_em(symbol=em_symbol)),
            (f"指数日线 {em_symbol}(新浪)", "index_sina", lambda: self.ak.stock_zh_index_daily(symbol=em_symbol)),
        ):
            df = self.call(label, fn, breaker=breaker, quiet=breaker == "index_em")
            if df is None:
                continue
            dcol, ccol = pick_col(df, "date", "日期"), pick_col(df, "close", "收盘")
            if dcol and ccol:
                rows = [(to_date(d), to_float(c)) for d, c in zip(df[dcol], df[ccol])]
                rows = self._drop_intraday(sorted((d, c) for d, c in rows if c))
                if rows:
                    break
        self._index_cache[em_symbol] = rows
        return rows

    def hs300_trend(self) -> Optional[dict[str, float]]:
        rows = self.index_daily("sh000300")
        if not rows or len(rows) < 260:
            return None
        closes = [c for _, c in rows]
        self._note_date(rows[-1][0])

        def ma(n: int) -> float:
            return sum(closes[-n:]) / n

        return {
            "hs300_close": r2(closes[-1]), "ma20": r2(ma(20)), "ma60": r2(ma(60)), "ma250": r2(ma(250)),
            "ret_20d": r2((closes[-1] / closes[-21] - 1) * 100),
            "ret_60d": r2((closes[-1] / closes[-61] - 1) * 100),
        }

    # ── 规模 / 折溢价：东财行情 → 东财基金净值表 + 上交所份额 ─
    def spot(self) -> dict[str, dict[str, Optional[float]]]:
        out: dict[str, dict[str, Optional[float]]] = {}
        df = self.call("ETF 场内行情(东财)", lambda: self.ak.fund_etf_spot_em(), breaker="spot_em", quiet=True)
        if df is not None:
            c_code, c_price = pick_col(df, "代码"), pick_col(df, "最新价")
            c_iopv, c_mv = pick_col(df, "IOPV实时估值", "IOPV"), pick_col(df, "总市值")
            if c_code:
                for _, row in df.iterrows():
                    code = str(row[c_code]).strip().zfill(6)
                    price = to_float(row[c_price]) if c_price else None
                    iopv = to_float(row[c_iopv]) if c_iopv else None
                    mv = to_float(row[c_mv]) if c_mv else None
                    out[code] = {
                        "premium_rate": r2((price / iopv - 1) * 100) if price and iopv else None,
                        "scale_yi": r2(mv / 1e8) if mv else None,
                    }
                return out

        nav: dict[str, float] = {}
        df = self.call("ETF 净值与市价(东财基金)", lambda: self.ak.fund_etf_fund_daily_em())
        if df is not None:
            c_code, c_price = pick_col(df, "基金代码"), pick_col(df, "市价")
            nav_cols = [str(c) for c in df.columns if str(c).endswith("-单位净值")]  # 最新日期在前
            for _, row in df.iterrows():
                code = str(row[c_code]).strip().zfill(6)
                nv = next((to_float(row[c]) for c in nav_cols if to_float(row[c])), None)
                price = to_float(row[c_price]) if c_price else None
                if nv:
                    nav[code] = nv
                    out.setdefault(code, {})["premium_rate"] = r2((price / nv - 1) * 100) if price else None

        for back in range(0, 7):  # 上交所份额：当日数据晚间才发布，向前回溯最近交易日
            d = self.today - timedelta(days=back)
            if d.weekday() >= 5:
                continue
            df = self.call(f"上交所 ETF 份额 {d}", lambda d=d: self.ak.fund_etf_scale_sse(date=d.strftime("%Y%m%d")),
                           retries=1, quiet=True)
            if df is None:
                continue
            c_code, c_share = pick_col(df, "基金代码"), pick_col(df, "基金份额")
            for code, share in zip(df[c_code], df[c_share]):
                code = str(code).strip().zfill(6)
                s = to_float(share)
                if s and code in nav:
                    out.setdefault(code, {})["scale_yi"] = r2(s * nav[code] / 1e8)
            break
        return out

    # ── 历史行情：东财后复权 → 东财基金复权净值 ─────────────
    def etf_hist(self, code: str) -> Optional[list[tuple[date, float, Optional[float]]]]:
        start = (self.today - timedelta(days=3 * 365 + 30)).strftime("%Y%m%d")
        end = self.today.strftime("%Y%m%d")
        df = self.call(f"{code} 后复权行情(东财)", lambda: self.ak.fund_etf_hist_em(
            symbol=code, period="daily", start_date=start, end_date=end, adjust="hfq"), breaker="hist_em", quiet=True)
        if df is not None:
            dcol, ccol, acol = pick_col(df, "日期"), pick_col(df, "收盘"), pick_col(df, "成交额")
            if dcol and ccol:
                rows = [(to_date(d), to_float(c), to_float(a) if acol else None)
                        for d, c, a in zip(df[dcol], df[ccol], df[acol] if acol else [None] * len(df))]
                rows = self._drop_intraday(sorted(r for r in rows if r[1]))
                if rows:
                    return rows

        df = self.call(f"{code} 复权净值(东财基金)", lambda: self.ak.fund_etf_fund_info_em(
            fund=code, start_date=start, end_date=end), breaker="fund_info_em")
        if df is None:
            return None
        dcol, gcol, ncol = pick_col(df, "净值日期"), pick_col(df, "日增长率"), pick_col(df, "单位净值")
        if not dcol:
            return None
        df = df.sort_values(dcol)
        rows: list[tuple[date, float, Optional[float]]] = []
        level, prev_nav = 1.0, None
        for d, g, nv in zip(df[dcol], df[gcol] if gcol else [None] * len(df), df[ncol] if ncol else [None] * len(df)):
            gr, nv = to_float(g), to_float(nv)
            if rows:
                if gr is not None:  # 日增长率已含分红复权
                    level *= 1 + gr / 100
                elif nv and prev_nav:
                    level *= nv / prev_nav
            prev_nav = nv or prev_nav
            rows.append((to_date(d), level, None))
        return rows if len(rows) > 1 else None

    def sina_amount(self, code: str) -> Optional[float]:
        df = self.call(f"{code} 成交额(新浪)", lambda: self.ak.fund_etf_hist_sina(symbol=exchange_prefix(code) + code),
                       breaker="sina_hist")
        if df is None:
            return None
        dcol, acol = pick_col(df, "date"), pick_col(df, "amount")
        if not dcol or not acol:
            return None
        rows = self._drop_intraday(sorted((to_date(d), to_float(a)) for d, a in zip(df[dcol], df[acol])))
        amts = [a for _, a in rows[-20:] if a]
        return r2(sum(amts) / len(amts) / 1e8) if amts else None

    @staticmethod
    def perf_metrics(rows: list[tuple[date, float, Optional[float]]]) -> dict[str, Optional[float]]:
        last_d, last_c = rows[-1][0], rows[-1][1]

        def close_before(target: date) -> Optional[float]:
            prev = None
            for d, c, _ in rows:
                if d > target:
                    break
                prev = c
            return prev

        out: dict[str, Optional[float]] = {}
        c1m = close_before(last_d - timedelta(days=30))
        c1y = close_before(last_d - timedelta(days=365))
        if c1m:
            out["ret_1m"] = r2((last_c / c1m - 1) * 100)
        if c1y:
            out["ret_1y"] = r2((last_c / c1y - 1) * 100)

        amts = [a for _, _, a in rows[-20:] if a]
        if amts:
            out["daily_vol_yi"] = r2(sum(amts) / len(amts) / 1e8)
        win = [r for r in rows if r[0] >= last_d - timedelta(days=3 * 365)]
        span = (win[-1][0] - win[0][0]).days / 365.25 if len(win) > 1 else 0
        if span < 2.5:  # 成立不足 2.5 年：保留基准中的指数口径 3 年指标
            return out
        closes = [c for _, c, _ in win]
        cagr = (closes[-1] / closes[0]) ** (1 / span) - 1
        rets = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]
        mean = sum(rets) / len(rets)
        vol = math.sqrt(sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)) * math.sqrt(250)
        peak, mdd = closes[0], 0.0
        for c in closes:
            peak = max(peak, c)
            mdd = min(mdd, c / peak - 1)
        out["cagr_3y"] = r2(cagr * 100)
        out["max_dd_3y"] = r2(mdd * 100)
        if vol > 0:
            out["sharpe_3y"] = r2((cagr * 100 - RISK_FREE) / (vol * 100))
        return out

    def tracking_error(self, etf_rows: list[tuple[date, float, Optional[float]]],
                       index_name: str) -> Optional[float]:
        sym = INDEX_EM_SYMBOL.get(index_name)
        if not sym:
            return None
        idx = self.index_daily(sym)
        if not idx:
            return None
        idx_map = {d: c for d, c in idx}
        common = [(d, c, idx_map[d]) for d, c, _ in etf_rows if d in idx_map][-251:]
        if len(common) < 60:
            return None
        diffs = []
        for i in range(1, len(common)):
            de = common[i][1] / common[i - 1][1] - 1
            di = common[i][2] / common[i - 1][2] - 1
            # 复权 ETF 对比价格指数：除息日会出现分红跳空，剔除 >1% 的单日偏离
            if abs(de - di) <= 0.01:
                diffs.append(de - di)
        if len(diffs) < 60:
            return None
        mean = sum(diffs) / len(diffs)
        sd = math.sqrt(sum((x - mean) ** 2 for x in diffs) / (len(diffs) - 1))
        return r2(sd * math.sqrt(250) * 100)

    # ── 基金概况：费率 + 季报净资产（东财基金）───────────────
    def overview(self, code: str) -> dict[str, float]:
        df = self.call(f"{code} 基金概况", lambda: self.ak.fund_overview_em(symbol=code), breaker="overview_em")
        out: dict[str, float] = {}
        if df is not None:
            row = df.iloc[0]
            for col, field in (("管理费率", "mgmt_fee"), ("托管费率", "custody_fee")):
                c = pick_col(df, col)
                v = to_float(row[c]) if c else None
                if v is not None:
                    out[field] = v
            c = pick_col(df, "净资产规模")
            if c:
                text = str(row[c])
                v = to_float(text.split("（")[0])
                if v is not None:
                    out["scale_yi"] = r2(v / 1e4) if "万元" in text.split("（")[0] else r2(v)
        if "mgmt_fee" not in out or "custody_fee" not in out:
            out.update(self.fees(code))
        return out

    def fees(self, code: str) -> dict[str, float]:
        df = self.call(f"{code} 运作费率", lambda: self.ak.fund_fee_em(symbol=code, indicator="运作费用"),
                       breaker="fee_em")
        if df is None:
            return {}
        cells: list[str] = [str(c) for c in df.columns]
        for row in df.itertuples(index=False):
            cells.extend(str(v) for v in row)
        out: dict[str, float] = {}
        for i, cell in enumerate(cells):
            for key, field in (("管理费", "mgmt_fee"), ("托管费", "custody_fee")):
                if key in cell and field not in out:
                    inline = re.search(r"(\d+(?:\.\d+)?)\s*%", cell)
                    nxt = re.search(r"(\d+(?:\.\d+)?)\s*%", cells[i + 1]) if i + 1 < len(cells) else None
                    hit = inline or nxt
                    if hit:
                        out[field] = float(hit.group(1))
        return out

    # ── 指数当期估值（中证官网）──────────────────────────────
    def index_cs(self, index_name: str) -> dict[str, float]:
        sym = INDEX_CS_SYMBOL.get(index_name)
        if not sym:
            return {}
        df = self.call(f"{index_name} 中证估值", lambda: self.ak.stock_zh_index_value_csindex(symbol=sym))
        if df is None:
            return {}
        dcol = pick_col(df, "日期")
        if dcol:
            df = df.sort_values(dcol)
        last = df.iloc[-1]
        out: dict[str, float] = {}
        pe_col = pick_col(df, "市盈率2", "市盈率1")
        dy_col = pick_col(df, "股息率2", "股息率1")
        if pe_col and to_float(last[pe_col]):
            out["pe"] = r2(to_float(last[pe_col]))
        if dy_col and to_float(last[dy_col]) is not None:
            out["div_yield"] = r2(to_float(last[dy_col]))
        return out

    # ── 场外联接代码补全（仅填充缺失项）─────────────────────
    def resolve_otc(self, etfs: list[dict[str, Any]]) -> int:
        missing = [e for e in etfs if not e.get("otc_code") or e.get("otc_code") in ("—", "-")]
        if not missing:
            return 0
        df = self.call("全市场基金名录", lambda: self.ak.fund_name_em())
        if df is None:
            return 0
        ccol, ncol = pick_col(df, "基金代码"), pick_col(df, "基金简称")
        if not ccol or not ncol:
            return 0
        names = [(str(c).zfill(6), str(n)) for c, n in zip(df[ccol], df[ncol]) if "联接" in str(n)]
        filled = 0
        for e in missing:
            kw = re.sub(r"ETF.*$", "", e.get("name", "")).strip()
            company = e.get("company") or ""
            if not kw or not company:
                continue
            cands = [(c, n) for c, n in names if company in n and kw in n]
            a = [c for c, n in cands if n.rstrip().endswith("A")]
            c_ = [c for c, n in cands if n.rstrip().endswith("C")]
            if len(a) == 1:
                e["otc_code"] = f"{a[0]} / {c_[0]}" if len(c_) == 1 else a[0]
                filled += 1
        return filled


def collect(data: dict[str, Any], args: argparse.Namespace) -> int:
    try:
        col = Collector(args)
    except ImportError as exc:
        warn(f"未安装 akshare（{exc}），改为离线重算模式。安装：pip install akshare pandas")
        return 0

    macro = data.setdefault("macro_context", {})
    etfs: list[dict[str, Any]] = data.get("etf_list", [])

    log("① 宏观特征：10Y 国债 / 沪深300 估值 / 全A PB / 趋势")
    y = col.cn10y()
    if y is not None:
        macro["cn10y_yield"] = y
        col.updated += 1
    hs = col.index_lg("沪深300")
    if hs.get("pe"):
        macro["hs300_pe"] = hs["pe"]
        if hs.get("pe_pct") is not None:
            macro["hs300_pe_pct"] = hs["pe_pct"]
        col.updated += 1
    pb = col.all_share_pb()
    if pb:
        macro.update(pb)
        col.updated += 1
    trend = col.hs300_trend()
    if trend:
        macro["trend_detail"] = trend
        col.updated += 1

    log("② 场内行情：规模 / 折溢价")
    spot = col.spot()
    scale_done: set[str] = set()
    for e in etfs:
        s = spot.get(e["code"])
        if not s:
            continue
        for k in ("scale_yi", "premium_rate"):
            if s.get(k) is not None:
                e[k] = s[k]
                if k == "scale_yi":
                    scale_done.add(e["code"])
        col.updated += 1

    log(f"③ 历史行情：收益 / 回撤 / 夏普 / 跟踪误差 / 成交额（{len(etfs)} 只）")
    for i, e in enumerate(etfs, 1):
        rows = col.etf_hist(e["code"])
        if rows:
            col._note_date(rows[-1][0])
            metrics = col.perf_metrics(rows)
            te = col.tracking_error(rows, e.get("index_name", ""))
            if te is not None:
                metrics["tracking_error"] = te
            e.update(metrics)
            col.updated += 1
        if not rows or not any(r[2] for r in rows[-20:]):
            vol = col.sina_amount(e["code"])
            if vol is not None:
                e["daily_vol_yi"] = vol
        if i % 10 == 0:
            log(f"   … {i}/{len(etfs)}")

    log("④ 指数估值：PE / PB 分位 / 股息率")
    val_cache: dict[str, dict[str, Optional[float]]] = {}
    for e in etfs:
        if e.get("pe") is None:  # 债券 / 商品无估值
            continue
        name = e.get("index_name", "")
        if name not in val_cache:
            v: dict[str, Optional[float]] = {}
            v.update(col.index_cs(name))
            v.update({k: val for k, val in col.index_lg(name).items() if val is not None})
            val_cache[name] = v
        v = val_cache[name]
        for k in ("pe", "pe_pct", "pb", "pb_pct", "div_yield"):
            if v.get(k) is not None:
                e[k] = v[k]
        # 估值分位口径：lg = 乐咕近 10 年分位（实盘）；cs = 中证当期 PE / 股息率（分位沿用基准）；base = 基准估算
        if v.get("pe_pct") is not None:
            e["val_src"] = "lg"
        elif v:
            e["val_src"] = "cs"
        if v:
            col.updated += 1

    if not args.skip_fees:
        log("⑤ 基金概况：管理费 / 托管费 / 季报规模（补充深市 ETF）")
        for e in etfs:
            f = col.overview(e["code"])
            if "mgmt_fee" in f and "custody_fee" in f:
                e["mgmt_fee"], e["custody_fee"] = f["mgmt_fee"], f["custody_fee"]
                col.updated += 1
            if e["code"] not in scale_done and f.get("scale_yi") is not None:
                e["scale_yi"] = f["scale_yi"]

    if not args.skip_otc:
        log("⑥ 场外联接代码补全")
        n = col.resolve_otc(etfs)
        if n:
            log(f"   补全 {n} 只")
            col.updated += n

    if col.latest_trade_date:
        data["update_date"] = col.latest_trade_date.isoformat()
    if col.failures:
        warn(f"{len(col.failures)} 个接口调用失败（已保留基准字段）：" + "；".join(col.failures[:6])
             + (" …" if len(col.failures) > 6 else ""))
    return col.updated


# ════════════════════════════════════════════════════════════════
#  输出
# ════════════════════════════════════════════════════════════════
def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def write_outputs(data: dict[str, Any]) -> None:
    body = json.dumps(data, ensure_ascii=False, indent=2)
    write_text(JSON_PATH, body + "\n")
    header = (f"/* 由 scripts/update_etf_data.py 自动生成，请勿手动编辑 | "
              f"generated_at: {data.get('generated_at')} */\n")
    write_text(JS_PATH, f"{header}{JS_GLOBAL} = {body};\n")
    log(f"已写入 {JSON_PATH.relative_to(ROOT)} 与 {JS_PATH.relative_to(ROOT)}")


def compact_snapshot(data: dict[str, Any]) -> str:
    """一行一只 ETF 的紧凑 JSON，便于在 HTML 中阅读与 diff。"""
    head = {k: v for k, v in data.items() if k != "etf_list"}
    head_json = json.dumps(head, ensure_ascii=False, separators=(",", ":"))
    rows = ",\n".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in data.get("etf_list", []))
    text = head_json[:-1] + ',"etf_list":[\n' + rows + "\n]}"
    return text.replace("</", "<\\/")


def sync_html_fallback(data: dict[str, Any]) -> None:
    if not HTML_PATH.exists():
        warn(f"{HTML_PATH.name} 不存在，跳过兜底快照同步")
        return
    html = HTML_PATH.read_text(encoding="utf-8")
    start, end = html.find(FALLBACK_START), html.find(FALLBACK_END)
    if start < 0 or end < 0 or end < start:
        warn(f"{HTML_PATH.name} 中未找到兜底快照标记，跳过")
        return
    new_html = html[: start + len(FALLBACK_START)] + compact_snapshot(data) + html[end:]
    write_text(HTML_PATH, new_html)
    log(f"已同步 {HTML_PATH.name} 内置 FALLBACK_ETF_DATA（{len(data.get('etf_list', []))} 只）")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="周期性 ETF 数据采集与指标计算")
    ap.add_argument("--offline", action="store_true", help="不联网，仅按算法重算派生字段")
    ap.add_argument("--sync-html-fallback", action="store_true", help="同步刷新 etf-screener.html 内置兜底快照")
    ap.add_argument("--skip-fees", action="store_true", help="跳过基金概况（费率 / 季报规模）抓取，二者变动频率低")
    ap.add_argument("--skip-otc", action="store_true", help="跳过场外联接代码补全")
    ap.add_argument("--retries", type=int, default=3, help="单接口最大重试次数")
    ap.add_argument("--delay", type=float, default=2.0, help="重试基础间隔秒数（指数退避）")
    ap.add_argument("--sleep", type=float, default=0.3, help="接口调用间隔秒数，防止限流")
    ap.add_argument("--timeout", type=float, default=45.0, help="单次接口调用超时秒数（防止连接卡死）")
    args = ap.parse_args()

    if not JSON_PATH.exists():
        log(f"缺少基准数据 {JSON_PATH}，无法继续")
        return 1
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    log(f"载入基准：{len(data.get('etf_list', []))} 只 ETF，update_date={data.get('update_date')}")

    before = json.dumps(data, ensure_ascii=False, sort_keys=True)
    updated = 0
    if not args.offline:
        updated = collect(data, args)
        log(f"联网更新完成，成功写入 {updated} 组数据")
        if updated:
            data["data_source"] = "akshare"
            data["data_notes"] = "AKShare 抓取东方财富 / 乐咕乐股 / 中证指数等公开数据，部分失败字段沿用上一版"

    regime = recompute(data)
    log(f"市场周期判定：{regime} · {REGIME_NAMES[regime]} | ERP={data['macro_context'].get('erp')} "
        f"PE分位={data['macro_context'].get('hs300_pe_pct')} 趋势={data['macro_context'].get('trend_score')}")

    changed = json.dumps(data, ensure_ascii=False, sort_keys=True) != before
    if changed or not data.get("generated_at"):
        data["generated_at"] = datetime.now(CST).isoformat(timespec="seconds")
    elif not args.offline:
        warn("本次未获取到任何新数据（可能为非交易日或接口全部失败），数据文件保持不变")

    write_outputs(data)
    if args.sync_html_fallback:
        sync_html_fallback(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
