"""
Tushare 数据源爬虫

数据模块:
  - capital_flow: 资金流向
  - stock_info:   股票基本信息
  - stock_kline:  K线数据
  - stock_quote:  实时行情
  - stock_rank:   人气排行
  - tag_leader:   板块龙头

对应后端 Service:
  - TushareCapitalFlowService.ts
  - TushareInfoService.ts
  - TushareKlineService.ts
  - TushareQuoteService.ts
  - TushareRankService.ts
  - TushareTagLeaderService.ts
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from common.logger import get_logger

logger = get_logger('tushare')


def crawl_capital_flow(symbol: str = None):
    """爬取资金流向数据"""
    # TODO: 实现 Tushare 资金流向爬取
    logger.info(f"crawl_capital_flow - not implemented yet (symbol={symbol})")


def crawl_stock_info():
    """爬取股票基本信息"""
    # TODO: 实现 Tushare 股票信息爬取
    logger.info("crawl_stock_info - not implemented yet")


def crawl_stock_kline(symbol: str = None):
    """爬取K线数据"""
    # TODO: 实现 Tushare K线爬取
    logger.info(f"crawl_stock_kline - not implemented yet (symbol={symbol})")


def crawl_stock_quote():
    """爬取实时行情"""
    # TODO: 实现 Tushare 行情爬取
    logger.info("crawl_stock_quote - not implemented yet")


def crawl_stock_rank():
    """爬取人气排行"""
    # TODO: 实现 Tushare 排行爬取
    logger.info("crawl_stock_rank - not implemented yet")


def crawl_tag_leader():
    """爬取板块龙头"""
    # TODO: 实现 Tushare 板块龙头爬取
    logger.info("crawl_tag_leader - not implemented yet")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Tushare 数据爬虫')
    parser.add_argument('--module', choices=[
        'capital_flow', 'stock_info', 'stock_kline',
        'stock_quote', 'stock_rank', 'tag_leader', 'all'
    ], default='all')
    parser.add_argument('--symbol', type=str, help='股票代码')
    args = parser.parse_args()

    modules = {
        'capital_flow': lambda: crawl_capital_flow(args.symbol),
        'stock_info': crawl_stock_info,
        'stock_kline': lambda: crawl_stock_kline(args.symbol),
        'stock_quote': crawl_stock_quote,
        'stock_rank': crawl_stock_rank,
        'tag_leader': crawl_tag_leader,
    }

    if args.module == 'all':
        for name, func in modules.items():
            logger.info(f"Running {name}...")
            try:
                func()
            except Exception as e:
                logger.error(f"{name} failed: {e}")
    else:
        modules[args.module]()
