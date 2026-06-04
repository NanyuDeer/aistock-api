"""
风口爆发股 - 核心分析引擎（概念板块驱动版）

核心逻辑：
1. 从同花顺概念板块中筛选风口板块（十日上榜频次）
2. 根据概念板块成分股，判断强关联的二级行业
3. 展开强关联二级行业的上下游二级行业
4. 在二级行业中筛选股票，参考概念板块标签加分
"""

import json
import logging
import os
import time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

# 加载 .env 文件中的环境变量
_PROJECT_ROOT = Path(__file__).parent.parent.parent
_env_file = _PROJECT_ROOT / ".env"
if _env_file.exists():
    with open(_env_file, "r", encoding="utf-8") as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                _key = _key.strip()
                _val = _val.strip()
                if _key and _key not in os.environ:
                    os.environ[_key] = _val

import akshare as ak
import pandas as pd
import tushare as ts
import warnings

warnings.filterwarnings("ignore")
logger = logging.getLogger(__name__)

# ==================== Tushare 行情接口 ====================
_TUSHARE_TOKEN = os.getenv("TUSHARE_TOKEN", "")
_ts_pro = None


def _get_ts_pro():
    """获取 tushare pro 接口实例（懒加载）"""
    global _ts_pro
    if _ts_pro is None and _TUSHARE_TOKEN:
        try:
            ts.set_token(_TUSHARE_TOKEN)
            _ts_pro = ts.pro_api()
            logger.info("Tushare pro 接口初始化成功")
        except Exception as e:
            logger.warning("Tushare 初始化失败: %s", e)
    return _ts_pro


def get_stock_quotes(codes: list[str]) -> dict:
    """批量获取股票最新行情（价格、涨跌幅）

    Args:
        codes: 股票代码列表，如 ['002281', '000070']

    Returns:
        {code: {price: float, change_pct: float, pre_close: float}}
    """
    pro = _get_ts_pro()
    if not pro:
        logger.warning("Tushare 不可用，跳过行情获取")
        return {}

    cache_key = f"quotes_{'_'.join(sorted(codes[:20]))}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    # 获取最近的交易日期
    today = datetime.now()
    trade_date = None
    for offset in range(7):
        d = today - timedelta(days=offset)
        if d.weekday() < 5:  # 工作日
            trade_date = d.strftime("%Y%m%d")
            break

    if not trade_date:
        return {}

    result = {}
    try:
        # 将代码转为 tushare 格式 (如 002281.SZ)
        ts_codes = []
        code_map = {}
        for code in codes:
            if code.startswith(('6',)):
                ts_code = f"{code}.SH"
            else:
                ts_code = f"{code}.SZ"
            ts_codes.append(ts_code)
            code_map[ts_code] = code

        # 批量查询
        for i in range(0, len(ts_codes), 50):
            batch = ts_codes[i:i + 50]
            try:
                df = pro.daily(
                    ts_code=','.join(batch) if len(batch) <= 5 else None,
                    trade_date=trade_date if len(batch) > 5 else None,
                )
                if df is None or df.empty:
                    # 尝试逐个查询
                    for tc in batch:
                        try:
                            single_df = pro.daily(ts_code=tc, trade_date=trade_date)
                            if single_df is not None and not single_df.empty:
                                row = single_df.iloc[0]
                                c = code_map.get(tc, tc.split('.')[0])
                                result[c] = {
                                    'price': float(row['close']),
                                    'change_pct': float(row['pct_chg']) if 'pct_chg' in row else None,
                                    'pre_close': float(row['pre_close']) if 'pre_close' in row else None,
                                }
                        except Exception:
                            pass
                    continue

                for _, row in df.iterrows():
                    tc = row['ts_code']
                    c = code_map.get(tc, tc.split('.')[0])
                    if c in codes:
                        result[c] = {
                            'price': float(row['close']),
                            'change_pct': float(row['pct_chg']) if 'pct_chg' in row else None,
                            'pre_close': float(row['pre_close']) if 'pre_close' in row else None,
                        }
            except Exception as e:
                logger.warning("Tushare 批量行情查询失败: %s", e)
                # 逐个查询
                for tc in batch:
                    try:
                        single_df = pro.daily(ts_code=tc, trade_date=trade_date)
                        if single_df is not None and not single_df.empty:
                            row = single_df.iloc[0]
                            c = code_map.get(tc, tc.split('.')[0])
                            result[c] = {
                                'price': float(row['close']),
                                'change_pct': float(row['pct_chg']) if 'pct_chg' in row else None,
                                'pre_close': float(row['pre_close']) if 'pre_close' in row else None,
                            }
                    except Exception:
                        pass

            time.sleep(0.3)  # 避免请求过快

        if result:
            _cache_set(cache_key, result)
        logger.info("Tushare 行情获取完成: %d/%d 只股票", len(result), len(codes))

    except Exception as e:
        logger.error("Tushare 行情获取异常: %s", e)

    return result

# ==================== 缓存 ====================
_CACHE_DIR = Path(__file__).parent / "cache"
_CACHE_DIR.mkdir(exist_ok=True)
_CACHE_TTL = 3600  # 缓存1小时


def _cache_get(key: str) -> Optional[object]:
    fp = _CACHE_DIR / f"{key}.json"
    if fp.exists():
        mtime = fp.stat().st_mtime
        if time.time() - mtime < _CACHE_TTL:
            with open(fp, "r", encoding="utf-8") as f:
                return json.load(f)
    return None


def _cache_set(key: str, data: object) -> None:
    fp = _CACHE_DIR / f"{key}.json"
    with open(fp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, default=str)


# ==================== 同花顺板块数据 ====================

# 同花顺行业名称映射（部分行业在历史行情接口中使用不同名称）
INDUSTRY_NAME_MAP = {
    "计算机应用": "软件开发",
    "传媒": "互联网传媒",
    "汽车整车": "汽车",
    "石油加工": "石油加工贸易",
    "基础化工": "化工合成材料",
    "珠宝首饰": "家用轻工",
    "游戏": "互联网传媒",
    "环保": "环保工程",
    "建筑装饰": "建筑装饰",
    "化学制品": "化学制品",
    "医药生物": "医药商业",
}


def get_concept_boards() -> pd.DataFrame:
    """获取同花顺概念板块列表"""
    try:
        df = ak.stock_board_concept_name_ths()
        logger.info("获取概念板块列表: %d 个", len(df))
        return df
    except Exception as e:
        logger.error("获取概念板块列表失败: %s", e)
        return pd.DataFrame()


def get_concept_summary() -> pd.DataFrame:
    """获取同花顺概念板块摘要（含驱动事件、龙头股、成分股数量等）

    注意：该接口不直接返回涨跌幅，需通过 stock_board_concept_info_ths 获取
    """
    try:
        df = ak.stock_board_concept_summary_ths()
        logger.info("获取概念板块摘要: %d 个", len(df))
        return df
    except Exception as e:
        logger.error("获取概念板块摘要失败: %s", e)
        return pd.DataFrame()


