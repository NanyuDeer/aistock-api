"""
东方财富数据源爬虫

数据模块:
  - stock_quote:   实时行情报价
  - stock_info:    股票基本信息
  - stock_kline:   K线数据
  - stock_rank:    人气排行
  - tag_leader:    板块龙头
  - monitor_event: 个股异动事件（已实现）

对应后端 Service:
  - EmQuoteService.ts
  - EmInfoService.ts
  - EmKlineService.ts
  - EmStockRankService.ts
  - EmTagLeaderService.ts
  - StockMonitorService.ts (推送)
"""

import os
import sys

# 将 crawlers 根目录加入搜索路径, 以便导入 common 和 config
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))

from common.logger import get_logger

logger = get_logger('eastmoney')


def crawl_stock_quote():
    """爬取实时行情报价"""
    logger.info("crawl_stock_quote - not implemented yet")


def crawl_stock_info():
    """爬取股票基本信息"""
    logger.info("crawl_stock_info - not implemented yet")


def crawl_stock_kline():
    """爬取K线数据"""
    logger.info("crawl_stock_kline - not implemented yet")


def crawl_stock_rank():
    """爬取人气排行"""
    logger.info("crawl_stock_rank - not implemented yet")


def crawl_tag_leader():
    """爬取板块龙头"""
    logger.info("crawl_tag_leader - not implemented yet")


def crawl_monitor_event(once=False):
    """爬取个股异动事件并推送到后端"""
    from scraper import StockChangeScraper

    scraper = StockChangeScraper()
    try:
        if once:
            scraper.run_once()
        else:
            scraper.start()
    except KeyboardInterrupt:
        scraper.stop()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='东方财富数据爬虫')
    parser.add_argument('--module', choices=[
        'stock_quote', 'stock_info', 'stock_kline',
        'stock_rank', 'tag_leader', 'monitor_event', 'all'
    ], default='monitor_event', help='爬取模块 (默认: monitor_event)')
    parser.add_argument('--once', action='store_true', help='只执行一轮采集就退出(不进入循环)')
    args = parser.parse_args()

    modules = {
        'stock_quote': crawl_stock_quote,
        'stock_info': crawl_stock_info,
        'stock_kline': crawl_stock_kline,
        'stock_rank': crawl_stock_rank,
        'tag_leader': crawl_tag_leader,
        'monitor_event': crawl_monitor_event,
    }

    if args.module == 'all':
        for name, func in modules.items():
            logger.info(f"Running {name}...")
            try:
                func()
            except Exception as e:
                logger.error(f"{name} failed: {e}")
    else:
        if args.module == 'monitor_event':
            modules[args.module](once=args.once)
        else:
            modules[args.module]()
