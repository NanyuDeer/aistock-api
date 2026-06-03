"""
同花顺数据爬虫

数据模块:
  - profit_forecast: 盈利预测数据

对应后端 Service:
  - ThsService.ts
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from common.logger import get_logger

logger = get_logger('10jqka')


def crawl_profit_forecast(symbol: str = None):
    """爬取同花顺盈利预测数据"""
    # TODO: 实现同花顺盈利预测爬取
    logger.info(f"crawl_profit_forecast - not implemented yet (symbol={symbol})")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='同花顺数据爬虫')
    parser.add_argument('--module', choices=['profit_forecast'], default='profit_forecast')
    parser.add_argument('--symbol', type=str, help='股票代码')
    args = parser.parse_args()

    crawl_profit_forecast(args.symbol)
