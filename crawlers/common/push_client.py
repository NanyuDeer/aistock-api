"""
推送客户端 - 将爬取的数据推送到后端 API
"""

import os
import json
import requests
from typing import Optional

from config.settings import API_BASE_URL, INTERNAL_TOKEN


class PushClient:
    """向后端内部 API 推送数据的客户端"""

    def __init__(self, base_url: str = None, token: str = None):
        self.base_url = base_url or API_BASE_URL
        self.token = token or INTERNAL_TOKEN
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'x-internal-token': self.token,
        })

    def push_monitor_event(self, event: dict) -> dict:
        """
        推送个股异动事件

        Args:
            event: 异动事件数据，格式参考 schemas/stock_monitor_events.sql

        Returns:
            API 响应 JSON
        """
        url = f"{self.base_url}/api/internal/monitor-events"
        resp = self.session.post(url, json=event)
        resp.raise_for_status()
        return resp.json()

    def push_batch_monitor_events(self, events: list[dict]) -> dict:
        """批量推送个股异动事件"""
        url = f"{self.base_url}/api/internal/monitor-events/batch"
        resp = self.session.post(url, json={"events": events})
        resp.raise_for_status()
        return resp.json()

    def health_check(self) -> bool:
        """检查后端 API 是否可达"""
        try:
            resp = self.session.get(f"{self.base_url}/api/health")
            return resp.status_code == 200
        except requests.ConnectionError:
            return False
