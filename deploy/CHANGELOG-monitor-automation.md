# 个股异动监测系统 - 自动化部署修改说明

## 修改日期

2026-06-03

## 修改目标

确保个股异动监测系统在服务器上 **全自动运行**：爬虫自动采集 → 后端自动入库 → 前端自动展示，无需人工干预。

## 全链路数据流

```
东方财富异动接口
  → crawlers/sources/eastmoney.com (Python爬虫, PM2托管)
  → POST /api/internal/monitor-events/batch (批量推送)
  → stock_monitor_events 表 (PostgreSQL)
  → StockMonitorService (拼接行情+行业)
  → GET /api/cn/monitor/events (前端查询)
  → 首页个股异动 / 个股详情页异动 / 异动监测独立页
```

## 修改文件清单

### 1. `deploy/ecosystem.config.json` — PM2 进程配置

**变更：** 新增 `crawler-eastmoney-monitor` 进程

```json
{
  "name": "crawler-eastmoney-monitor",
  "script": "sources/eastmoney.com/crawler.py",
  "interpreter": "/home/aistock/.local/bin/python3",
  "cwd": "/home/aistock/aistock-api/crawlers",
  "args": "--module monitor_event",
  "autorestart": true,
  "max_restarts": 30,
  "restart_delay": 10000
}
```

**效果：**
- `pm2 start deploy/ecosystem.config.json` 会同时启动后端API和爬虫
- 爬虫崩溃后自动重启（最多30次）
- 服务器重启后 `pm2 resurrect` 自动恢复爬虫进程
- 日志独立：`/home/aistock/logs/crawler-eastmoney-*.log`

**注意：** `interpreter` 路径需根据服务器实际 Python3 路径调整，可用 `which python3` 确认。

### 2. `deploy/deploy.sh` — 部署脚本

**变更：**
- 新增步骤4：安装爬虫 Python 依赖
- 新增步骤8：重启爬虫服务
- 步骤数从6步增加到8步

### 3. `crawlers/sources/eastmoney.com/storage.py` — 爬虫存储模块

**变更：** `_push_to_backend` 从逐条推送改为批量推送

**之前：** 每条异动事件单独调用 `POST /api/internal/monitor-events`
**之后：** 同一批次事件合并调用 `POST /api/internal/monitor-events/batch`

**效果：**
- 推送效率大幅提升（一轮采集可能产生数百条事件）
- 减少后端API压力
- 单次推送失败整批重试，日志更清晰

### 4. `aistock-frontend/src/components/StockMonitorList.vue` — 详情页/独立页异动列表

**变更：** 修复 `price.toFixed(2)` 在 price 为 null 时报错

**之前：** `{{ event.price.toFixed(2) }}` — price 为 null/undefined 时页面崩溃
**之后：** `{{ event.price != null ? Number(event.price).toFixed(2) : '--' }}` — 安全处理空值

## 自动化验证清单

部署后请逐项确认：

| 序号 | 检查项 | 验证方法 |
|------|--------|----------|
| 1 | PM2 两个进程都在运行 | `pm2 status` 看到 `aistock-api` 和 `crawler-eastmoney-monitor` |
| 2 | 爬虫日志有输出 | `pm2 logs crawler-eastmoney-monitor --lines 20` |
| 3 | 数据库有当日异动 | `SELECT COUNT(*) FROM stock_monitor_events WHERE event_time >= CURRENT_DATE;` |
| 4 | 后端API返回数据 | `curl http://localhost:3000/api/cn/monitor/events?limit=3` |
| 5 | 首页个股异动有数据 | 浏览器访问首页，个股异动模块显示表格 |
| 6 | 个股详情页有异动 | 点击某只异动股票，详情页异动模块显示列表 |
| 7 | 异动监测独立页有数据 | 访问 `/monitor`，统计概览和列表正常 |
| 8 | 周期筛选正常 | 切换短线/中线/长线，列表正确过滤 |
| 9 | 行业字段有值 | 股票列显示行业标签（如"计算机设备"） |
| 10 | 价格和涨跌幅有值 | 行情数据和异动数据列显示数字而非0或-- |

## 服务器运维命令

```bash
# 查看进程状态
pm2 status

# 查看爬虫日志
pm2 logs crawler-eastmoney-monitor

# 重启爬虫
pm2 restart crawler-eastmoney-monitor

# 停止爬虫（非交易时间维护时）
pm2 stop crawler-eastmoney-monitor

# 手动单次采集（不启动持续循环）
cd /home/aistock/aistock-api/crawlers
python3 sources/eastmoney.com/crawler.py --once

# 清理当日旧数据重新采集
psql -h localhost -U root -d aistock -c "DELETE FROM stock_monitor_events WHERE event_time >= CURRENT_DATE;"
pm2 restart crawler-eastmoney-monitor
```

## 交易时间行为

| 时间段 | 爬虫行为 |
|--------|----------|
| 周一至周五 9:15 - 15:30 | 持续采集，按异动类型轮询 |
| 非交易时间 | 每轮检测到非交易时间后休眠60秒再检测 |
| 周末 | 同非交易时间，休眠等待 |

爬虫内部有智能降频机制：连续多轮无新数据时自动增加休眠间隔，减少无效请求。

## 关键配置对齐

以下配置必须保持一致，否则爬虫推送会被后端拒绝：

| 爬虫环境变量 | 后端环境变量 | 说明 |
|-------------|-------------|------|
| `INTERNAL_TOKEN` | `INTERNAL_API_TOKEN` | 内部API鉴权token |
| `API_BASE_URL` | — | 爬虫推送目标地址，默认 `http://localhost:3000` |

## 已知限制

1. **非交易时间无数据**：东方财富接口在非交易时间只返回少量盘口异动（主要是L3/L4级别），L1/L2级别数据在交易时间才丰富
2. **行业信息依赖实时接口**：行业由后端 `EmService.getStockInfo()` 拼接，若东方财富信息接口异常则行业为空
3. **行情数据依赖实时接口**：价格和涨跌幅由后端 `EmQuoteService.getBatchQuotes()` 拼接，非交易时间行情接口可能返回0或上一交易日收盘价
4. **PM2 interpreter 路径**：需根据服务器实际 Python3 安装路径调整