def get_concept_info(concept_name: str) -> dict:
    """获取单个概念板块详情（板块涨幅、涨跌家数等）

    Returns:
        {"板块涨幅": 2.34, "涨跌家数": "141/38", ...}
    """
    cache_key = f"concept_info_{concept_name}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    try:
        df = ak.stock_board_concept_info_ths(symbol=concept_name)
        info = {}
        for _, row in df.iterrows():
            key = row["项目"]
            val = row["值"]
            # 解析板块涨幅（如 "2.34%" → 2.34）
            if key == "板块涨幅" and isinstance(val, str):
                val = float(val.replace("%", ""))
            # 解析涨跌家数（如 "141/38" → up=141, down=38）
            if key == "涨跌家数" and isinstance(val, str):
                parts = val.split("/")
                info["上涨家数"] = int(parts[0].strip()) if parts[0].strip().isdigit() else 0
                info["下跌家数"] = int(parts[1].strip()) if len(parts) > 1 and parts[1].strip().isdigit() else 0
            info[key.strip()] = val
        _cache_set(cache_key, info)
        return info
    except Exception as e:
        logger.warning("获取概念详情失败 %s: %s", concept_name, e)
        return {}


def get_industry_summary() -> pd.DataFrame:
    """获取同花顺行业板块行情摘要

    由于 stock_board_industry_summary_ths 接口不稳定，
    改用 stock_board_industry_info_ths 逐个获取并汇总
    """
    cache_key = "industry_summary"
    cached = _cache_get(cache_key)
    if cached:
        return pd.DataFrame(cached)

    try:
        # 获取行业名称列表
        industry_names = ak.stock_board_industry_name_ths()
        if industry_names.empty:
            return pd.DataFrame()

        rows = []
        for _, row in industry_names.iterrows():
            ind_name = row["name"]
            try:
                info_df = ak.stock_board_industry_info_ths(symbol=ind_name)
                info = {}
                for _, r in info_df.iterrows():
                    info[r["项目"]] = r["值"]
                rows.append(info)
                time.sleep(0.3)  # 避免请求过快
            except Exception:
                continue

        if not rows:
            return pd.DataFrame()

        result = pd.DataFrame(rows)
        _cache_set(cache_key, result.to_dict("records"))
        return result
    except Exception as e:
        logger.error("获取行业板块行情失败: %s", e)
        return pd.DataFrame()


def get_industry_info(industry_name: str) -> dict:
    """获取单个行业板块详情（板块涨幅、涨跌家数、资金净流入等）

    Returns:
        {"板块涨幅": 2.34, "涨跌家数": "141/38", "资金净流入(亿)": 42.47, ...}
    """
    cache_key = f"industry_info_{industry_name}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    try:
        df = ak.stock_board_industry_info_ths(symbol=industry_name)
        info = {}
        for _, row in df.iterrows():
            key = row["项目"].strip()
            val = row["值"]
            if key == "板块涨幅" and isinstance(val, str):
                val = float(val.replace("%", ""))
            if key == "涨跌家数" and isinstance(val, str):
                parts = val.split("/")
                info["上涨家数"] = int(parts[0].strip()) if parts[0].strip().isdigit() else 0
                info["下跌家数"] = int(parts[1].strip()) if len(parts) > 1 and parts[1].strip().isdigit() else 0
            if key == "资金净流入(亿)" and isinstance(val, str):
                try:
                    val = float(val)
                except ValueError:
                    val = 0
            info[key] = val
        _cache_set(cache_key, info)
        return info
    except Exception as e:
        logger.warning("获取行业详情失败 %s: %s", industry_name, e)
        return {}


def get_concept_cons(concept_name: str) -> pd.DataFrame:
    """获取概念板块成分股

    同花顺接口 stock_board_concept_cons_ths 已不可用，
    优先使用东方财富接口 stock_board_concept_cons_em
    """
    # 尝试东方财富接口
    for attempt in range(3):
        try:
            df = ak.stock_board_concept_cons_em(symbol=concept_name)
            if df is not None and not df.empty:
                logger.info("获取概念成分股(东方财富) %s: %d 只", concept_name, len(df))
                return df
        except Exception as e:
            logger.warning("东方财富概念成分股接口失败 %s (第%d次): %s", concept_name, attempt + 1, e)
            time.sleep(1)

    return pd.DataFrame()


def get_industry_cons(industry_name: str) -> pd.DataFrame:
    """获取行业板块成分股

    同花顺接口 stock_board_industry_cons_ths 已不可用，
    优先使用东方财富接口 stock_board_industry_cons_em
    """
    for attempt in range(3):
        try:
            df = ak.stock_board_industry_cons_em(symbol=industry_name)
            if df is not None and not df.empty:
                logger.info("获取行业成分股(东方财富) %s: %d 只", industry_name, len(df))
                return df
        except Exception as e:
            logger.warning("东方财富行业成分股接口失败 %s (第%d次): %s", industry_name, attempt + 1, e)
            time.sleep(1)

    return pd.DataFrame()


def get_board_history(board_name: str, board_type: str = "concept", days: int = 10) -> pd.DataFrame:
    """获取板块历史行情"""
    end_date = datetime.now().strftime("%Y%m%d")
    start_date = (datetime.now() - timedelta(days=days + 5)).strftime("%Y%m%d")

    try:
        query_name = INDUSTRY_NAME_MAP.get(board_name, board_name) if board_type == "industry" else board_name
        if board_type == "concept":
            df = ak.stock_board_concept_index_ths(symbol=query_name, start_date=start_date, end_date=end_date)
        else:
            df = ak.stock_board_industry_index_ths(symbol=query_name, start_date=start_date, end_date=end_date)

        if df.empty:
            return df

        df["涨跌幅"] = df["收盘价"].pct_change() * 100
        return df.tail(days)
    except Exception as e:
        logger.warning("获取板块历史行情失败 %s: %s", board_name, e)
        return pd.DataFrame()


# ==================== 风口概念板块识别 ====================

