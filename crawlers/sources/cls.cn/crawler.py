"""
财联社新闻爬虫

数据模块:
  - stock_news: 个股新闻
  - headlines:  头条资讯

对应后端 Service:
  - ClsStockNewsService.ts
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from common.logger import get_logger

logger = get_logger('cls')


def crawl_stock_news(symbol: str = None):
    """爬取财联社个股新闻"""
    # TODO: 实现财联社新闻爬取
    logger.info(f"crawl_stock_news - not implemented yet (symbol={symbol})")


def crawl_headlines():
    """爬取财联社头条"""
    # TODO: 实现财联社头条爬取
    logger.info("crawl_headlines - not implemented yet")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='财联社新闻爬虫')
    parser.add_argument('--module', choices=['stock_news', 'headlines', 'all'], default='all')
    parser.add_argument('--symbol', type=str, help='股票代码')
    args = parser.parse_args()

    if args.module in ('stock_news', 'all'):
        crawl_stock_news(args.symbol)
    if args.module in ('headlines', 'all'):
        crawl_headlines()
