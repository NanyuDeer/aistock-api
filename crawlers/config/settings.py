"""
全局配置

优先从环境变量读取，fallback 到默认值。
生产环境请通过 .env 文件或系统环境变量覆盖。
"""

import os

# ─── 日志 ───
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

# ─── Tushare ───
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "")

# ─── 东方财富 ───
EASTMONEY_API_BASE = os.environ.get("EASTMONEY_API_BASE", "https://push2.eastmoney.com")

# ─── 财联社 ───
CLS_API_BASE = os.environ.get("CLS_API_BASE", "https://www.cls.cn")

# ─── 同花顺 ───
THS_API_BASE = os.environ.get("THS_API_BASE", "https://basic.10jqka.com.cn")
