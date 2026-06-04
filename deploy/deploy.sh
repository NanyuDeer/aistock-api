#!/bin/bash
set -e

APP_DIR="/home/aistock/aistock-api"
CRAWLER_DIR="/home/aistock/aistock-api/crawlers"
FRONTEND_SRC="/home/aistock/aistock-frontend"
FRONTEND_DIST="/var/www/aistock"

echo "=== aistock-api 部署脚本 ==="

echo "[1/8] 安装后端依赖..."
cd "$APP_DIR"
npm install --production

echo "[2/8] 编译 TypeScript..."
npx tsc

echo "[3/8] 运行数据库迁移..."
docker exec -i pg psql -U root -d aistock < scripts/001_init_tables.sql

echo "[4/8] 安装爬虫 Python 依赖..."
cd "$CRAWLER_DIR"
pip3 install -r sources/eastmoney.com/requirements.txt

echo "[5/8] 编译前端..."
cd "$FRONTEND_SRC"
npm install
npm run build

echo "[6/8] 部署前端静态文件..."
rm -rf "$FRONTEND_DIST"/*
cp -r "$FRONTEND_SRC/dist/"* "$FRONTEND_DIST"

echo "[7/8] 重启后端服务..."
cd "$APP_DIR"
pm2 restart aistock-api || pm2 start deploy/ecosystem.config.json --only aistock-api

echo "[8/8] 重启爬虫服务..."
pm2 restart crawler-eastmoney-monitor || pm2 start deploy/ecosystem.config.json --only crawler-eastmoney-monitor

echo "=== 部署完成 ==="
pm2 status