def identify_hot_concepts(top_n: int = 8, min_frequency: int = 3, days: int = 10) -> list[dict]:
    """识别风口概念板块

    逻辑：
    1. 获取概念板块摘要（含驱动事件、龙头股、成分股数量）
    2. 获取概念板块详情（板块涨幅、涨跌家数）
    3. 获取近10日历史行情，计算"上榜频次"（日涨幅 > 1% 的天数）
    4. 筛选上榜频次 >= min_frequency 的概念
    5. 综合评分排序，返回 top_n 个风口概念
    """
    cache_key = f"hot_concepts_{days}_{min_frequency}_{top_n}"
    cached = _cache_get(cache_key)
    if cached:
        logger.info("使用缓存的风口概念数据")
        return cached

    # 获取概念板块摘要
    concept_summary = get_concept_summary()
    if concept_summary.empty:
        return []

    # 摘要接口不含涨跌幅，需逐个获取概念详情
    # 先取摘要中成分股数量最多的前30个概念（通常更受关注）
    if "成分股数量" in concept_summary.columns:
        concept_summary["成分股数量"] = pd.to_numeric(concept_summary["成分股数量"], errors="coerce")
        concept_summary = concept_summary.sort_values("成分股数量", ascending=False)

    top_concepts = concept_summary.head(30)

    candidates = []
    for _, row in top_concepts.iterrows():
        concept_name = row["概念名称"]

        # 获取概念详情（含板块涨幅、涨跌家数）
        info = get_concept_info(concept_name)
        today_change = float(info.get("板块涨幅", 0))

        # 获取10日历史行情
        hist = get_board_history(concept_name, board_type="concept", days=days)
        if hist.empty or len(hist) < 3:
            continue

        # 计算上榜频次：10日内涨幅 > 1% 的天数
        up_days = len(hist[hist["涨跌幅"] > 1.0])
        avg_change = hist["涨跌幅"].mean()

        # 资金流入趋势
        if len(hist) >= 5 and "成交额" in hist.columns:
            recent_amount = hist.tail(5)["成交额"].mean()
            early_amount = hist.head(5)["成交额"].mean()
            amount_trend = (recent_amount / early_amount - 1) * 100 if early_amount > 0 else 0
        else:
            amount_trend = 0

        candidates.append({
            "name": concept_name,
            "type": "concept",
            "frequency": up_days,
            "avg_change": round(avg_change, 2),
            "today_change": round(today_change, 2),
            "amount_trend": round(amount_trend, 2),
            "driver": row.get("驱动事件", ""),
            "leading_stock": row.get("龙头股", "--"),
            "leading_change": 0,  # 摘要接口不含领涨股涨跌幅
            "up_count": info.get("上涨家数", 0),
            "down_count": info.get("下跌家数", 0),
        })

    # 筛选上榜频次 >= min_frequency
    hot_concepts = [c for c in candidates if c["frequency"] >= min_frequency]

    # 如果筛选后太少，降低条件
    if len(hot_concepts) < top_n:
        hot_concepts = [c for c in candidates if c["frequency"] >= max(1, min_frequency - 1)]

    # 综合评分：频次权重40% + 平均涨幅30% + 资金趋势30%
    for s in hot_concepts:
        s["score"] = round(
            s["frequency"] * 4 + s["avg_change"] * 3 + s["amount_trend"] * 0.3,
            2
        )

    hot_concepts.sort(key=lambda x: x["score"], reverse=True)
    result = hot_concepts[:top_n]

    _cache_set(cache_key, result)
    return result


# ==================== 概念→行业映射 ====================

def map_concept_to_industries(concept_name: str, top_n: int = 3) -> list[dict]:
    """根据概念板块成分股，判断强关联的二级行业

    逻辑：
    1. 获取概念板块成分股
    2. 获取所有行业板块成分股，统计概念成分股在各行业中的分布
    3. 按"重叠度"（概念股在该行业中的占比）排序
    4. 返回 top_n 个强关联行业

    如果成分股接口不可用，使用排名接口中的行业分布作为备选

    Returns:
        [{"name": "半导体", "overlap_count": 15, "overlap_ratio": 0.35, "stock_count": 43}]
    """
    cache_key = f"concept_industry_map_{concept_name}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    # 获取概念成分股
    concept_df = get_concept_cons(concept_name)

    if not concept_df.empty:
        # 成分股接口可用，使用成分股重叠度映射
        result = _map_by_constituent_overlap(concept_name, concept_df, top_n)
    else:
        # 成分股接口不可用，使用排名接口中的行业分布映射
        logger.info("概念 %s 成分股获取失败，使用排名接口映射行业", concept_name)
        result = _map_by_ranking_industry(concept_name, top_n)

    _cache_set(cache_key, result)
    return result


def _map_by_constituent_overlap(concept_name: str, concept_df: pd.DataFrame, top_n: int = 3) -> list[dict]:
    """通过成分股重叠度映射概念→行业"""
    # 统一列名（东方财富返回的列名）
    code_col = "代码" if "代码" in concept_df.columns else "股票代码"
    name_col = "名称" if "名称" in concept_df.columns else "股票简称"
    concept_codes = set(concept_df[code_col].astype(str).str.zfill(6).tolist())

    logger.info("概念 %s 成分股: %d 只", concept_name, len(concept_codes))

    # 获取行业板块列表
    try:
        industry_names_df = ak.stock_board_industry_name_ths()
    except Exception:
        return []

    # 逐行业检查成分股重叠
    industry_overlaps = []
    for _, ind_row in industry_names_df.iterrows():
        industry_name = ind_row["name"]

        # 获取行业成分股
        ind_cons = get_industry_cons(industry_name)
        if ind_cons.empty:
            continue

        ind_code_col = "代码" if "代码" in ind_cons.columns else "股票代码"
        ind_codes = set(ind_cons[ind_code_col].astype(str).str.zfill(6).tolist())

        # 计算重叠
        overlap = concept_codes & ind_codes
        overlap_count = len(overlap)
        if overlap_count == 0:
            continue

        overlap_ratio = overlap_count / len(concept_codes) if concept_codes else 0
        industry_stock_count = len(ind_codes)

        industry_overlaps.append({
            "name": industry_name,
            "overlap_count": overlap_count,
            "overlap_ratio": round(overlap_ratio, 3),
            "stock_count": industry_stock_count,
            "overlap_codes": list(overlap),
        })

    # 按重叠度排序
    industry_overlaps.sort(key=lambda x: (x["overlap_count"], x["overlap_ratio"]), reverse=True)
    return industry_overlaps[:top_n]


def _map_by_ranking_industry(concept_name: str, top_n: int = 3) -> list[dict]:
    """当成分股接口不可用时，通过排名接口中的行业分布映射概念→行业

    逻辑：从连续上涨和持续放量排名中，找出属于该概念相关行业的股票分布
    """
    industry_counter = Counter()

    # 从连续上涨排名中统计行业分布
    try:
        ljqs_df = ak.stock_rank_ljqs_ths()
        if not ljqs_df.empty:
            # 获取概念摘要中的龙头股
            concept_summary = get_concept_summary()
            concept_row = concept_summary[concept_summary["概念名称"] == concept_name]
            leading_stock = concept_row.iloc[0].get("龙头股", "") if not concept_row.empty else ""

            # 统计所有行业的上榜股票数
            for _, row in ljqs_df.iterrows():
                industry = row.get("所属行业", "")
                if industry:
                    industry_counter[industry] += 1
    except Exception as e:
        logger.warning("获取连续上涨排名失败: %s", e)

    # 从持续放量排名中统计行业分布
    try:
        cxfl_df = ak.stock_rank_cxfl_ths()
        if not cxfl_df.empty:
            for _, row in cxfl_df.iterrows():
                industry = row.get("所属行业", "")
                if industry:
                    industry_counter[industry] += 1
    except Exception as e:
        logger.warning("获取持续放量排名失败: %s", e)

    # 按上榜频次排序
    top_industries = industry_counter.most_common(top_n * 2)

    result = []
    for ind_name, count in top_industries:
        # 获取行业详情
        info = get_industry_info(ind_name)
        result.append({
            "name": ind_name,
            "overlap_count": count,
            "overlap_ratio": round(count / max(sum(industry_counter.values()), 1), 3),
            "stock_count": 0,  # 未知
            "overlap_codes": [],
        })

    return result[:top_n]


# ==================== 产业链上下游 ====================

