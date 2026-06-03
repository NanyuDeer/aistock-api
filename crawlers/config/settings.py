"""
全局配置

优先从环境变量读取，fallback 到默认值。
生产环境请通过 .env 文件或系统环境变量覆盖。
"""

import os

# ─── 后端 API ───
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3000")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "crawler-int-2026-token")

# ─── 数据存放 ───
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))

# ─── 日志 ───
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

# ─── 交易时间 ───
TRADE_START_HOUR = int(os.environ.get("TRADE_START_HOUR", "9"))
TRADE_START_MINUTE = int(os.environ.get("TRADE_START_MINUTE", "15"))
TRADE_END_HOUR = int(os.environ.get("TRADE_END_HOUR", "15"))
TRADE_END_MINUTE = int(os.environ.get("TRADE_END_MINUTE", "30"))

# ─── 请求延时 ───
REQUEST_DELAY_MIN = float(os.environ.get("REQUEST_DELAY_MIN", "2.5"))
REQUEST_DELAY_MAX = float(os.environ.get("REQUEST_DELAY_MAX", "5.0"))

# ─── 熔断机制 ───
MAX_FAIL_COUNT = int(os.environ.get("MAX_FAIL_COUNT", "2"))
FAIL_SLEEP_TIME = int(os.environ.get("FAIL_SLEEP_TIME", "60"))

# ─── 早盘配置 ───
EARLY_MORNING_INTERVAL = int(os.environ.get("EARLY_MORNING_INTERVAL", "8"))

# ─── 代理池 ───
USE_PROXY = os.environ.get("USE_PROXY", "true").lower() == "true"
PROXY_POOL_API = os.environ.get("PROXY_POOL_API", "https://ip.jiangxianli.com/api/proxy_ips")
PROXY_VALIDATE_URL = os.environ.get("PROXY_VALIDATE_URL", "https://push2ex.eastmoney.com")
PROXY_MIN_AVAILABLE = int(os.environ.get("PROXY_MIN_AVAILABLE", "3"))
PROXY_FETCH_COUNT = int(os.environ.get("PROXY_FETCH_COUNT", "20"))

# ─── 智能降频 ───
CONSECUTIVE_EMPTY_THRESHOLD = int(os.environ.get("CONSECUTIVE_EMPTY_THRESHOLD", "4"))
SLEEP_EXTRA_SECONDS = int(os.environ.get("SLEEP_EXTRA_SECONDS", "2"))

# ─── Tushare ───
TUSHARE_TOKEN = os.environ.get("TUSHARE_TOKEN", "")

# ─── 东方财富 ───
EASTMONEY_API_BASE = os.environ.get("EASTMONEY_API_BASE", "https://push2.eastmoney.com")

# ─── 财联社 ───
CLS_API_BASE = os.environ.get("CLS_API_BASE", "https://www.cls.cn")

# ─── 同花顺 ───
THS_API_BASE = os.environ.get("THS_API_BASE", "https://basic.10jqka.com.cn")
