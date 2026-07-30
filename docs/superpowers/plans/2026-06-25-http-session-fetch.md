# HTTP Session (KeepAlive) 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 aistock-api 中所有外部 HTTP 请求引入 session（keepAlive 连接复用），减少 TCP/TLS 握手开销，降低被反爬封禁的风险。

**Architecture:** 利用 Node.js 内置的 `http.Agent` / `https.Agent`（已原生支持 `keepAlive`），创建 `src/utils/httpAgent.ts` 工具文件，按域名维护独立的 Agent 实例。提供 `sessionFetch` 函数（签名兼容原生 `fetch`）替代裸 `fetch`，各 Service 文件按需引入。**零新依赖**，无需安装任何额外 npm 包。

**Tech Stack:** Node.js 24 (CJS), 原生 `http`/`https` 模块, TypeScript

---

## 文件结构

| 操作           | 文件                                              | 职责                                                        |
| -------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| **创建** | `src/utils/httpAgent.ts`                        | 按域名管理 keepAlive Agent 实例，提供 `sessionFetch` 函数 |
| **修改** | `src/services/TushareService.ts`                | Tushare API 请求改用 sessionFetch                           |
| **修改** | `src/services/EmQuoteService.ts`                | 东方财富行情改用 sessionFetch                               |
| **修改** | `src/services/EmInfoService.ts`                 | 东方财富基本信息改用 sessionFetch                           |
| **修改** | `src/services/EmKlineService.ts`                | 东方财富K线改用 sessionFetch                                |
| **修改** | `src/services/EmStockRankService.ts`            | 东方财富排行改用 sessionFetch                               |
| **修改** | `src/services/EmTagLeaderService.ts`            | 东方财富标签龙头改用 sessionFetch                           |
| **修改** | `src/controllers/IndexQuoteController.ts`       | 腾讯行情改用 sessionFetch                                   |
| **修改** | `src/services/ThsService.ts`                    | 同花顺改用 sessionFetch                                     |
| **修改** | `src/services/HotKeywordDetectorService.ts`     | 财联社/格隆汇改用 sessionFetch                              |
| **修改** | `src/services/ClsStockNewsService.ts`           | 财联社个股新闻改用 sessionFetch                             |
| **修改** | `src/services/WindLeaderAnalyzerService.ts`     | 同花顺板块轮动 + AI 调用改用 sessionFetch                   |
| **修改** | `src/controllers/ProfitForecastController.ts`   | 同花顺盈利预测改用 sessionFetch                             |
| **修改** | `src/services/StockAnalysisService.ts`          | AI API 改用 sessionFetch                                    |
| **修改** | `src/services/StockAnalysisAgentService.ts`     | AI Agent API 改用 sessionFetch                              |
| **修改** | `src/services/TushareCapitalFlowService.ts`     | AI API 改用 sessionFetch                                    |
| **修改** | `src/services/IndustryKGService.ts`             | AI API 改用 sessionFetch                                    |
| **修改** | `src/services/StockOcrService.ts`               | AI API 改用 sessionFetch                                    |
| **修改** | `src/utils/crawler.ts`                          | 通用爬虫工具改用 sessionFetch                               |
| **修改** | `src/services/crawler/EastmoneyCrawler.ts`      | 东方财富爬虫改用 sessionFetch                               |
| **修改** | `src/services/crawler/StockInfoJudgeService.ts` | 个股研判爬虫改用 sessionFetch                               |
| **修改** | `src/controllers/NewsController.ts`             | 新闻接口改用 sessionFetch                                   |
| **修改** | `src/index.ts`                                  | 进程退出时清理连接池                                        |

---

## Task 1: 创建 httpAgent 工具模块

**Files:**

- Create: `src/utils/httpAgent.ts`

**关键决策：** 使用 Node.js 原生 `http.Agent` / `https.Agent`（`keepAlive: true`），通过 `http.request` / `https.request` 发起请求，封装为 Promise 并返回类 `Response` 对象。零新依赖，服务器无需 sudo 权限。

- [ ] **Step 1: 创建 `src/utils/httpAgent.ts`**

