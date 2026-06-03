# Crawlers

`crawlers` 是 AI Stock 的数据采集层，主要负责从外部数据源抓取数据，整理成后端可识别的事件结构，再通过后端内部 API 写入数据库。

当前真正落地的爬虫模块是东方财富 `monitor_event`，用于支撑前端的“个股异动监测”。

## 核心链路

```text
东方财富异动接口
  -> crawlers/sources/eastmoney.com
  -> 本地 JSON 去重和备份
  -> POST /api/internal/monitor-events
  -> stock_monitor_events 表
  -> GET /api/cn/monitor/events
  -> 首页个股异动 / 个股详情异动 / 异动监测页
```

爬虫只负责采集和推送。前端不直接访问爬虫，也不直接访问东方财富，而是统一访问后端 API。

## 目录说明

```text
crawlers/
  sources/
    eastmoney.com/       # 东方财富数据源，当前 monitor_event 已实现
      crawler.py         # 入口脚本，支持 --module 和 --once
      scraper.py         # 异动采集主逻辑
      storage.py         # JSON 存储、去重、推送后端
      em_config.py       # 东方财富接口参数和启用的异动类型
      requirements.txt   # Python 依赖
    cls.cn/              # 财联社数据源入口，当前为预留
    10jqka.com.cn/       # 同花顺数据源入口，当前为预留
    tushare.pro/         # Tushare 数据源入口，当前为预留
  common/
    push_client.py       # 调用后端内部 API
    request_helper.py    # UA、JSONP、延迟等请求辅助逻辑
    proxy_pool.py        # 代理池
    logger.py            # 日志
  config/
    settings.py          # 全局配置和环境变量
    change_types.py      # 异动类型、级别、周期映射
  schemas/
    stock_monitor_events.sql
    wechat_push_logs.sql
  data/                  # 运行后产生的本地 JSON，默认不提交
```

## 当前数据源状态

| 数据源 | 路径 | 状态 | 说明 |
| --- | --- | --- | --- |
| 东方财富 | `sources/eastmoney.com` | 已实现 `monitor_event` | 抓取全市场盘口异动，推送给后端 |
| 财联社 | `sources/cls.cn` | 预留 | 入口存在，具体爬取逻辑未实现 |
| 同花顺 | `sources/10jqka.com.cn` | 预留 | 入口存在，具体爬取逻辑未实现 |
| Tushare | `sources/tushare.pro` | 预留 | 入口存在，具体爬取逻辑未实现 |

注意：后端里有多个 `Em*Service`、`Tushare*Service`，它们不一定来自这里的 Python 爬虫。有些数据是后端服务直接请求第三方接口。

## 东方财富 monitor_event

`monitor_event` 用于抓取东方财富“盘口异动”数据。它会按异动类型分页拉取数据，解析后生成统一事件。

主要文件：

| 文件 | 作用 |
| --- | --- |
| `sources/eastmoney.com/crawler.py` | 命令行入口，默认执行 `monitor_event` |
| `sources/eastmoney.com/scraper.py` | 请求东方财富接口，解析异动数据，控制循环采集 |
| `sources/eastmoney.com/storage.py` | 按日期写入 JSON，做内存去重，并推送后端 |
| `sources/eastmoney.com/em_config.py` | 东方财富接口地址、分页大小、启用的异动类型 |
| `config/change_types.py` | 异动代码、名称、级别、周期分类 |

采集结果会先写入 `data/em_stock_changes_YYYYMMDD.json`，同时推送到后端。去重键是 `stock_code + event_time`，用于避免同一轮循环反复写入同一条异动。

## 异动类型

| 代码 | 名称 | 级别 | 周期 |
| --- | --- | --- | --- |
| 4 | 封涨停板 | L4 | 短线 |
| 8 | 封跌停板 | L4 | 短线 |
| 16 | 打开涨停板 | L4 | 短线 |
| 32 | 打开跌停板 | L4 | 短线 |
| 64 | 快速反弹 | L3 | 短线 |
| 128 | 高台跳水 | L3 | 短线 |
| 8193 | 火箭发射 | L3 | 短线 |
| 8194 | 加速下跌 | L3 | 短线 |
| 8201 | 大笔买入 | L2 | 短线 |
| 8202 | 大笔卖出 | L2 | 短线 |
| 8203 | 有大买盘 | L2 | 短线 |
| 8204 | 有大卖盘 | L2 | 短线 |
| 8215 | 竞价上涨 | L2 | 短线 |
| 8216 | 竞价下跌 | L2 | 短线 |
| 8207 | 高开5日线 | L1 | 中线 |
| 8208 | 低开5日线 | L1 | 中线 |
| 8209 | 向上缺口 | L1 | 中线 |
| 8210 | 向下缺口 | L1 | 中线 |
| 8211 | 60日新高 | L1 | 中线 |
| 8212 | 60日新低 | L1 | 中线 |
| 8213 | 60日大幅上涨 | L3 | 长线 |
| 8214 | 60日大幅下跌 | L3 | 长线 |

周期用于前端筛选：

| 周期 | 含义 |
| --- | --- |
| 短线 | 盘中实时交易异动，如涨跌停、火箭发射、大笔买卖 |
| 中线 | 技术形态异动，如 5 日线、缺口、60 日新高新低 |
| 长线 | 趋势型异动，如 60 日大幅上涨或下跌 |

## 运行方式

先确保后端服务已启动，并且数据库已创建 `stock_monitor_events` 表。

```bash
cd aistock-api/crawlers
pip install -r sources/eastmoney.com/requirements.txt
```

初始化数据库：

```bash
psql -h localhost -U postgres -d aistock -f schemas/stock_monitor_events.sql
```

单次采集：

