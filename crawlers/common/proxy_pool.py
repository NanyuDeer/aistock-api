"""
免费代理池
从免费代理API获取代理, 验证可用性, 提供代理轮换和坏代理标记功能
"""

import time
import random
import logging
import threading
import requests

from common.request_helper import RequestHelper
from config.settings import (
    PROXY_POOL_API, PROXY_VALIDATE_URL,
    PROXY_MIN_AVAILABLE, PROXY_FETCH_COUNT, USE_PROXY
)

logger = logging.getLogger(__name__)


class ProxyPool:
    """
    免费HTTP代理池
    - 从多个免费代理源获取代理列表
    - 验证代理可用性
    - 线程安全的代理获取和标记
    - 自动刷新和坏代理剔除
    """

    def __init__(self):
        self._proxies = []
        self._lock = threading.Lock()
        self._bad_proxies = set()
        self._last_fetch_time = 0
        self._fetch_interval = 300

    def _fetch_from_api(self):
        """从免费代理API获取代理列表"""
        headers = {"User-Agent": RequestHelper.get_random_ua()}
        proxies_list = []
        try:
            resp = requests.get(
                PROXY_POOL_API,
                params={"limit": PROXY_FETCH_COUNT},
                headers=headers,
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("data", data) if isinstance(data, dict) else data
                if isinstance(items, list):
                    for item in items:
                        ip = item.get("ip", "")
                        port = item.get("port", "")
                        protocol = item.get("protocol", "http").lower()
                        if ip and port:
                            proxy_url = f"{protocol}://{ip}:{port}"
                            proxies_list.append(proxy_url)
        except Exception as e:
            logger.warning(f"从API获取代理失败: {e}")

        if not proxies_list:
            proxies_list = self._fetch_from_free_sites(headers)

        return proxies_list

    def _fetch_from_free_sites(self, headers):
        """备用方案: 从免费代理站点获取代理列表"""
        proxies_list = []
        urls = [
            "https://www.proxyscrape.com/api/v1/proxy/type=http&timeout=5000&country=all&ssl=all&anonymity=all",
        ]
        for url in urls:
            try:
                resp = requests.get(url, headers=headers, timeout=10)
                if resp.status_code == 200:
                    for line in resp.text.strip().split("\n"):
                        line = line.strip()
                        if line and ":" in line:
                            proxies_list.append(f"http://{line}")
            except Exception as e:
                logger.warning(f"从免费站点获取代理失败: {e}")
        return proxies_list

    def _validate_proxy(self, proxy_url):
        """验证代理是否可用"""
        try:
            test_headers = {"User-Agent": RequestHelper.get_random_ua()}
            resp = requests.get(
                PROXY_VALIDATE_URL,
                headers=test_headers,
                proxies={"http": proxy_url, "https": proxy_url},
                timeout=8,
            )
            if resp.status_code == 200 and "<" not in resp.text[:50]:
                return True
        except Exception:
            pass
        return False

    def refresh(self):
        """刷新代理池"""
        now = time.time()
        if now - self._last_fetch_time < self._fetch_interval and self._proxies:
            return

        logger.info("正在刷新代理池...")
        raw_proxies = self._fetch_from_api()
        valid_proxies = []

        for proxy in raw_proxies:
            if proxy in self._bad_proxies:
                continue
            if self._validate_proxy(proxy):
                valid_proxies.append(proxy)
                logger.debug(f"代理验证通过: {proxy}")
            if len(valid_proxies) >= PROXY_MIN_AVAILABLE * 2:
                break

        with self._lock:
            self._proxies = valid_proxies
            self._last_fetch_time = time.time()

        logger.info(f"代理池刷新完成, 可用代理: {len(valid_proxies)}")

    def get_proxy(self):
        """从代理池中随机获取一个代理URL"""
        with self._lock:
            if not self._proxies:
                return None
            return random.choice(self._proxies)

    def get_proxy_dict(self):
        """获取requests库格式的代理字典"""
        proxy = self.get_proxy()
        if proxy:
            return {"http": proxy, "https": proxy}
        return None

    def mark_bad(self, proxy_url):
        """将代理标记为不可用"""
        with self._lock:
            self._bad_proxies.add(proxy_url)
            self._proxies = [p for p in self._proxies if p != proxy_url]
        logger.info(f"标记坏代理: {proxy_url}, 剩余: {len(self._proxies)}")

    def count(self):
        """返回当前可用代理数量"""
        with self._lock:
            return len(self._proxies)
