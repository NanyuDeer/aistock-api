# aistock-api

A 股数据后端服务，提供行情、资讯、AI 分析、资金流向和个股异动监测接口。

## 个股异动监测

当前个股异动监测已改为后端主动扫描，不再依赖 Python 爬虫进程。

链路：

```text
东方财富盘口异动接口
  -> StockMonitorService.scanAndDispatch()
  -> stock_monitor_events 表
  -> WechatPushService.dispatchMonitorEvent()
  -> GET /api/cn/monitor/events
  -> 前端首页 /monitor / 个股详情页
```

关键文件：

- `src/services/StockMonitorService.ts`：拉取东方财富盘口异动、标准化事件、入库、触发微信推送
- `src/index.ts`：交易时间内每分钟触发一次主动扫描
- `deploy/ecosystem.config.json`：只保留 `aistock-api`，不再启动 `crawler-eastmoney-monitor`
- `deploy/deploy.sh`：不再安装和重启 Python 爬虫

## 环境变量

后端根目录使用 `.env`。敏感值只放本地或服务器环境，不提交仓库。

个股异动主动扫描相关配置：

```env
EM_MONITOR_BASE_URL=https://push2ex.eastmoney.com/getAllStockChanges
EM_MONITOR_QUOTE_BASE_URL=https://push2.eastmoney.com/api/qt/ulist.np/get
EM_UT_TOKEN=7eea3edcaed734bea9cbfc24409ed989
EM_DPT=wzchanges
EM_PAGE_SIZE=64
EM_MONITOR_MAX_PAGES=20
EM_MONITOR_TIMEOUT_MS=10000
STOCK_MONITOR_CRON_ENABLED=true
STOCK_MONITOR_PUSH_ENABLED=true
STOCK_MONITOR_SCAN_ENRICH_ENABLED=true
STOCK_MONITOR_ENRICH_ENABLED=false
```

`STOCK_MONITOR_SCAN_ENRICH_ENABLED` 控制主动扫描入库时是否补全行情和行业，默认建议为 `true`。

`STOCK_MONITOR_ENRICH_ENABLED` 控制列表接口是否临时补全行情和行业，默认建议为 `false`，列表接口会优先快速返回已入库的异动事件。设置为 `true` 时，接口耗时会明显增加。

本地预览时可以临时关闭定时扫描和微信推送：

```env
STOCK_MONITOR_CRON_ENABLED=false
STOCK_MONITOR_PUSH_ENABLED=false
STOCK_MONITOR_SCAN_ENRICH_ENABLED=true
STOCK_MONITOR_ENRICH_ENABLED=false
```

本地预览：

```bash
npm install
npm run build
npm run dev
```

常用检查：

```bash
curl http://localhost:3000/health
curl "http://localhost:3000/api/cn/monitor/events?limit=5"
curl http://localhost:3000/api/cn/monitor/stats
```

如果线上曾经启动过旧爬虫进程，部署后手动执行一次：

```bash
pm2 delete crawler-eastmoney-monitor
```
