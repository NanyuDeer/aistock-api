"""
请求辅助工具
封装UA池管理、jQuery回调生成、时间戳获取、JSONP解析等通用功能
"""

import time
import random
import re
import json


class RequestHelper:
    """
    请求辅助工具类
    提供UA轮换、JSONP解析、随机延时等通用HTTP请求工具
    """

    UA_POOL = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Edg/125.0.0.0",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    ]

    @staticmethod
    def generate_jquery_callback():
        """
        生成随机jQuery回调函数名
        格式: jQuery{6位随机数}_{13位毫秒时间戳}
        """
        rand_num = random.randint(100000, 999999)
        ts = int(time.time() * 1000)
        return f"jQuery{rand_num}_{ts}"

    @staticmethod
    def get_timestamp_ms():
        """获取当前13位毫秒时间戳, 用于API的_参数防缓存"""
        return int(time.time() * 1000)

    @staticmethod
    def get_random_ua():
        """从UA池中随机选取一个User-Agent"""
        return random.choice(RequestHelper.UA_POOL)

    @staticmethod
    def parse_jsonp(jsonp_text):
        """
        解析JSONP响应, 提取其中的JSON数据
        东方财富API返回格式: jQuery123456_1234567890123({...json...})
        """
        match = re.search(r"\((.*)\)", jsonp_text, re.DOTALL)
        if match:
            json_str = match.group(1)
            return json.loads(json_str)
        return None

    @staticmethod
    def build_type_param(enabled_types):
        """
        将启用的异动类型列表拼接为API的type参数
        例如 [4, 32, 8, 16] -> "4,32,8,16"
        """
        return ",".join(str(t) for t in enabled_types)

    @staticmethod
    def random_delay(min_sec, max_sec):
        """在[min_sec, max_sec]范围内随机休眠, 模拟人类操作间隔"""
        delay = random.uniform(min_sec, max_sec)
        time.sleep(delay)