```typescript
/**
 * HTTP Session 管理 - 按域名维护 keepAlive 连接池
 *
 * 使用方式：
 *   import { sessionFetch } from '../utils/httpAgent';
 *   const response = await sessionFetch('https://push2.eastmoney.com/api/qt/stock/get', { ... });
 *
 * 原理：Node.js 原生 http.Agent/https.Agent 的 keepAlive 复用 TCP/TLS 连接，
 * 减少握手开销，降低反爬风险。每个域名独立 Agent，避免连接池互相影响。
 * 零新依赖，无需 sudo 权限。
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

/** Agent 配置选项 */
interface AgentPoolConfig {
    keepAlive: boolean;
    keepAliveMsecs: number;
    maxSockets: number;
    maxFreeSockets: number;
    timeout: number;
}

/** 默认配置：空闲连接保持 30 秒，最多 20 个并发 socket */
const DEFAULT_CONFIG: AgentPoolConfig = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 20,
    maxFreeSockets: 5,
    timeout: 60_000,
};

/** 高频域名专用配置（东方财富、腾讯行情）：更多并发连接 */
const HIGH_FREQ_CONFIG: AgentPoolConfig = {
    ...DEFAULT_CONFIG,
    maxSockets: 30,
    maxFreeSockets: 10,
};

/** 域名 → Agent 缓存 */
const agentCache = new Map<string, http.Agent | https.Agent>();

/**
 * 域名归一化：同一主域名的不同子域名共享 Agent
 * 例如 push2.eastmoney.com 和 86.push2.eastmoney.com → eastmoney
 */
function normalizeDomain(url: string): string {
    try {
        const hostname = new URL(url).hostname;
        if (hostname.includes('eastmoney')) return 'eastmoney';
        if (hostname.includes('tushare')) return 'tushare';
        if (hostname.includes('gtimg')) return 'tencent';
        if (hostname.includes('10jqka') || hostname.includes('ths')) return 'ths';
        if (hostname.includes('cls.cn')) return 'cls';
        if (hostname.includes('gelonghui')) return 'gelonghui';
        return hostname;
    } catch {
        return 'default';
    }
}

function getAgent(url: string): http.Agent | https.Agent {
    const domain = normalizeDomain(url);
    let agent = agentCache.get(domain);
    if (agent) return agent;

    const isHttps = url.startsWith('https');
    const isHighFreq = ['eastmoney', 'tencent'].includes(domain);
    const config = isHighFreq ? HIGH_FREQ_CONFIG : DEFAULT_CONFIG;

    if (isHttps) {
        agent = new https.Agent(config);
    } else {
        agent = new http.Agent(config);
    }
    agentCache.set(domain, agent);
    return agent;
}

/**
 * sessionFetch - 带 keepAlive 连接复用的 fetch
 *
 * 签名与原生 fetch 兼容：接受 URL + RequestInit，返回 Response。
 * 所有外部 HTTP 请求应使用此函数替代原生 fetch。
 */
export function sessionFetch(
    url: string | URL,
    init?: RequestInit,
): Promise<Response> {
    const urlStr = String(url);
    const parsedUrl = new URL(urlStr);
    const agent = getAgent(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';

    // 解析 headers
    const headers: Record<string, string> = {};
    if (init?.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => { headers[key] = value; });
        } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([key, value]) => { headers[key] = value; });
        } else {
            Object.assign(headers, init.headers);
        }
    }

    return new Promise((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: (init?.method || 'GET').toUpperCase(),
            headers,
            agent,
        };

        // 处理超时
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        if (init?.signal) {
            if (init.signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            init.signal.addEventListener('abort', () => {
                if (timeoutId) clearTimeout(timeoutId);
                req.destroy();
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
        }

        const transport = isHttps ? https : http;
        const req = transport.request(options, (res) => {
            if (timeoutId) clearTimeout(timeoutId);

            // 读取响应体
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                const responseHeaders = new Headers();
                if (res.headers) {
                    for (const [key, value] of Object.entries(res.headers)) {
                        if (value !== undefined) {
                            if (Array.isArray(value)) {
                                value.forEach(v => responseHeaders.append(key, v));
                            } else {
                                responseHeaders.set(key, value);
                            }
                        }
                    }
                }

                resolve(new Response(body.length > 0 ? body : null, {
                    status: res.statusCode || 500,
                    statusText: res.statusMessage || '',
                    headers: responseHeaders,
                }));
            });
        });

        req.on('error', (err) => {
            if (timeoutId) clearTimeout(timeoutId);
            reject(err);
        });

        // 处理 AbortSignal.timeout
        if (init?.signal && 'timeout' in init.signal) {
            // AbortSignal.timeout 返回的信号自带超时
        }

        // 发送请求体
        if (init?.body) {
            if (typeof init.body === 'string') {
                req.write(init.body);
            } else if (init.body instanceof Uint8Array) {
                req.write(Buffer.from(init.body));
            } else if (typeof (init.body as any).pipe === 'function') {
                (init.body as any).pipe(req);
                return; // stream 自动 end
            }
        }
        req.end();
    });
}

/**
 * 关闭指定域名的 Agent（连接池）
 */
export function closeAgent(domain: string): void {
    const agent = agentCache.get(domain);
    if (agent) {
        agent.destroy();
        agentCache.delete(domain);
    }
}

/**
 * 关闭所有连接池（进程退出时调用）
 */
export function closeAllAgents(): void {
    for (const [domain, agent] of agentCache) {
        agent.destroy();
    }
    agentCache.clear();
}
```

