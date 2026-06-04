"""
风口爆发股 - Flask 后端服务
提供 API 接口供前端页面调用
分析完成后自动推送数据到 aistock-api 后端
每天凌晨3点定时执行分析
"""

import json
import logging
import os
import requests
from pathlib import Path
from flask import Flask, jsonify, Response
from flask_cors import CORS
from apscheduler.schedulers.background import BackgroundScheduler

from sector_analyzer import run_full_analysis

app = Flask(__name__)
CORS(app)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(name)s | %(message)s")
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
DATA_FILE = BASE_DIR.parent / "data" / "hot-sectors.json"

# aistock-api 后端推送配置
API_PUSH_URL = os.getenv("API_PUSH_URL", "http://localhost:3000/api/internal/hot-sectors")
API_PUSH_TOKEN = os.getenv("API_PUSH_TOKEN", "crawler-int-2026-token")


def push_to_api(data: dict):
    """将分析结果推送到 aistock-api 后端"""
    try:
        resp = requests.post(
            API_PUSH_URL,
            json=data,
            headers={
                "Content-Type": "application/json",
                "x-internal-token": API_PUSH_TOKEN,
            },
            timeout=10,
        )
        if resp.status_code == 200:
            logger.info("数据推送成功: %s", resp.json())
        else:
            logger.warning("数据推送失败: %d %s", resp.status_code, resp.text)
    except Exception as e:
        logger.warning("数据推送异常: %s", e)


def scheduled_analysis():
    """定时任务：执行分析并推送数据"""
    logger.info("定时任务触发，开始执行风口爆发股分析...")
    try:
        data = run_full_analysis()
        push_to_api(data)
        logger.info("定时分析完成并推送成功")
    except Exception:
        logger.exception("定时分析执行失败")


@app.route("/api/analysis")
def get_analysis():
    """获取风口爆发股分析结果（优先使用缓存）"""
    if DATA_FILE.exists():
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data)
    return jsonify({"error": "暂无数据，请先执行分析"}), 404


@app.route("/api/refresh", methods=["POST"])
def refresh_analysis():
    """手动触发分析"""
    try:
        data = run_full_analysis()
        push_to_api(data)
        return jsonify(data)
    except Exception as e:
        logger.exception("分析执行失败")
        return jsonify({"error": str(e)}), 500


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    # 启动时先执行一次分析
    logger.info("启动风口爆发股服务，正在执行初始分析...")
    try:
        data = run_full_analysis()
        push_to_api(data)
    except Exception:
        logger.exception("初始分析失败")

    # 设置凌晨3点定时任务
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        scheduled_analysis,
        'cron',
        hour=3,
        minute=0,
        id='daily_hot_sector_analysis',
        replace_existing=True,
    )
    scheduler.start()
    logger.info("已设置定时任务：每天凌晨3:00执行风口爆发股分析")

    try:
        app.run(host="0.0.0.0", port=5001, debug=False)
    except (KeyboardInterrupt, SystemExit):
        scheduler.shutdown()
