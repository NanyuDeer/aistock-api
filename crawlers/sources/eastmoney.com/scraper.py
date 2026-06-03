"""
东方财富盘口异动爬虫 - 核心爬虫模块
负责API请求、数据解析、分页采集、熔断机制、交易时间判断等核心逻辑
"""

import time
import random
import logging
import requests
from datetime import datetime

from config.change_types import CHANGE_TYPES, LEVEL_MAPPING, CYCLE_MAPPING
from config.settings import (
    REQUEST_DELAY_MIN, REQUEST_DELAY_MAX,
    MAX_FAIL_COUNT, FAIL_SLEEP_TIME,
    EARLY_MORNING_INTERVAL,
    TRADE_START_HOUR, TRADE_START_MINUTE,
    TRADE_END_HOUR, TRADE_END_MINUTE,
    CONSECUTIVE_EMPTY_THRESHOLD, SLEEP_EXTRA_SECONDS,
    USE_PROXY,
    PROXY_MIN_AVAILABLE,
)
from common.request_helper import RequestHelper
from common.proxy_pool import ProxyPool
from common.logger import get_logger
import em_config
from storage import Storage

logger = get_logger('eastmoney.scraper')


class StockChangeScraper:
    """
    东方财富盘口异动爬虫核心类

    工作流程:
    1. 初始化Session会话, 加载已有去重数据, 刷新代理池
    2. 主循环: 判断交易时间 -> 分页采集全量数据 -> 去重 -> 存储JSON + 推送后端
    3. 反爬策略: 动态参数、UA轮换、随机延时、代理轮换、熔断机制
    4. 智能降频: 连续空轮自动增加休眠时间, 减少无效请求
    """

    def __init__(self):
        self.session = requests.Session()
        self.storage = Storage(data_filename_prefix=em_config.DATA_FILENAME_PREFIX)
        self.proxy_pool = ProxyPool()
        self._fail_count = 0
        self._consecutive_empty_rounds = 0
        self._extra_sleep = 0
        self._running = False

    def _init_session(self):
        """初始化HTTP会话的默认请求头"""
        self.session.headers.update({
            "User-Agent": RequestHelper.get_random_ua(),
            "Referer": "https://data.eastmoney.com/",
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Connection": "keep-alive",
        })

    def _build_url(self, page_index=0, change_type=None):
        """构建API请求参数"""
        type_param = str(change_type) if change_type else RequestHelper.build_type_param(em_config.ENABLED_TYPES)
        cb = RequestHelper.generate_jquery_callback()
        _ = RequestHelper.get_timestamp_ms()
        params = {
            "type": type_param,
            "cb": cb,
            "ut": em_config.UT_TOKEN,
            "pageindex": page_index,
            "pagesize": em_config.PAGE_SIZE,
            "dpt": em_config.DPT,
            "_": _,
        }
        return em_config.BASE_URL, params

    def _make_request(self, page_index=0, change_type=None):
        """发起单次API请求, 包含完整的异常处理和反爬检测"""
        url, params = self._build_url(page_index, change_type)
        self.session.headers["User-Agent"] = RequestHelper.get_random_ua()

        proxy_dict = None
        if USE_PROXY:
            proxy_dict = self.proxy_pool.get_proxy_dict()

        try:
            resp = self.session.get(url, params=params, proxies=proxy_dict, timeout=10)

            if resp.status_code == 403:
                logger.warning(f"403 被拦截, 代理: {proxy_dict}")
                if proxy_dict:
                    self.proxy_pool.mark_bad(proxy_dict.get("http", ""))
                return None

            if resp.status_code != 200:
                logger.warning(f"非200状态码: {resp.status_code}")
                return None

            text = resp.text.strip()
            if text.startswith("<") or "<!DOCTYPE" in text:
                logger.warning("返回HTML错误页面")
                return None

            data = RequestHelper.parse_jsonp(text)
            if data is None:
                logger.warning("JSONP解析失败")
                return None

            self._fail_count = 0
            return data

        except requests.exceptions.ProxyError:
            logger.warning(f"代理连接失败: {proxy_dict}")
            if proxy_dict:
                self.proxy_pool.mark_bad(proxy_dict.get("http", ""))
            return None
        except requests.exceptions.Timeout:
            logger.warning("请求超时")
            return None
        except requests.exceptions.RequestException as e:
            logger.warning(f"请求异常: {e}")
            return None

    @staticmethod
    def _build_detail_url(stock_code):
        if stock_code.startswith("6"):
            market = "sh"
        elif stock_code.startswith("0") or stock_code.startswith("3"):
            market = "sz"
        else:
            market = "sz"
        return f"{em_config.DETAIL_URL_BASE}{market}{stock_code}.html"

    @staticmethod
    def _format_tm(tm_value):
        tm_str = str(tm_value).zfill(6)
        return f"{tm_str[:2]}:{tm_str[2:4]}:{tm_str[4:6]}"

    def _parse_records(self, data):
        """解析API返回数据, 根据change_type_code映射周期分类"""
        records = []
        today = datetime.now().strftime("%Y%m%d")
        try:
            items = data.get("data", {}).get("allstock", [])
            if not items:
                return records

            for item in items:
                stock_code = item.get("c", "")
                stock_name = item.get("n", "").strip()
                event_time = self._format_tm(item.get("tm", 0))
                change_type_code = item.get("t", 0)
                summary = CHANGE_TYPES.get(change_type_code, f"未知({change_type_code})")
                level = LEVEL_MAPPING.get(change_type_code, "")
                # 根据异动类型代码映射周期分类
                event_type = CYCLE_MAPPING.get(change_type_code, "短线") + "异动"

                if not stock_code or not event_time:
                    continue

                event_id = f"{today}_{event_time.replace(':', '')}_{stock_code}"

                records.append({
                    "event_id": event_id,
                    "event_time": event_time,
                    "stock_code": stock_code,
                    "stock_name": stock_name,
                    "summary": summary,
                    "level": level,
                    "event_type": event_type,
                    "detail_url": self._build_detail_url(stock_code),
                    "change_type_code": change_type_code,
                })
        except Exception as e:
            logger.error(f"解析记录异常: {e}")

        return records

    def _fetch_one_page(self, page_index, change_type=None):
        """采集单页数据"""
        data = self._make_request(page_index, change_type)
        if data is None:
            self._fail_count += 1
            if self._fail_count >= MAX_FAIL_COUNT:
                logger.warning(f"连续 {self._fail_count} 次失败, 触发熔断, 休眠 {FAIL_SLEEP_TIME}s")
                time.sleep(FAIL_SLEEP_TIME)
                self._fail_count = 0
            return [], 0

        records = self._parse_records(data)
        total = data.get("data", {}).get("tc", 0)
        return records, total

    def _fetch_pages_for_type(self, change_type):
        """分页采集单个异动类型的全部数据"""
        type_name = CHANGE_TYPES.get(change_type, str(change_type))
        all_new_records = []
        page_index = 0
        empty_pages = 0

        while True:
            records, total = self._fetch_one_page(page_index, change_type)

            if not records:
                empty_pages += 1
                if empty_pages >= 2:
                    break
            else:
                empty_pages = 0

            new_records = []
            for record in records:
                if not self.storage.is_duplicate(record["stock_code"], record["event_time"]):
                    new_records.append(record)

            if new_records:
                all_new_records.extend(new_records)

            saved = self.storage.save(new_records)
            if records:
                logger.info(
                    f"[{type_name}]第{page_index}页: 获取{len(records)}条, 新增{len(new_records)}条, 保存{saved}条"
                )

            if total > 0 and (page_index + 1) * em_config.PAGE_SIZE >= total:
                break

            page_index += 1
            RequestHelper.random_delay(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX)

        return all_new_records

    def _fetch_all_pages(self):
        """采集所有启用类型的异动数据"""
        all_new_records = []
        total_new_this_round = 0

        for change_type in em_config.ENABLED_TYPES:
            type_name = CHANGE_TYPES.get(change_type, str(change_type))
            cycle = CYCLE_MAPPING.get(change_type, "短线")
            logger.info(f"开始采集类型: {type_name}({change_type}) [{cycle}]")
            type_records = self._fetch_pages_for_type(change_type)
            all_new_records.extend(type_records)
            total_new_this_round += len(type_records)

        if total_new_this_round == 0:
            self._consecutive_empty_rounds += 1
        else:
            self._consecutive_empty_rounds = 0
            self._extra_sleep = 0

        if self._consecutive_empty_rounds >= CONSECUTIVE_EMPTY_THRESHOLD:
            self._extra_sleep += SLEEP_EXTRA_SECONDS
            logger.info(f"连续{self._consecutive_empty_rounds}轮无新数据, 额外休眠+{self._extra_sleep}s")

        return all_new_records

    def _is_trading_time(self):
        """判断当前是否为A股交易时间"""
        now = time.localtime()
        weekday = now.tm_wday
        if weekday >= 5:
            return False

        current_minutes = now.tm_hour * 60 + now.tm_min
        start_minutes = TRADE_START_HOUR * 60 + TRADE_START_MINUTE
        end_minutes = TRADE_END_HOUR * 60 + TRADE_END_MINUTE
        return start_minutes <= current_minutes <= end_minutes

    def _is_early_morning(self):
        """判断是否为早盘期间(开盘后30分钟内)"""
        now = time.localtime()
        return now.tm_hour == TRADE_START_HOUR and now.tm_min < 30

    def start(self):
        """启动爬虫主循环"""
        self._running = True
        self._init_session()
        self.storage.load_existing_keys()

        if USE_PROXY:
            self.proxy_pool.refresh()

        logger.info("=" * 60)
        logger.info("东方财富盘口异动爬虫启动")
        logger.info(f"监控类型: {[CHANGE_TYPES.get(t, str(t)) for t in em_config.ENABLED_TYPES]}")
        logger.info(f"代理模式: {'开启' if USE_PROXY else '关闭'}")
        logger.info("=" * 60)

        while self._running:
            try:
                if not self._is_trading_time():
                    logger.info("非交易时间, 休眠60s...")
                    time.sleep(60)
                    continue

                if USE_PROXY and self.proxy_pool.count() < PROXY_MIN_AVAILABLE:
                    self.proxy_pool.refresh()

                if self._is_early_morning():
                    logger.info(f"早盘期间, 使用大间隔: {EARLY_MORNING_INTERVAL}s")
                    time.sleep(EARLY_MORNING_INTERVAL)

                new_records = self._fetch_all_pages()

                if new_records:
                    for r in new_records:
                        logger.info(
                            f"[异动] {r['event_time']} {r['stock_name']}({r['stock_code']}) {r['summary']} [{r['event_type']}]"
                        )

                self.storage.sort_current_file()

                base_delay = random.uniform(REQUEST_DELAY_MIN, REQUEST_DELAY_MAX)
                total_delay = base_delay + self._extra_sleep
                logger.info(f"本轮完成, 休眠 {total_delay:.1f}s...")
                time.sleep(total_delay)

            except KeyboardInterrupt:
                logger.info("收到中断信号, 停止爬虫...")
                self._running = False
                break
            except Exception as e:
                logger.error(f"主循环异常: {e}", exc_info=True)
                time.sleep(30)

        self.stop()

    def run_once(self):
        """执行一轮采集后退出（不进入循环，适用于非交易时间拉取今日已有数据）"""
        self._init_session()
        self.storage.load_existing_keys()

        if USE_PROXY:
            self.proxy_pool.refresh()

        logger.info("=" * 60)
        logger.info("东方财富盘口异动爬虫 - 单次采集模式")
        logger.info(f"监控类型: {[CHANGE_TYPES.get(t, str(t)) for t in em_config.ENABLED_TYPES]}")
        logger.info("=" * 60)

        new_records = self._fetch_all_pages()

        if new_records:
            for r in new_records:
                logger.info(
                    f"[异动] {r['event_time']} {r['stock_name']}({r['stock_code']}) {r['summary']} [{r['event_type']}]"
                )
        else:
            logger.info("本轮无新增数据")

        self.storage.sort_current_file()
        self.stop()
        logger.info("单次采集完成，爬虫退出")

    def stop(self):
        """停止爬虫, 关闭存储和会话"""
        self._running = False
        self.storage.close()
        self.session.close()
        logger.info("爬虫已停止")