- [ ] **Step 2: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit src/utils/httpAgent.ts
```

Expected: 无错误输出

- [ ] **Step 3: Commit**

```bash
git add src/utils/httpAgent.ts
git commit -m "feat: add httpAgent utility with keepAlive connection pooling (zero dependencies)"
```

---

## Task 2: 改造第一档 — Tushare API

**Files:**

- Modify: `src/services/TushareService.ts`

- [ ] **Step 1: 修改 `TushareService.ts`**

在文件顶部 import 区域添加：

```typescript
import { sessionFetch } from '../utils/httpAgent';
```

将 `fetch` 调用替换（约第 36 行）：

```typescript
// 旧：
const response = await fetch('https://api.tushare.pro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
});

// 新：
const response = await sessionFetch('https://api.tushare.pro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
});
```

- [ ] **Step 2: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/services/TushareService.ts
git commit -m "feat: use sessionFetch for Tushare API requests"
```

---

## Task 3: 改造第一档 — 东方财富系列（5 个文件）

**Files:**

- Modify: `src/services/EmQuoteService.ts`
- Modify: `src/services/EmInfoService.ts`
- Modify: `src/services/EmKlineService.ts`
- Modify: `src/services/EmStockRankService.ts`
- Modify: `src/services/EmTagLeaderService.ts`

- [ ] **Step 1: 修改 `EmQuoteService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 getQuote 方法中的 `fetch(url, { ... })` 替换为 `sessionFetch(url, { ... })`
```

- [ ] **Step 2: 修改 `EmInfoService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 getStockInfo 方法中的 `fetch(url, { ... })` 替换为 `sessionFetch(url, { ... })`
```

- [ ] **Step 3: 修改 `EmKlineService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch 调用替换为 sessionFetch
```

- [ ] **Step 4: 修改 `EmStockRankService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 `fetch(this.RANK_URL, { ... })` 替换为 `sessionFetch(this.RANK_URL, { ... })`
```

- [ ] **Step 5: 修改 `EmTagLeaderService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch 调用替换为 sessionFetch
```

- [ ] **Step 6: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/services/EmQuoteService.ts src/services/EmInfoService.ts src/services/EmKlineService.ts src/services/EmStockRankService.ts src/services/EmTagLeaderService.ts
git commit -m "feat: use sessionFetch for all EastMoney API requests"
```

---

## Task 4: 改造第一档 — 腾讯行情

**Files:**

- Modify: `src/controllers/IndexQuoteController.ts`

- [ ] **Step 1: 修改 `IndexQuoteController.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 在 fetchTencentIndexQuotes 函数中，将 `fetch(url, { ... })` 替换为 `sessionFetch(url, { ... })`
```

- [ ] **Step 2: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/controllers/IndexQuoteController.ts
git commit -m "feat: use sessionFetch for Tencent quote API"
```