```bash
python sources/eastmoney.com/crawler.py --module monitor_event --once
```

交易时间内循环采集：

```bash
python sources/eastmoney.com/crawler.py --module monitor_event
```

默认模块就是 `monitor_event`，所以也可以直接运行：

```bash
python sources/eastmoney.com/crawler.py
```

## 关键环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `API_BASE_URL` | 后端 API 地址 | `http://localhost:3000` |
| `INTERNAL_TOKEN` | 爬虫推送后端时使用的内部 token | `crawler-int-2026-token` |
| `DATA_DIR` | 本地 JSON 数据目录 | `crawlers/data` |
| `USE_PROXY` | 是否启用代理池 | `true` |
| `REQUEST_DELAY_MIN` | 请求最小延迟秒数 | `2.5` |
| `REQUEST_DELAY_MAX` | 请求最大延迟秒数 | `5.0` |
| `TRADE_START_HOUR` / `TRADE_START_MINUTE` | 采集开始时间 | `9:15` |
| `TRADE_END_HOUR` / `TRADE_END_MINUTE` | 采集结束时间 | `15:30` |
| `EM_MONITOR_BASE_URL` | 东方财富异动接口 | `https://push2ex.eastmoney.com/getAllStockChanges` |
| `EM_PAGE_SIZE` | 东方财富分页大小 | `64` |

`INTERNAL_TOKEN` 必须和后端环境变量 `INTERNAL_API_TOKEN` 保持一致，否则 `/api/internal/monitor-events` 会返回 401。

## 推送到后端

爬虫通过 `common/push_client.py` 调用后端内部接口：

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/internal/monitor-events` | POST | 推送单条异动事件 |
| `/api/internal/monitor-events/batch` | POST | 批量推送异动事件 |

请求头需要携带：

```text
x-internal-token: <INTERNAL_TOKEN>
```

单条事件示例：

```json
{
  "event_id": "20260603_103000_300308",
  "symbol": "SZ300308",
  "stock_name": "中际旭创",
  "event_type": "8193",
  "level": "L3",
  "summary": "火箭发射",
  "event_time": "10:30:00",
  "detail_url": "https://quote.eastmoney.com/sz300308.html",
  "raw_data_json": {
    "change_type": "8193",
    "event_type": "短线异动"
  }
}
```

后端会把事件写入 `stock_monitor_events`，并按用户关注关系触发微信推送。

## 后端查询接口

前端展示异动数据时使用这些公开接口：

| 接口 | 说明 |
| --- | --- |
| `GET /api/cn/monitor/events` | 查询当日全市场异动列表 |
| `GET /api/cn/monitor/events/:stockCode` | 查询指定股票的当日异动 |
| `GET /api/cn/monitor/stats` | 查询当日异动统计 |

常用参数：

| 参数 | 说明 |
| --- | --- |
| `cycle` | `all`、`short`、`mid`、`long` |
| `change_type` | 异动类型代码，如 `4`、`8193` |
| `stock_code` | 股票代码，支持 `300308`、`SZ300308`、`SH600519` |
| `limit` | 返回数量，最大 100 |
| `offset` | 分页偏移 |

`StockMonitorService` 会从数据库读取当日异动，并补充实时行情和行业信息。前端拿到的数据包含股票代码、股票名称、异动类型、级别、周期、价格、涨跌幅、量比、换手率和时间。

## 首页个股异动

首页使用 `HomeView.vue` 中的 `fetchMonitorEvents()` 拉取数据：

```js
monitorApi.getEvents({ cycle: 'all', limit: 8 })
```

然后把结果传给 `StockMonitorCard`：

```vue
<StockMonitorCard :events="monitorEvents" />
```

首页模块的定位是“全市场最新异动概览”：

| 行为 | 说明 |
| --- | --- |
| 默认展示 | 最近 8 条当日异动 |
| 周期筛选 | `StockMonitorCard` 内部按 `all/short/mid/long` 筛选 |
| 查看全部 | 点击“查看全部”进入 `/monitor` |
| 点击股票 | 跳转到对应个股详情页 |

也就是说，首页不做采集，只展示后端已经入库的最新异动。

## 个股详情页异动

个股详情页使用 `StockDetailView.vue` 中的 `fetchMonitorEvents()` 拉取当前股票的数据：

```js
monitorApi.getEventsByStock(stockCode, { cycle: 'all', limit: 20 })
```

然后传给 `StockMonitorList`：

```vue
<StockMonitorList
  :events="stockMonitorEvents"
  :show-cycle-filter="true"
  :default-cycle="activeView === 'short' ? 'short' : activeView === 'mid' ? 'mid' : activeView === 'long' ? 'long' : 'all'"
/>
```

个股详情页模块的定位是“当前股票的异动记录”：

| 行为 | 说明 |
| --- | --- |
| 默认展示 | 当前股票最近 20 条当日异动 |
| 周期筛选 | 跟随详情页当前视图，支持短线、中线、长线 |
| 展示内容 | 异动类型、级别、价格、涨跌幅、量比、换手率、触发时间 |

所以同一套爬虫数据会在两个地方使用：首页展示全市场最新异动，个股详情页展示某只股票自己的异动历史。

## 维护要点

1. 新增异动类型时，需要同步更新 `config/change_types.py`、后端 `StockMonitorService.ts`、前端 `mock/monitorEvents.js` 中的映射。
2. 修改推送字段时，需要同时检查 `storage.py` 和 `MonitorEventController.ts`。
3. 如果前端没有数据，先确认爬虫是否推送成功，再查 `stock_monitor_events` 是否有当日记录。
4. 如果内部推送返回 401，优先检查 `INTERNAL_TOKEN` 和 `INTERNAL_API_TOKEN` 是否一致。