# 产业链上下游关系映射（基于同花顺二级行业分类）
INDUSTRY_CHAIN = {
    "半导体": {
        "upstream": ["电子化学品", "金属新材料", "小金属"],
        "downstream": ["消费电子", "计算机设备", "通信设备", "汽车零部件"],
    },
    "元件": {
        "upstream": ["电子化学品", "半导体", "金属新材料"],
        "downstream": ["消费电子", "通信设备", "计算机设备"],
    },
    "通信设备": {
        "upstream": ["半导体", "元件", "金属新材料"],
        "downstream": ["计算机设备", "传媒", "游戏"],
    },
    "贵金属": {
        "upstream": ["工业金属", "小金属"],
        "downstream": ["珠宝首饰", "半导体"],
    },
    "小金属": {
        "upstream": ["工业金属", "金属新材料"],
        "downstream": ["半导体", "电力设备", "汽车零部件"],
    },
    "自动化设备": {
        "upstream": ["半导体", "元件", "通用设备"],
        "downstream": ["汽车零部件", "电力设备"],
    },
    "计算机设备": {
        "upstream": ["半导体", "元件", "通信设备"],
        "downstream": ["计算机应用", "传媒"],
    },
    "电力设备": {
        "upstream": ["半导体", "元件", "金属新材料", "小金属"],
        "downstream": ["环保", "建筑装饰"],
    },
    "汽车零部件": {
        "upstream": ["半导体", "元件", "金属新材料", "自动化设备"],
        "downstream": ["汽车整车"],
    },
    "消费电子": {
        "upstream": ["半导体", "元件", "电子化学品"],
        "downstream": ["计算机应用", "传媒"],
    },
    "电子化学品": {
        "upstream": ["化学制品", "工业金属"],
        "downstream": ["半导体", "元件"],
    },
    "金属新材料": {
        "upstream": ["工业金属", "小金属"],
        "downstream": ["半导体", "元件", "电力设备"],
    },
    "工业金属": {
        "upstream": ["小金属", "贵金属"],
        "downstream": ["金属新材料", "半导体", "电力设备"],
    },
    "化学制品": {
        "upstream": ["石油加工", "基础化工"],
        "downstream": ["电子化学品", "医药生物"],
    },
    "计算机应用": {
        "upstream": ["计算机设备", "通信设备"],
        "downstream": ["传媒", "游戏"],
    },
    "煤炭开采加工": {
        "upstream": ["石油加工"],
        "downstream": ["电力", "钢铁", "化学制品"],
    },
    "电力": {
        "upstream": ["煤炭开采加工", "电力设备"],
        "downstream": ["钢铁", "化学制品", "有色金属"],
    },
    "钢铁": {
        "upstream": ["煤炭开采加工", "工业金属"],
        "downstream": ["建筑装饰", "汽车零部件", "通用设备"],
    },
    "通用设备": {
        "upstream": ["钢铁", "金属新材料", "自动化设备"],
        "downstream": ["汽车零部件", "电力设备", "环保"],
    },
    "光学光电子": {
        "upstream": ["半导体", "元件", "电子化学品"],
        "downstream": ["消费电子", "计算机设备"],
    },
    "国防军工": {
        "upstream": ["半导体", "元件", "金属新材料", "自动化设备"],
        "downstream": ["通信设备", "计算机设备"],
    },
    "医药生物": {
        "upstream": ["化学制品", "中药"],
        "downstream": ["医疗器械", "医疗服务"],
    },
    "中药": {
        "upstream": ["化学制品"],
        "downstream": ["医药生物"],
    },
    "医疗器械": {
        "upstream": ["半导体", "元件", "自动化设备"],
        "downstream": ["医药生物", "医疗服务"],
    },
    "传媒": {
        "upstream": ["计算机应用", "通信设备"],
        "downstream": ["游戏", "互联网传媒"],
    },
    "游戏": {
        "upstream": ["传媒", "计算机应用"],
        "downstream": ["互联网传媒"],
    },
    "互联网传媒": {
        "upstream": ["传媒", "计算机应用", "通信设备"],
        "downstream": [],
    },
    "环保": {
        "upstream": ["电力设备", "通用设备"],
        "downstream": ["建筑装饰"],
    },
    "建筑装饰": {
        "upstream": ["钢铁", "环保"],
        "downstream": [],
    },
    "汽车整车": {
        "upstream": ["汽车零部件", "自动化设备"],
        "downstream": [],
    },
}


def get_upstream_downstream(industry_name: str) -> dict:
    """获取行业的上下游行业列表"""
    chain = INDUSTRY_CHAIN.get(industry_name, {"upstream": [], "downstream": []})
    return chain


def calculate_transmission_factor(sector_name: str, related_industries: list[str]) -> dict:
    """计算板块间传导因子

    基于风口概念关联的二级行业，展开上下游并计算传导因子

    Args:
        sector_name: 风口概念名称
        related_industries: 强关联的二级行业列表

    Returns:
        {
            "related_industries": [{"name": "半导体", "overlap_count": 15, ...}],
            "upstream": [{"name": "电子化学品", "factor": 0.85, "source_industry": "半导体"}],
            "downstream": [{"name": "消费电子", "factor": 0.72, "source_industry": "半导体"}]
        }
    """
    # 获取风口概念的历史行情
    main_hist = get_board_history(sector_name, board_type="concept", days=10)

    result = {"upstream": [], "downstream": []}

    # 收集所有上下游行业（去重）
    upstream_set = {}  # name -> source_industry
    downstream_set = {}

    for ind_name in related_industries:
        chain = get_upstream_downstream(ind_name)
        for up in chain.get("upstream", []):
            if up not in related_industries and up not in upstream_set:
                upstream_set[up] = ind_name
        for down in chain.get("downstream", []):
            if down not in related_industries and down not in downstream_set:
                downstream_set[down] = ind_name

    # 计算传导因子
    for direction, industry_set in [("upstream", upstream_set), ("downstream", downstream_set)]:
        position_weight = 0.4 if direction == "upstream" else 0.3

        for ind_name, source_industry in industry_set.items():
            if main_hist.empty:
                factor = round(position_weight * 0.7, 3)
            else:
                main_changes = main_hist["涨跌幅"].values
                related_hist = get_board_history(ind_name, board_type="industry", days=10)

                if related_hist.empty:
                    factor = round(position_weight * 0.7, 3)
                else:
                    related_changes = related_hist["涨跌幅"].values
                    min_len = min(len(main_changes), len(related_changes))

                    if min_len >= 3:
                        correlation = pd.Series(main_changes[:min_len]).corr(
                            pd.Series(related_changes[:min_len])
                        )
                        correlation = abs(correlation) if not pd.isna(correlation) else 0.3
                    else:
                        correlation = 0.3

                    # 资金流向相关性
                    if "成交额" in main_hist.columns and "成交额" in related_hist.columns and min_len >= 3:
                        main_amounts = main_hist["成交额"].values[:min_len]
                        related_amounts = related_hist["成交额"].values[:min_len]
                        amount_corr = pd.Series(main_amounts).corr(pd.Series(related_amounts))
                        amount_corr = abs(amount_corr) if not pd.isna(amount_corr) else 0.3
                    else:
                        amount_corr = 0.3

                    factor = round(
                        position_weight * 0.4 + correlation * 0.35 + amount_corr * 0.25,
                        3
                    )

            result[direction].append({
                "name": ind_name,
                "factor": factor,
                "direction": direction,
                "source_industry": source_industry,
            })

    # 按传导因子排序
    result["upstream"].sort(key=lambda x: x["factor"], reverse=True)
    result["downstream"].sort(key=lambda x: x["factor"], reverse=True)

    return result


# ==================== AI生成产业链 ====================