---

## Task 5: 改造第二档 — 同花顺

**Files:**

- Modify: `src/services/ThsService.ts`
- Modify: `src/controllers/ProfitForecastController.ts`
- Modify: `src/services/WindLeaderAnalyzerService.ts`

- [ ] **Step 1: 修改 `ThsService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 `fetch(url, { headers: this.HEADERS })` 替换为 `sessionFetch(url, { headers: this.HEADERS })`
```

- [ ] **Step 2: 修改 `ProfitForecastController.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch 调用替换为 sessionFetch
```

- [ ] **Step 3: 修改 `WindLeaderAnalyzerService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将同花顺板块轮动 API 的 fetch 调用（约第 779 行）替换为 sessionFetch
```

- [ ] **Step 4: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/services/ThsService.ts src/controllers/ProfitForecastController.ts src/services/WindLeaderAnalyzerService.ts
git commit -m "feat: use sessionFetch for THS (10jqka) requests"
```

---

## Task 6: 改造第二档 — 财联社 + 格隆汇

**Files:**

- Modify: `src/services/HotKeywordDetectorService.ts`
- Modify: `src/services/ClsStockNewsService.ts`

- [ ] **Step 1: 修改 `HotKeywordDetectorService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 CLS_TELEGRAPH_URL 的 fetch 调用替换为 sessionFetch
// 将 GELONGHUI_URL 的 fetch 调用替换为 sessionFetch
```

- [ ] **Step 2: 修改 `ClsStockNewsService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将两处 fetch 调用替换为 sessionFetch
```

- [ ] **Step 3: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/services/HotKeywordDetectorService.ts src/services/ClsStockNewsService.ts
git commit -m "feat: use sessionFetch for CLS and Gelonghui requests"
```

---

## Task 7: 改造第三档 — AI API 系列（6 个文件）

**Files:**

- Modify: `src/services/StockAnalysisService.ts`
- Modify: `src/services/WindLeaderAnalyzerService.ts`（AI 部分）
- Modify: `src/services/IndustryKGService.ts`
- Modify: `src/services/StockOcrService.ts`
- Modify: `src/services/TushareCapitalFlowService.ts`
- Modify: `src/services/StockAnalysisAgentService.ts`

- [ ] **Step 1: 修改 `StockAnalysisService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将两处 fetch(apiBaseUrl, { ... }) 替换为 sessionFetch(apiBaseUrl, { ... })
```

- [ ] **Step 2: 修改 `WindLeaderAnalyzerService.ts`（AI 分析部分）**

```typescript
// 文件顶部添加 import（如果 Step 5 未添加）：
import { sessionFetch } from '../utils/httpAgent';

// 将 AI chatUrl 的 3 处 fetch 调用替换为 sessionFetch（约第 706、1297、1606 行）
```

- [ ] **Step 3: 修改 `IndustryKGService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch(chatUrl, { ... }) 替换为 sessionFetch(chatUrl, { ... })
```

- [ ] **Step 4: 修改 `StockOcrService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch(apiBaseUrl, { ... }) 替换为 sessionFetch(apiBaseUrl, { ... })
```

- [ ] **Step 5: 修改 `TushareCapitalFlowService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch(apiBaseUrl, { ... }) 替换为 sessionFetch(apiBaseUrl, { ... })
```

- [ ] **Step 6: 修改 `StockAnalysisAgentService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将 fetch(this.buildModelUrl(), { ... }) 替换为 sessionFetch(this.buildModelUrl(), { ... })
```

- [ ] **Step 7: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add src/services/StockAnalysisService.ts src/services/WindLeaderAnalyzerService.ts src/services/IndustryKGService.ts src/services/StockOcrService.ts src/services/TushareCapitalFlowService.ts src/services/StockAnalysisAgentService.ts
git commit -m "feat: use sessionFetch for AI API requests"
```

---

## Task 8: 改造第三档 — 爬虫工具和其他

**Files:**

- Modify: `src/utils/crawler.ts`
- Modify: `src/services/crawler/EastmoneyCrawler.ts`
- Modify: `src/services/crawler/StockInfoJudgeService.ts`
- Modify: `src/controllers/NewsController.ts`

- [ ] **Step 1: 修改 `crawler.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from './httpAgent';

