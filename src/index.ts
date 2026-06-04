import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import cron from 'node-cron';

import pool from './db';
import redis from './redis';

import { ProfitForecastController } from './controllers/ProfitForecastController';
import { StockInfoController } from './controllers/StockInfoController';
import { StockQuoteController } from './controllers/StockQuoteController';
import { StockRankController } from './controllers/StockRankController';
import { StockListController } from './controllers/StockListController';
import { IndexQuoteController } from './controllers/IndexQuoteController';
import { TagLeaderController } from './controllers/TagLeaderController';
import { NewsController } from './controllers/NewsController';
import { AuthController } from './controllers/AuthController';
import { UserController } from './controllers/UserController';
import { WechatEventController } from './controllers/WechatEventController';
import { ScanLoginController } from './controllers/ScanLoginController';
import { StockAnalysisController } from './controllers/StockAnalysisController';
import { StockOcrController } from './controllers/StockOcrController';
import { TenxScoreController } from './controllers/TenxScoreController';
import { CapitalFlowController } from './controllers/CapitalFlowController';
import { MonitorEventController } from './controllers/MonitorEventController';
import { StockMonitorController } from './controllers/StockMonitorController';
import { PotentialStockPushController } from './controllers/PotentialStockPushController';
import { TenxBatchService } from './services/TenxBatchService';
import { isValidAShareSymbol } from './utils/validator';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN || '';
const allowedOrigins = corsAllowOrigin.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
            callback(null, true);
        } else {
            callback(null, false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-token'],
    maxAge: 86400,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/xml' }));
app.use(express.urlencoded({ extended: true }));

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 3000) {
            console.log(`[Slow] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
        }
    });
    next();
});

app.get('/', (_req, res) => {
    res.json({
        code: 200,
        message: 'healthy',
        data: {
            status: 'ok',
            service: 'aistock-api',
            timestamp: new Date().toISOString(),
        },
    });
});

app.get('/health', async (_req, res) => {
    let pgOk = false;
    let redisOk = false;
    try {
        await pool.query('SELECT 1');
        pgOk = true;
    } catch {}
    try {
        await redis.ping();
        redisOk = true;
    } catch {}
    const ok = pgOk && redisOk;
    res.status(ok ? 200 : 503).json({
        code: ok ? 200 : 503,
        message: ok ? 'healthy' : 'degraded',
        data: { postgresql: pgOk, redis: redisOk },
    });
});

app.get('/api/auth/wechat/login', (req, res, next) => AuthController.login(req, res, next));
app.get('/api/auth/wechat/callback', (req, res, next) => AuthController.callback(req, res, next));
app.all('/api/auth/wechat/push', (req, res, next) => WechatEventController.handle(req, res, next));
app.get('/api/auth/wechat/login/scan', (req, res, next) => ScanLoginController.generateQrCode(req, res, next));
app.get('/api/auth/wechat/login/scan/poll', (req, res, next) => ScanLoginController.poll(req, res, next));
app.post('/api/auth/logout', (req, res, next) => AuthController.logout(req, res, next));

app.get('/api/users/me', (req, res, next) => UserController.me(req, res, next));
app.get('/api/users/me/settings', (req, res, next) => UserController.getSettings(req, res, next));
app.put('/api/users/me/settings/:settingType', (req, res, next) => UserController.updateSetting(req, res, next));
app.get('/api/users/me/news/push', (req, res, next) => UserController.getPushNews(req, res, next));
app.get('/api/users/me/push-history', (req, res, next) => UserController.getPushHistory(req, res, next));
app.get('/api/users/me/push-ranking', (req, res, next) => UserController.getPushRanking(req, res, next));
app.post('/api/users/me/favorites', (req, res, next) => UserController.addFavorites(req, res, next));
app.delete('/api/users/me/favorites', (req, res, next) => UserController.removeFavorites(req, res, next));
app.post('/api/users/me/favorites/delete', (req, res, next) => UserController.removeFavorites(req, res, next));

app.post('/api/internal/monitor-events', (req, res, next) => MonitorEventController.mockMonitorEvent(req, res, next));
app.post('/api/internal/monitor-events/batch', (req, res, next) => MonitorEventController.mockMonitorEvent(req, res, next));

// 个股异动监测 - 前端查询接口
app.get('/api/cn/monitor/events', (req, res, next) => StockMonitorController.getEvents(req, res, next));
app.get('/api/cn/monitor/events/:stockCode', (req, res, next) => StockMonitorController.getEventsByStock(req, res, next));
app.get('/api/cn/monitor/stats', (req, res, next) => StockMonitorController.getStats(req, res, next));

app.get('/api/potential-stocks/push-history', (req, res, next) => PotentialStockPushController.getHistory(req, res, next));
app.get('/api/potential-stocks/push-ranking', (req, res, next) => PotentialStockPushController.getRanking(req, res, next));

app.get('/api/cn/market/stockrank', (req, res, next) => StockRankController.getHotRank(req, res, next));
app.get('/api/cn/stocks', (req, res, next) => StockListController.getStockList(req, res, next));
app.get('/api/cn/stock/infos', (req, res, next) => StockInfoController.getBatchStockInfo(req, res, next));
app.get('/api/cn/stock/quotes/core', (req, res, next) => StockQuoteController.getCoreQuotes(req, res, next));
app.get('/api/cn/stock/quotes/activity', (req, res, next) => StockQuoteController.getActivityQuotes(req, res, next));
app.get('/api/cn/stock/quotes/kline', (req, res, next) => StockQuoteController.getKLine(req, res, next));
app.get('/api/cn/stock/fundamentals', (req, res, next) => StockQuoteController.getFundamentalQuotes(req, res, next));
app.get('/api/cn/index/quotes', (req, res, next) => IndexQuoteController.getIndexQuotes(req, res, next));
app.get('/api/gb/index/quotes', (req, res, next) => IndexQuoteController.getGlobalIndexQuotes(req, res, next));

app.get('/api/cn/stocks/tenx-score/batch', (req, res, next) => TenxScoreController.batchRefresh(req, res, next));
app.post('/api/cn/stocks/tenx-score/batch', (req, res, next) => TenxScoreController.batchRefresh(req, res, next));
app.get('/api/cn/stocks/tenx-score/rebuild', (req, res, next) => TenxScoreController.rebuildAll(req, res, next));
app.get('/api/cn/stocks/profit-forecast', (req, res, next) => ProfitForecastController.getForecastList(req, res, next));
app.get('/api/cn/stocks/profit-forecast/search', (req, res, next) => ProfitForecastController.searchForecastList(req, res, next));
app.post('/api/cn/stocks/ocr', (req, res, next) => StockOcrController.batchOcr(req, res, next));

app.get('/api/cn/tags/:tagCode/leaders', (req, res, next) => TagLeaderController.getTagLeaders(req, res, next));

app.get('/api/cn/stocks/:symbol/capital-flow', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    CapitalFlowController.getCapitalFlow(req, res, next);
});

app.post('/api/cn/capital-flow/batch-prefetch', (req, res, next) => CapitalFlowController.batchPrefetch(req, res, next));
app.get('/api/cn/capital-flow/batch-status', (req, res, next) => CapitalFlowController.getBatchStatus(req, res, next));

app.get('/api/cn/stocks/:symbol/news', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    NewsController.getStockNews(req, res, next);
});

app.get('/api/cn/stocks/:symbol/analysis/history', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    StockAnalysisController.getStockAnalysisHistory(req, res, next);
});

app.route('/api/cn/stocks/:symbol/analysis')
    .get((req, res, next) => {
        if (!isValidAShareSymbol(req.params.symbol)) {
            res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
            return;
        }
        StockAnalysisController.handleStockAnalysis(req, res, next);
    })
    .post((req, res, next) => {
        if (!isValidAShareSymbol(req.params.symbol)) {
            res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
            return;
        }
        StockAnalysisController.handleStockAnalysis(req, res, next);
    });

app.get('/api/cn/stock/:symbol/profit-forecast', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    ProfitForecastController.getThsForecast(req, res, next);
});
app.post('/api/cn/stock/:symbol/profit-forecast', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    ProfitForecastController.getThsForecast(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.getScore(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score/history', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.getScoreHistory(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score/refresh', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.refreshScore(req, res, next);
});
app.post('/api/cn/stocks/:symbol/tenx-score/refresh', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.refreshScore(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score/veto-check', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.checkVeto(req, res, next);
});

app.get('/api/cn/stocks/tenx-score/top', (req, res, next) => {
    TenxScoreController.getTopStocks(req, res, next);
});

app.get('/api/news/headlines', (req, res, next) => NewsController.getHeadlines(req, res, next));
app.get('/api/news/cn', (req, res, next) => NewsController.getCnNews(req, res, next));
app.get('/api/news/hk', (req, res, next) => NewsController.getHkNews(req, res, next));
app.get('/api/news/gb', (req, res, next) => NewsController.getGlobalNews(req, res, next));
app.get('/api/news/fund', (req, res, next) => NewsController.getFundNews(req, res, next));
app.get('/api/news/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) {
        res.status(400).json({ code: 400, message: 'Invalid ID - ID 必须是数字' });
        return;
    }
    NewsController.getNewsDetail(req, res, next);
});

app.use((_req, res) => {
    res.status(404).json({ code: 404, message: 'Not Found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Error]', err.message);
    res.status(500).json({ code: 500, message: err.message || 'Internal Server Error' });
});

cron.schedule('0 4 * * *', async () => {
    console.log('[TenxCron] 开始批量评分');
    try {
        await TenxBatchService.run();
        console.log('[TenxCron] 批量评分完成');
    } catch (err: any) {
        console.error('[TenxCron] 批量评分失败:', err?.message || err);
    }
});

cron.schedule('5 19 * * 1-5', async () => {
    console.log('[CapitalFlowCron] 收盘后批量预取资金流向');
    try {
        const { isAShareTradingTime } = await import('./utils/tradingTime');
        const isTrading = await isAShareTradingTime();
        if (isTrading) {
            console.log('[CapitalFlowCron] 仍在交易时间，跳过');
            return;
        }
        const poolModule = await import('./db');
        const dbPool = poolModule.default;
        const result = await dbPool.query('SELECT symbol FROM stocks');
        const symbols = result.rows.map((r: any) => r.symbol as string);
        console.log(`[CapitalFlowCron] 共${symbols.length}只股票待预取`);

        const { getCapitalFlow } = await import('./services/TushareCapitalFlowService');
        const { CacheService } = await import('./services/CacheService');
        const { getAShareAdaptiveCacheTtlSeconds } = await import('./utils/tradingTime');

        let success = 0, failed = 0;
        for (const symbol of symbols) {
            try {
                const cacheKey = `capital_flow:${symbol}`;
                const data = await getCapitalFlow(symbol);
                const ttl = await getAShareAdaptiveCacheTtlSeconds(3 * 60);
                await CacheService.put(cacheKey, data as unknown as Record<string, any>, ttl);
                success++;
            } catch (err: any) {
                failed++;
                if (failed <= 5) console.error(`[CapitalFlowCron] ${symbol} error:`, err?.message || err);
            }
        }
        console.log(`[CapitalFlowCron] 完成: 成功=${success}, 失败=${failed}`);
    } catch (err: any) {
        console.error('[CapitalFlowCron] 批量预取失败:', err?.message || err);
    }
});

async function start() {
    try {
        await pool.query('SELECT 1');
        console.log('[PG] Connected successfully');
    } catch (err: any) {
        console.error('[PG] Connection failed:', err.message);
    }

    try {
        await redis.ping();
        console.log('[Redis] Connected successfully');
    } catch (err: any) {
        console.error('[Redis] Connection failed:', err.message);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Server] aistock-api running on http://0.0.0.0:${PORT}`);
    });
}

start();

export { app, pool, redis };
