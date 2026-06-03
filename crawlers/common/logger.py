"""
日志工具
"""

import logging
import sys


def get_logger(name: str, level: str = None) -> logging.Logger:
    """
    获取统一格式的 Logger

    Args:
        name: 日志名称，通常为数据源名称（如 'eastmoney'）
        level: 日志级别，默认从环境变量 LOG_LEVEL 读取，fallback INFO
    """
    logger = logging.getLogger(f"crawlers.{name}")

    if logger.handlers:
        return logger

    log_level = level or os.environ.get("LOG_LEVEL", "INFO").upper()
    logger.setLevel(getattr(logging, log_level, logging.INFO))

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(getattr(logging, log_level, logging.INFO))

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(name)s] %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)
    logger.addHandler(handler)

    return logger


import os