def ai_generate_industry_chain(
    concept_name: str,
    related_industries: list[str],
    concept_data: dict,
) -> dict:
    """调用AI根据同花顺A股二级行业分类，生成概念板块的产业链流向图

    逻辑：
    1. 告诉AI该风口概念和强关联的1-2个二级行业
    2. 让AI找出1-3个上游二级行业和1-3个下游二级行业，并给出传导权重(0-1)
    3. AI不可用时fallback到硬编码INDUSTRY_CHAIN

    Returns:
        {
            "related_industries": [{"name": "半导体", "overlap_count": 15, "overlap_ratio": 0.35}],
            "upstream": [{"name": "电子化学品", "factor": 0.85, "source_industry": "半导体"}],
            "downstream": [{"name": "消费电子", "factor": 0.72, "source_industry": "半导体"}]
        }
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    raw_base = os.getenv("OPENAI_API_BASE_URL", os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"))
    # 去掉末尾的 /chat/completions，OpenAI SDK 会自动拼接
    api_base = raw_base.replace("/chat/completions", "").rstrip("/")
    model = os.getenv("AI_MODEL", "openai")

    if not api_key:
        logger.warning("未配置OPENAI_API_KEY，使用硬编码产业链")
        return _fallback_industry_chain(concept_name, related_industries)

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=api_base)

        prompt = f"""你是一位资深A股产业链分析师，熟悉同花顺A股二级行业分类体系。

## 任务
根据以下风口概念板块信息，分析其产业链上下游关系。

## 概念板块数据
- 概念名称：{concept_name}
- 近10日上榜频次：{concept_data.get('frequency', 0)}天
- 平均涨幅：{concept_data.get('avg_change', 0)}%
- 今日涨幅：{concept_data.get('today_change', 0)}%
- 驱动事件：{concept_data.get('driver', '未知')}

## 已识别的强关联二级行业
{json.dumps(related_industries, ensure_ascii=False)}

## 要求
1. 从强关联行业中选出1-2个最核心的二级行业作为产业链中游
2. 找出1-3个上游二级行业（原材料/设备/技术供给端），并给出传导权重(0.1-1.0)
3. 找出1-3个下游二级行业（需求端/应用端），并给出传导权重(0.1-1.0)
4. 行业名称必须是同花顺A股二级行业分类中的标准名称
5. 权重反映该行业与概念板块的关联强度和传导效应大小

## 同花顺常见二级行业参考
半导体、元件、电子化学品、金属新材料、小金属、工业金属、贵金属、
消费电子、计算机设备、通信设备、计算机应用、传媒、游戏、互联网传媒、
自动化设备、电力设备、汽车零部件、汽车整车、化学制品、医药生物、
中药、医疗器械、医疗服务、光学光电子、国防军工、通用设备、
环保、建筑装饰、钢铁、煤炭开采加工、电力、石油加工、
白色家电、饮料制造、食品加工、养殖、种植业、银行、保险、证券、房地产

请以JSON格式返回，格式如下：
{{
  "core_industries": ["半导体"],
  "upstream": [
    {{"name": "电子化学品", "factor": 0.85, "source_industry": "半导体", "reason": "提供光刻胶等关键材料"}},
    {{"name": "金属新材料", "factor": 0.72, "source_industry": "半导体", "reason": "提供硅片等基础材料"}}
  ],
  "downstream": [
    {{"name": "消费电子", "factor": 0.80, "source_industry": "半导体", "reason": "芯片主要应用端"}},
    {{"name": "通信设备", "factor": 0.65, "source_industry": "半导体", "reason": "通信芯片需求"}}
  ]
}}

只返回JSON，不要其他文字。"""

        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=800,
            timeout=60,
        )

        content = response.choices[0].message.content.strip()
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]

        ai_result = json.loads(content.strip())

        # 转换为统一格式
        result = {
            "related_industries": [
                {"name": name if isinstance(name, str) else name.get("name", str(name)), "overlap_count": 0, "overlap_ratio": 0.5}
                for name in ai_result.get("core_industries", related_industries[:2])
            ],
            "upstream": [
                {
                    "name": u["name"],
                    "factor": float(u.get("factor", 0.5)),
                    "direction": "upstream",
                    "source_industry": u.get("source_industry", related_industries[0] if related_industries else ""),
                    "reason": u.get("reason", ""),
                }
                for u in ai_result.get("upstream", [])
            ],
            "downstream": [
                {
                    "name": d["name"],
                    "factor": float(d.get("factor", 0.5)),
                    "direction": "downstream",
                    "source_industry": d.get("source_industry", related_industries[0] if related_industries else ""),
                    "reason": d.get("reason", ""),
                }
                for d in ai_result.get("downstream", [])
            ],
        }

        logger.info(
            "AI产业链生成完成: %s → 核心%s, 上游%s, 下游%s",
            concept_name,
            [r["name"] for r in result["related_industries"]],
            [u["name"] for u in result["upstream"]],
            [d["name"] for d in result["downstream"]],
        )
        return result

    except Exception as e:
        logger.error("AI产业链生成失败: %s，使用硬编码产业链", e)
        return _fallback_industry_chain(concept_name, related_industries)


def _fallback_industry_chain(concept_name: str, related_industries: list[str]) -> dict:
    """AI不可用时，使用硬编码INDUSTRY_CHAIN作为备选"""
    upstream_set = {}
    downstream_set = {}

    for ind_name in related_industries:
        chain = get_upstream_downstream(ind_name)
        for up in chain.get("upstream", []):
            if up not in related_industries and up not in upstream_set:
                upstream_set[up] = ind_name
        for down in chain.get("downstream", []):
            if down not in related_industries and down not in downstream_set:
                downstream_set[down] = ind_name

    result = {
        "related_industries": [
            {"name": name, "overlap_count": 0, "overlap_ratio": 0.5}
            for name in related_industries[:2]
        ],
        "upstream": [
            {
                "name": name,
                "factor": round(0.4 + 0.1 * i, 3),
                "direction": "upstream",
                "source_industry": source,
            }
            for i, (name, source) in enumerate(upstream_set.items())
        ][:3],
        "downstream": [
            {
                "name": name,
                "factor": round(0.4 + 0.1 * i, 3),
                "direction": "downstream",
                "source_industry": source,
            }
            for i, (name, source) in enumerate(downstream_set.items())
        ][:3],
    }
    return result


def _refine_transmission_factors(sector_name: str, industry_chain: dict) -> dict:
    """基于AI生成的产业链，用实际行情数据修正传导权重

    AI给出初始权重，再用历史行情相关性进行修正
    """
    main_hist = get_board_history(sector_name, board_type="concept", days=10)

    result = {
        "upstream": industry_chain.get("upstream", [])[:3],
        "downstream": industry_chain.get("downstream", [])[:3],
    }

    for direction in ("upstream", "downstream"):
        for item in result[direction]:
            ai_factor = item.get("factor", 0.5)
            ind_name = item["name"]

            if main_hist.empty:
                item["factor"] = round(ai_factor * 0.8, 3)
                continue

            main_changes = main_hist["涨跌幅"].values
            related_hist = get_board_history(ind_name, board_type="industry", days=10)

            if related_hist.empty:
                item["factor"] = round(ai_factor * 0.8, 3)
                continue

            related_changes = related_hist["涨跌幅"].values
            min_len = min(len(main_changes), len(related_changes))

            if min_len >= 3:
                correlation = abs(pd.Series(main_changes[:min_len]).corr(
                    pd.Series(related_changes[:min_len])
                ))
                if pd.isna(correlation):
                    correlation = 0.3
            else:
                correlation = 0.3

            # 资金流向相关性
            amount_corr = 0.3
            if "成交额" in main_hist.columns and "成交额" in related_hist.columns and min_len >= 3:
                main_amounts = main_hist["成交额"].values[:min_len]
                related_amounts = related_hist["成交额"].values[:min_len]
                ac = pd.Series(main_amounts).corr(pd.Series(related_amounts))
                if not pd.isna(ac):
                    amount_corr = abs(ac)

            # 综合权重：AI初始权重50% + 行情相关性30% + 资金相关性20%
            refined = ai_factor * 0.5 + correlation * 0.3 + amount_corr * 0.2
            item["factor"] = round(min(refined, 1.0), 3)

    # 按传导因子排序
    result["upstream"].sort(key=lambda x: x["factor"], reverse=True)
    result["downstream"].sort(key=lambda x: x["factor"], reverse=True)

    return result


# ==================== AI判断持续性 ====================

def ai_analyze_sector(sector_name: str, sector_data: dict, transmission: dict) -> dict:
    """调用AI判断风口板块的持续性和热度传递"""
    api_key = os.getenv("OPENAI_API_KEY", "")
    raw_base = os.getenv("OPENAI_API_BASE_URL", os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"))
    api_base = raw_base.replace("/chat/completions", "").rstrip("/")
    model = os.getenv("AI_MODEL", "openai")

    if not api_key:
        logger.warning("未配置OPENAI_API_KEY，使用规则引擎判断")
        return _rule_based_analysis(sector_name, sector_data, transmission)

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=api_base)

        prompt = f"""你是一位资深A股市场分析师。请根据以下数据，分析该风口概念板块的持续性和热度传递。

