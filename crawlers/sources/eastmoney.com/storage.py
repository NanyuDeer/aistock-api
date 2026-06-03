"""
东方财富盘口异动爬虫 - 数据存储模块
负责JSON文件写入、内存去重缓存、日期自动切换、启动时加载已有数据
同时将新数据推送到后端API
"""

import os
import json
import logging
from datetime import datetime

from config.settings import DATA_DIR
from common.push_client import PushClient
from common.logger import get_logger

logger = get_logger('eastmoney.storage')

JSON_FIELDS = [
    "event_id",
    "event_time",
    "stock_code",
    "stock_name",
    "summary",
    "level",
    "event_type",
    "detail_url",
    "change_type_code",
]


class Storage:
    """
    数据存储管理器
    - 按日期自动创建JSON文件到共享data/目录, 跨日自动切换
    - 内存去重集合, 避免重复写入
    - 启动时从已有JSON加载去重记录, 实现断点续采
    - 新数据自动推送到后端API
    """

    def __init__(self, data_filename_prefix="em_stock_changes"):
        self._seen = set()
        self._current_date = None
        self._data_filename_prefix = data_filename_prefix
        self._push_client = PushClient()
        self._ensure_dir()

    def _ensure_dir(self):
        os.makedirs(DATA_DIR, exist_ok=True)

    def _get_filepath(self, date_str=None):
        if date_str is None:
            date_str = datetime.now().strftime("%Y%m%d")
        filename = f"{self._data_filename_prefix}_{date_str}.json"
        return os.path.join(DATA_DIR, filename)

    def _read_json(self, filepath):
        if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
            return []
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, Exception) as e:
            logger.warning(f"读取JSON失败 {filepath}: {e}")
            return []

    def _write_json(self, filepath, records):
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2)

    def _check_date_rollover(self):
        today = datetime.now().strftime("%Y%m%d")
        if today != self._current_date:
            self._current_date = today

    def _make_key(self, stock_code, event_time):
        return f"{stock_code}_{event_time}"

    def is_duplicate(self, stock_code, event_time):
        key = self._make_key(stock_code, event_time)
        return key in self._seen

    def _push_to_backend(self, record):
        """将单条记录推送到后端API"""
        try:
            # 构建后端API期望的数据格式
            stock_code = record.get("stock_code", "")
            # 转换为后端symbol格式: SZ300308 / SH600000
            if stock_code.startswith("6"):
                symbol = f"SH{stock_code}"
            elif stock_code.startswith("0") or stock_code.startswith("3"):
                symbol = f"SZ{stock_code}"
            else:
                symbol = f"SZ{stock_code}"

            event = {
                "event_id": record.get("event_id", ""),
                "symbol": symbol,
                "stock_name": record.get("stock_name", ""),
                "event_type": str(record.get("change_type_code", "")),
                "level": record.get("level", ""),
                "summary": record.get("summary", ""),
                "event_time": record.get("event_time", ""),
                "detail_url": record.get("detail_url", ""),
                "raw_data_json": {
                    "change_type": str(record.get("change_type_code", "")),
                    "event_type": record.get("event_type", ""),
                },
            }
            self._push_client.push_monitor_event(event)
        except Exception as e:
            logger.warning(f"推送到后端失败: {e}")

    def save(self, records):
        if not records:
            return 0

        new_records = []

        for record in records:
            stock_code = record.get("stock_code", "")
            event_time = record.get("event_time", "")
            key = self._make_key(stock_code, event_time)
            if key not in self._seen:
                self._seen.add(key)
                new_records.append(record)

        if not new_records:
            return 0

        if self._current_date is None:
            self._current_date = datetime.now().strftime("%Y%m%d")

        self._check_date_rollover()

        filepath = self._get_filepath(self._current_date)
        existing = self._read_json(filepath)
        for record in new_records:
            existing.append({k: record.get(k, "") for k in JSON_FIELDS})
        self._write_json(filepath, existing)

        # 推送到后端API
        for record in new_records:
            self._push_to_backend(record)

        saved_count = len(new_records)
        logger.info(f"保存 {saved_count} 条新记录到JSON, 并推送到后端")
        return saved_count

    def load_existing_keys(self):
        if not os.path.exists(DATA_DIR):
            return

        for filename in os.listdir(DATA_DIR):
            if filename.startswith(self._data_filename_prefix) and filename.endswith(".json"):
                filepath = os.path.join(DATA_DIR, filename)
                records = self._read_json(filepath)
                for record in records:
                    stock_code = record.get("stock_code", "")
                    event_time = record.get("event_time", "")
                    if stock_code and event_time:
                        key = self._make_key(stock_code, event_time)
                        self._seen.add(key)

        logger.info(f"从已有JSON加载 {len(self._seen)} 条去重记录")

    def sort_current_file(self):
        if self._current_date is None:
            return

        filepath = self._get_filepath(self._current_date)
        records = self._read_json(filepath)
        if not records:
            return

        records.sort(key=lambda r: r.get("event_time", ""), reverse=True)
        self._write_json(filepath, records)
        logger.info(f"已对 {filepath} 按时间排序, 共 {len(records)} 条记录")

    def close(self):
        pass
