# Database Schema — 数据库表结构文档

> AI Stock Web 后端数据库设计（PostgreSQL）

---

## 核心表结构

### 1. `stock_concept_mapping` — 股票概念映射表

```sql
CREATE TABLE stock_concept_mapping (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL,
    sector_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(symbol, sector_name)
);
```

---

### 2. `institution_research_history` — 机构调研历史表

```sql
CREATE TABLE institution_research_history (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMP NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    stock_name VARCHAR(50) NOT NULL,
    resonance_score DECIMAL(5,2),
    resonance_level VARCHAR(20),
    price DECIMAL(10,2),
    change_pct DECIMAL(5,2)
);
```

---

### 3. `earnings_forecast` — 业绩预测表

```sql
CREATE TABLE earnings_forecast (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL,
    update_time TIMESTAMP NOT NULL,
    summary TEXT,
    forecast_netprofit_yoy DECIMAL(5,2)
);
```

---

## 更新日志

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-03 | 0.1.0 | 初始版本 |