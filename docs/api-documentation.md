# API Documentation — API 接口文档

> AI Stock Web 后端 RESTful API 接口定义

---

## 概述

- **Base URL**: `/api`
- **认证方式**: JWT Token

---

## 认证接口

### 1. 微信扫码登录

**接口**: `GET /api/auth/wechat/login`

---

### 2. 用户登出

**接口**: `POST /api/auth/logout`

---

## 行情接口

### 3. 获取股票实时行情

**接口**: `GET /api/cn/stocks/:symbol`

---

### 4. 获取资金流向

**接口**: `GET /api/cn/stocks/:symbol/capital-flow`

---

## 监控接口

### 5. 获取风口龙头

**接口**: `GET /api/cn/wind-leaders`

---

### 6. 获取异动捕手数据

**接口**: `GET /api/cn/institution-research`

---

## 更新日志

| 日期 | 版本 | 说明 |
|------|------|------|
| 2026-07-03 | 0.1.0 | 初始版本 |