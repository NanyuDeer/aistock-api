-- 个股异动事件表
-- 来源: crawlers/sources/eastmoney.com (monitor_event 模块)
CREATE TABLE IF NOT EXISTS stock_monitor_events (
    event_id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL,
    summary TEXT NOT NULL,
    event_time TIMESTAMPTZ NOT NULL,
    detail_url TEXT,
    raw_data_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_monitor_events_symbol_time
ON stock_monitor_events(symbol, event_time);

CREATE INDEX IF NOT EXISTS idx_stock_monitor_events_type_level
ON stock_monitor_events(event_type, level);
