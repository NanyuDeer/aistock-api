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

CREATE TABLE IF NOT EXISTS wechat_push_logs (
    id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL,
    openid TEXT NOT NULL,
    symbol TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    level TEXT NOT NULL,
    summary TEXT NOT NULL,
    template_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
    error_msg TEXT,
    wechat_response_json JSONB,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    click_url TEXT,

    CONSTRAINT uq_wechat_push_logs_event_openid UNIQUE(event_id, openid)
);

CREATE INDEX IF NOT EXISTS idx_wechat_push_logs_openid_sent_at
ON wechat_push_logs(openid, sent_at);

CREATE INDEX IF NOT EXISTS idx_wechat_push_logs_symbol_sent_at
ON wechat_push_logs(symbol, sent_at);

CREATE INDEX IF NOT EXISTS idx_wechat_push_logs_status
ON wechat_push_logs(status);
