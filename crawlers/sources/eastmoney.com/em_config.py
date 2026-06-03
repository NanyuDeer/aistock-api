"""
东方财富数据源专属配置
仅适用于东方财富API的参数，不通用
"""

import os

# 异动数据API地址
BASE_URL = os.environ.get("EM_MONITOR_BASE_URL", "https://push2ex.eastmoney.com/getAllStockChanges")

# ut固定token, 东方财富接口鉴权参数
UT_TOKEN = os.environ.get("EM_UT_TOKEN", "7eea3edcaed734bea9cbfc24409ed989")

# 每页返回条数
PAGE_SIZE = int(os.environ.get("EM_PAGE_SIZE", "64"))

# dpt参数, 接口数据类型标识
DPT = os.environ.get("EM_DPT", "wzchanges")

# 股票详情页URL前缀
DETAIL_URL_BASE = "https://quote.eastmoney.com/"

# 当前启用的异动类型列表（默认全部类型）
# 可按需修改，例如只监控涨跌停: [4, 8, 16, 32]
ENABLED_TYPES = [
    4, 8, 16, 32,           # 涨跌停
    64, 128,                 # 快速反弹/高台跳水
    8193, 8194,              # 火箭发射/加速下跌
    8201, 8202, 8203, 8204,  # 大笔买卖
    8207, 8208, 8209, 8210,  # 5日线/缺口
    8211, 8212,              # 60日新高新低
    8213, 8214,              # 60日大幅涨跌
    8215, 8216,              # 竞价涨跌
]

# 数据文件名前缀
DATA_FILENAME_PREFIX = "em_stock_changes"