## 概念板块数据
- 概念名称：{sector_name}
- 近10日上榜频次：{sector_data.get('frequency', 0)}天
- 平均涨幅：{sector_data.get('avg_change', 0)}%
- 今日涨幅：{sector_data.get('today_change', 0)}%
- 资金趋势：{sector_data.get('amount_trend', 0)}%
- 驱动事件：{sector_data.get('driver', '未知')}
- 上涨家数/下跌家数：{sector_data.get('up_count', 0)}/{sector_data.get('down_count', 0)}

## 上下游传导
- 上游：{json.dumps(transmission.get('upstream', []), ensure_ascii=False)}
- 下游：{json.dumps(transmission.get('downstream', []), ensure_ascii=False)}

请以JSON格式返回分析结果，包含以下字段：
1. persistence: 持续时间判断，值为"短期(1-3天)"/"中期(1-2周)"/"长期(1月+)"
2. persistence_reason: 持续性判断理由（50字以内）
3. heat_transfer: 热度是否会在板块间传递，true/false
4. transfer_direction: 传递方向
5. transfer_reason: 传递判断理由（50字以内）
6. risk_warning: 风险提示（30字以内）

只返回JSON，不要其他文字。"""

        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=500,
            timeout=60,
        )

        content = response.choices[0].message.content.strip()
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]

        return json.loads(content.strip())

    except Exception as e:
        logger.error("AI分析失败: %s，使用规则引擎", e)
        return _rule_based_analysis(sector_name, sector_data, transmission)


def _rule_based_analysis(sector_name: str, sector_data: dict, transmission: dict) -> dict:
    """基于规则的分析（AI不可用时的备选）"""
    freq = sector_data.get("frequency", 0)
    avg_change = sector_data.get("avg_change", 0)
    amount_trend = sector_data.get("amount_trend", 0)

    if freq >= 6 and avg_change > 2 and amount_trend > 10:
        persistence = "长期(1月+)"
        reason = "高频上榜+持续放量+资金加速流入，趋势强劲"
    elif freq >= 4 and avg_change > 1:
        persistence = "中期(1-2周)"
        reason = "中频上榜+涨幅稳定，有一定持续性"
    else:
        persistence = "短期(1-3天)"
        reason = "上榜频次较低或资金流出，持续性存疑"

    upstream_factors = [u["factor"] for u in transmission.get("upstream", [])]
    downstream_factors = [d["factor"] for d in transmission.get("downstream", [])]
    max_up = max(upstream_factors) if upstream_factors else 0
    max_down = max(downstream_factors) if downstream_factors else 0

    if max_up > 0.5 or max_down > 0.5:
        heat_transfer = True
        if max_up > max_down:
            direction = "上游→中游"
            transfer_reason = "上游传导因子较高，原材料端先行启动"
        else:
            direction = "中游→下游"
            transfer_reason = "下游传导因子较高，需求端拉动效应明显"
    else:
        heat_transfer = False
        direction = "无明显传递"
        transfer_reason = "上下游传导因子均较低，板块联动性弱"

    risk = "追高风险较大，注意板块轮动节奏" if freq < 4 else "关注量能变化，缩量需警惕"

    return {
        "persistence": persistence,
        "persistence_reason": reason,
        "heat_transfer": heat_transfer,
        "transfer_direction": direction,
        "transfer_reason": transfer_reason,
        "risk_warning": risk,
    }


# ==================== 选股打分 ====================

def select_stocks_from_industry(
    industry_name: str,
    concept_name: str = "",
    concept_codes: set = None,
    concept_names: set = None,
    max_stocks: int = 3,
) -> list[dict]:
    """从二级行业中筛选股票

    多因子打分 + 概念标签加分：
    1. 连续上涨天数（stock_rank_ljqs_ths）
    2. 持续放量（stock_rank_cxfl_ths）
    3. 板块内领涨股
    4. 概念标签加分：如果该股票也在风口概念板块中，额外加分

    Args:
        industry_name: 行业名称
        concept_name: 风口概念名称（用于概念标签加分）
        concept_codes: 概念成分股代码集合（用于代码精确匹配）
        concept_names: 概念成分股名称集合（用于名称精确匹配）
        max_stocks: 最多返回几只
    """
    if concept_codes is None:
        concept_codes = set()
    if concept_names is None:
        concept_names = set()

    stocks = []
    mapped_name = INDUSTRY_NAME_MAP.get(industry_name, industry_name)
    match_names = [industry_name]
    if mapped_name != industry_name:
        match_names.append(mapped_name)

    # 1. 从行业详情中获取领涨股信息
    # 使用 get_industry_info 获取行业详情
    ind_info = get_industry_info(industry_name)
    if ind_info:
        # 行业详情中无领涨股字段，跳过，改用排名接口
        pass

    # 2. 从连续上涨排名中筛选
    try:
        ljqs_df = ak.stock_rank_ljqs_ths()
        if not ljqs_df.empty:
            sector_stocks = ljqs_df[ljqs_df["所属行业"].isin(match_names)]
            for _, row in sector_stocks.head(3).iterrows():
                name = row["股票简称"]
                if any(s["name"] == name for s in stocks):
                    continue
                days = int(row.get("量价齐升天数", 0))
                gain = float(row.get("阶段涨幅", 0))
                turnover = float(row.get("累计换手率", 0))
                base_score = min(90, days * 8 + min(gain, 20) * 2 + min(turnover, 50) * 0.5)
                concept_bonus = 10 if _stock_in_concept(name, concept_codes, concept_names) else 0
                concept_tag = "概念共振" if concept_bonus > 0 else ""
                stocks.append({
                    "code": row["股票代码"],
                    "name": name,
                    "industry": industry_name,
                    "score": round(base_score + concept_bonus, 1),
                    "reason": f"连续{days}天量价齐升，阶段涨幅{gain:.1f}%",
                    "reason_tag": concept_tag or "量价齐升",
                    "reason_tag_class": "tag-bullish" if concept_bonus > 0 else "tag-trend",
                    "source": "连续上涨",
                    "in_concept": concept_bonus > 0,
                })
    except Exception as e:
        logger.warning("获取连续上涨排名失败: %s", e)

    # 3. 从持续放量排名中筛选
    try:
        cxfl_df = ak.stock_rank_cxfl_ths()
        if not cxfl_df.empty:
            sector_stocks = cxfl_df[cxfl_df["所属行业"].isin(match_names)]
            for _, row in sector_stocks.head(2).iterrows():
                name = row["股票简称"]
                if any(s["name"] == name for s in stocks):
                    continue
                vol_days = int(row.get("放量天数", 0))
                gain = float(row.get("阶段涨跌幅", 0))
                base_score = min(85, vol_days * 7 + min(gain, 15) * 2)
                concept_bonus = 10 if _stock_in_concept(name, concept_codes, concept_names) else 0
                concept_tag = "概念共振" if concept_bonus > 0 else ""
                stocks.append({
                    "code": row["股票代码"],
                    "name": name,
                    "industry": industry_name,
                    "score": round(base_score + concept_bonus, 1),
                    "reason": f"持续放量{vol_days}天，阶段涨幅{gain:.1f}%",
                    "reason_tag": concept_tag or "持续放量",
                    "reason_tag_class": "tag-bullish" if concept_bonus > 0 else "tag-fund",
                    "source": "持续放量",
                    "in_concept": concept_bonus > 0,
                })
    except Exception as e:
        logger.warning("获取持续放量排名失败: %s", e)

    # 按评分排序
    stocks.sort(key=lambda x: x["score"], reverse=True)
    return stocks[:max_stocks]


def _stock_in_concept(stock_name: str, concept_codes: set, concept_names: set = None) -> bool:
    """检查股票是否在概念成分股中

    优先通过名称精确匹配，其次通过代码匹配
    """
    if concept_names and stock_name in concept_names:
        return True
    return False


def _stock_in_concept_by_code(stock_code: str, concept_codes: set) -> bool:
    """通过股票代码精确匹配是否在概念成分股中"""
    return stock_code.zfill(6) in concept_codes


# ==================== 完整分析流程 ====================

def run_full_analysis() -> dict:
    """执行完整的风口爆发股分析流程

    流程：
    1. 从概念板块中识别风口概念
    2. 根据概念成分股映射强关联二级行业
    3. 展开上下游二级行业
    4. 计算传导因子
    5. AI判断持续性
    6. 在各行业中选股（概念标签加分）
    7. 构建层级流向图
    """
    logger.info("开始执行风口爆发股分析...")

    # 1. 识别风口概念板块
    hot_concepts = identify_hot_concepts(top_n=8, min_frequency=3, days=10)
    if not hot_concepts:
        logger.warning("未识别到风口概念，降低筛选条件重试")
        hot_concepts = identify_hot_concepts(top_n=8, min_frequency=2, days=10)

    result = {
        "update_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "hot_sectors": [],
    }

    for concept in hot_concepts:
        concept_name = concept["name"]
        logger.info("分析风口概念: %s", concept_name)

        # 2. 映射强关联二级行业
        related_industries = map_concept_to_industries(concept_name, top_n=3)
        related_ind_names = [r["name"] for r in related_industries]

        # 获取概念成分股代码和名称集合（用于选股时概念标签加分）
        concept_cons_df = get_concept_cons(concept_name)
        concept_codes = set()
        concept_names = set()
        if not concept_cons_df.empty:
            code_col = "代码" if "代码" in concept_cons_df.columns else "股票代码"
            name_col = "名称" if "名称" in concept_cons_df.columns else "股票简称"
            concept_codes = set(concept_cons_df[code_col].astype(str).str.zfill(6).tolist())
            concept_names = set(concept_cons_df[name_col].astype(str).tolist())
        else:
            # 成分股接口不可用时，从概念摘要中获取龙头股名称作为概念标签参考
            concept_summary = get_concept_summary()
            if not concept_summary.empty:
                concept_row = concept_summary[concept_summary["概念名称"] == concept_name]
                if not concept_row.empty:
                    leading = concept_row.iloc[0].get("龙头股", "")
                    if leading and leading != "--":
                        concept_names.add(leading)
            logger.info("概念 %s 成分股不可用，龙头股补充: %s", concept_name, concept_names)

        # 3. AI生成产业链（上下游行业+传导权重）
        industry_chain = ai_generate_industry_chain(concept_name, related_ind_names, concept)

        # 用AI生成的核心行业替换原来的related_industries（如果AI返回了核心行业）
        if industry_chain.get("related_industries"):
            ai_core_names = [r["name"] for r in industry_chain["related_industries"]]
            # 保留原始overlap信息，用AI核心行业补充
            for ai_core in industry_chain["related_industries"]:
                if ai_core["name"] not in related_ind_names:
                    related_industries.append(ai_core)
                    related_ind_names.append(ai_core["name"])

        # 4. 计算传导因子（基于AI生成的产业链，用行情数据计算实际传导权重）
        transmission = _refine_transmission_factors(concept_name, industry_chain)

        # 5. AI判断持续性
        ai_analysis = ai_analyze_sector(concept_name, concept, transmission)

        # 6. 选股 - 强关联行业（风口精选）
        main_stocks = []
        for ind in related_industries:
            ind_stocks = select_stocks_from_industry(
                ind["name"],
                concept_name=concept_name,
                concept_codes=concept_codes,
                concept_names=concept_names,
                max_stocks=2,
            )
            for s in ind_stocks:
                s["chain_position"] = "核心"
                s["related_industry"] = ind["name"]
                s["overlap_ratio"] = ind["overlap_ratio"]
            main_stocks.extend(ind_stocks)

        # 去重（同一股票可能出现在多个行业中）
        seen_names = set()
        unique_main = []
        for s in main_stocks:
            if s["name"] not in seen_names:
                seen_names.add(s["name"])
                unique_main.append(s)
        main_stocks = unique_main[:5]  # 最多5只

        # 6. 选股 - 上下游行业
        upstream_stocks = []
        for up in transmission.get("upstream", [])[:2]:
            stocks = select_stocks_from_industry(
                up["name"],
                concept_name=concept_name,
                concept_codes=concept_codes,
                concept_names=concept_names,
                max_stocks=2,
            )
            for s in stocks:
                s["chain_position"] = "上游"
                s["transmission_factor"] = up["factor"]
                s["source_industry"] = up.get("source_industry", "")
            upstream_stocks.extend(stocks)

        downstream_stocks = []
        for down in transmission.get("downstream", [])[:2]:
            stocks = select_stocks_from_industry(
                down["name"],
                concept_name=concept_name,
                concept_codes=concept_codes,
                concept_names=concept_names,
                max_stocks=2,
            )
            for s in stocks:
                s["chain_position"] = "下游"
                s["transmission_factor"] = down["factor"]
                s["source_industry"] = down.get("source_industry", "")
            downstream_stocks.extend(stocks)

        # 7. 构建层级流向图数据
        flow_data = _build_flow_data(concept_name, related_industries, transmission, ai_analysis)

        # 获取概念板块的行业行情数据用于展示
        industry_data = _get_industry_stats(related_ind_names)

        # 8. 提取龙头股信息（用于一级窗口表格展示）
        leading_stock_info = _extract_leading_stock(
            concept_name, concept, main_stocks, concept_codes, concept_names
        )

        sector_result = {
            "name": concept_name,
            "type": "concept",
            "frequency": concept["frequency"],
            "avg_change": concept["avg_change"],
            "today_change": concept["today_change"],
            "amount_trend": concept["amount_trend"],
            "score": concept.get("score", 0),
            "leading_stock": concept["leading_stock"],
            "leading_change": concept["leading_change"],
            "up_count": concept["up_count"],
            "down_count": concept["down_count"],
            "driver": concept.get("driver", ""),
            "related_industries": related_ind_names,
            "industry_data": industry_data,
            "ai_analysis": ai_analysis,
            "main_stocks": main_stocks,
            "upstream_stocks": upstream_stocks,
            "downstream_stocks": downstream_stocks,
            "flow_data": flow_data,
            "leading_stock_info": leading_stock_info,
        }

        result["hot_sectors"].append(sector_result)

    # 批量获取所有股票的行情数据（价格、涨跌幅）
    all_codes = set()
    for sector in result["hot_sectors"]:
        for stock_list_key in ("main_stocks", "upstream_stocks", "downstream_stocks"):
            for s in sector.get(stock_list_key, []):
                if s.get("code"):
                    all_codes.add(s["code"])
        lsi = sector.get("leading_stock_info")
        if lsi and lsi.get("code"):
            all_codes.add(lsi["code"])

    if all_codes:
        logger.info("开始批量获取 %d 只股票的行情数据...", len(all_codes))
        quotes = get_stock_quotes(list(all_codes))
        # 填充行情数据到股票和龙头股信息
        for sector in result["hot_sectors"]:
            for stock_list_key in ("main_stocks", "upstream_stocks", "downstream_stocks"):
                for s in sector.get(stock_list_key, []):
                    q = quotes.get(s.get("code", ""))
                    if q:
                        s["price"] = q.get("price")
                        s["change_pct"] = q.get("change_pct")
            lsi = sector.get("leading_stock_info")
            if lsi and lsi.get("code"):
                q = quotes.get(lsi["code"])
                if q:
                    lsi["price"] = q.get("price")
                    lsi["change_pct"] = q.get("change_pct")

    # 保存结果到 aistock-api/data/hot-sectors.json
    output_path = Path(__file__).parent.parent / "data" / "hot-sectors.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, default=str)

    logger.info("风口爆发股分析完成，结果已保存到 %s", output_path)
    return result


def _extract_leading_stock(
    concept_name: str,
    concept: dict,
    main_stocks: list[dict],
    concept_codes: set,
    concept_names: set,
) -> dict:
    """提取每个概念板块的龙头股信息（用于一级窗口表格）

    优先从已筛选的main_stocks中取评分最高的，
    否则从概念摘要的龙头股字段取。

    Returns:
        {
            "name": "亨通光电",
            "code": "600487",
            "industry": "通信设备",
            "price": 28.50,       # TODO: 接入行情API
            "change_pct": 5.23,   # TODO: 接入行情API
            "reason": "连续3天量价齐升，阶段涨幅23.5%",
            "in_concept": true,
        }
    """
    # 优先从已筛选的main_stocks中取评分最高的
    if main_stocks:
        best = max(main_stocks, key=lambda s: s.get("score", 0))
        return {
            "name": best.get("name", ""),
            "code": best.get("code", ""),
            "industry": best.get("industry", ""),
            "price": None,  # TODO: 接入行情API后填充
            "change_pct": None,  # TODO: 接入行情API后填充
            "reason": best.get("reason", ""),
            "in_concept": best.get("in_concept", False),
        }

    # 备选：从概念摘要的龙头股字段取
    leading_name = concept.get("leading_stock", "")
    if leading_name and leading_name != "--":
        return {
            "name": leading_name,
            "code": "",
            "industry": "",
            "price": None,
            "change_pct": None,
            "reason": concept.get("driver", ""),
            "in_concept": True,
        }

    return {
        "name": "",
        "code": "",
        "industry": "",
        "price": None,
        "change_pct": None,
        "reason": "",
        "in_concept": False,
    }


def _get_industry_stats(industry_names: list[str]) -> list[dict]:
    """获取关联行业的行情统计数据"""
    result = []
    for name in industry_names:
        info = get_industry_info(name)
        if info:
            result.append({
                "name": name,
                "change": float(info.get("板块涨幅", 0)),
                "up_count": info.get("上涨家数", 0),
                "down_count": info.get("下跌家数", 0),
                "leading_stock": "--",
            })
        else:
            result.append({"name": name, "change": 0, "up_count": 0, "down_count": 0, "leading_stock": "--"})
    return result


def _build_flow_data(
    concept_name: str,
    related_industries: list[dict],
    transmission: dict,
    ai_analysis: dict,
) -> dict:
    """构建层级流向图数据（供D3.js使用）

    层级：概念 → 强关联行业 → 上下游行业
    限制：关联行业最多2个，上下游各最多3个
    """
    # 只取前2个关联行业
    top_related = related_industries[:2]
    top_related_names = [ind["name"] for ind in top_related]

    nodes = [
        {"id": concept_name, "type": "main", "label": concept_name},
    ]
    links = []

    # 概念 → 强关联行业
    for ind in top_related:
        nodes.append({"id": ind["name"], "type": "related", "label": ind["name"]})
        links.append({
            "source": concept_name,
            "target": ind["name"],
            "factor": ind.get("overlap_ratio", 0.5),
            "direction": "related",
        })

    # 强关联行业 → 上游（只保留target在top_related中的）
    for up in transmission.get("upstream", [])[:3]:
        source = up.get("source_industry", concept_name)
        if source not in top_related_names:
            source = top_related_names[0] if top_related_names else concept_name
        if not any(n["id"] == up["name"] for n in nodes):
            nodes.append({"id": up["name"], "type": "upstream", "label": up["name"]})
        links.append({
            "source": up["name"],
            "target": source,
            "factor": up["factor"],
            "direction": "upstream",
        })

    # 强关联行业 → 下游（只保留source在top_related中的）
    for down in transmission.get("downstream", [])[:3]:
        source = down.get("source_industry", concept_name)
        if source not in top_related_names:
            source = top_related_names[0] if top_related_names else concept_name
        if not any(n["id"] == down["name"] for n in nodes):
            nodes.append({"id": down["name"], "type": "downstream", "label": down["name"]})
        links.append({
            "source": source,
            "target": down["name"],
            "factor": down["factor"],
            "direction": "downstream",
        })

    return {
        "nodes": nodes,
        "links": links,
        "transfer_direction": ai_analysis.get("transfer_direction", ""),
    }