// 将 `return fetch(url, { headers })` 替换为 `return sessionFetch(url, { headers })`
```

- [ ] **Step 2: 修改 `EastmoneyCrawler.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../../utils/httpAgent';

// 将 5 处 fetch(...) 调用全部替换为 sessionFetch(...)
```

- [ ] **Step 3: 修改 `StockInfoJudgeService.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../../utils/httpAgent';

// 将 fetch(url, { ... }) 替换为 sessionFetch(url, { ... })
```

- [ ] **Step 4: 修改 `NewsController.ts`**

```typescript
// 文件顶部添加 import：
import { sessionFetch } from '../utils/httpAgent';

// 将两处 fetch(...) 调用替换为 sessionFetch(...)
```

- [ ] **Step 5: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/utils/crawler.ts src/services/crawler/EastmoneyCrawler.ts src/services/crawler/StockInfoJudgeService.ts src/controllers/NewsController.ts
git commit -m "feat: use sessionFetch for crawler and news requests"
```

---

## Task 9: 不改造项 — 微信推送（保持原样）

**Files:** 无修改

微信推送服务（`WechatPushService.ts`、`ScanLoginController.ts`、`AuthController.ts`）调用 `api.weixin.qq.com`，频率极低（仅推送通知时触发），且每次可能更换 token，session 复用收益为零。**不需要改造。**

---

## Task 10: 进程退出时清理连接池

**Files:**

- Modify: `src/index.ts`

- [ ] **Step 1: 在 `src/index.ts` 顶部添加 import**

```typescript
import { closeAllAgents } from './utils/httpAgent';
```

- [ ] **Step 2: 在 `start()` 函数末尾、`app.listen` 之后添加进程退出钩子**

```typescript
// 优雅退出时关闭所有 HTTP 连接池
process.on('SIGINT', () => {
    closeAllAgents();
    process.exit(0);
});
process.on('SIGTERM', () => {
    closeAllAgents();
    process.exit(0);
});
```

- [ ] **Step 3: 验证编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: add graceful HTTP agent shutdown on process exit"
```

---

## Task 11: 全量编译验证 + 启动测试

- [ ] **Step 1: 全量编译**

```bash
cd d:\ai_stock\aistock-api
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 2: 启动服务验证**

```bash
cd d:\ai_stock\aistock-api
npx tsx src/index.ts
```

Expected: 服务正常启动，日志中出现 `[Server] aistock-api running on http://0.0.0.0:PORT`

- [ ] **Step 3: 最终 Commit（如有编译错误修复）**

---

## 改造优先级总结

| 优先级 | Task                        | 覆盖率      | 改动量  |
| ------ | --------------------------- | ----------- | ------- |
| P0     | Task 1 (工具模块)           | 基础设施    | 1 新建  |
| P0     | Task 2 (Tushare)            | ~30% 请求量 | 1 文件  |
| P0     | Task 3-4 (东方财富 + 腾讯)  | ~25% 请求量 | 6 文件  |
| P1     | Task 5-6 (同花顺 + 财联社)  | ~20% 请求量 | 5 文件  |
| P2     | Task 7-8 (AI API + 爬虫)    | ~25% 请求量 | 10 文件 |
| P0     | Task 9-10 (不改造项 + 清理) | 稳定性      | 1 文件  |
| P0     | Task 11 (验证)              | 质量保障    | -       |

## 不改造项汇总

| 服务     | 文件                       | 域名              | 理由                 |
| -------- | -------------------------- | ----------------- | -------------------- |
| 微信推送 | `WechatPushService.ts`   | api.weixin.qq.com | 极低频，每次换 token |
| 微信登录 | `ScanLoginController.ts` | api.weixin.qq.com | 极低频               |
| 微信授权 | `AuthController.ts`      | api.weixin.qq.com | 极低频               |
