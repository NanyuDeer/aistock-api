import { Request, Response, NextFunction } from 'express';
import { TushareQuoteService, QuoteLevel } from '../services/TushareQuoteService';
import { TushareKlineService, KLineFqt, KLinePeriod } from '../services/TushareKlineService';
import { EmQuoteService } from '../services/EmQuoteService';
import { CacheService } from '../services/CacheService';
import { createResponse } from '../utils/response';
import { isValidAShareSymbol } from '../utils/validator';
import {
    STOCK_QUOTE_ACTIVITY_CACHE_KEY_PREFIX,
    STOCK_QUOTE_ACTIVITY_TRADING_TTL_SECONDS,
    STOCK_QUOTE_CORE_CACHE_KEY_PREFIX,
    STOCK_QUOTE_CORE_TRADING_TTL_SECONDS,
    STOCK_QUOTE_FUNDAMENTAL_CACHE_KEY_PREFIX,
    STOCK_QUOTE_FUNDAMENTAL_TRADING_TTL_SECONDS,
    buildTimestampedCachePayload,
    isValidStockInfoCachePayload,
    type StockInfoCachePayload,
} from '../constants/cache';
import { getAShareAdaptiveCacheTtlSeconds } from '../utils/tradingTime';

const MAX_SYMBOLS = 20;
const MAX_KLINE_LIMIT = 5000;
const SUPPORTED_KLT = new Set<number>([1, 5, 15, 30, 60, 101, 102, 103]);

interface QuoteCacheConfig {
    keyPrefix: string;
    tradingTtlSeconds: number;
}

export class StockQuoteController {
    private static parseIntegerParam(value: string | null | undefined): number | null {
        if (!value || value === '') return null;
        if (!/^-?\d+$/.test(value)) return null;
        return Number(value);
    }

    private static getKLinePeriodName(klt: KLinePeriod): string {
        const periodMap: Record<KLinePeriod, string> = {
            1: '1分钟', 5: '5分钟', 15: '15分钟', 30: '30分钟',
            60: '60分钟', 101: '日线', 102: '周线', 103: '月线',
        };
        return periodMap[klt];
    }

    private static getFqtName(fqt: KLineFqt): string {
        const fqtMap: Record<KLineFqt, string> = { 0: '不复权', 1: '前复权', 2: '后复权' };
        return fqtMap[fqt];
    }

    private static getQuoteCacheConfig(level: QuoteLevel): QuoteCacheConfig | null {
        if (level === 'core') return { keyPrefix: STOCK_QUOTE_CORE_CACHE_KEY_PREFIX, tradingTtlSeconds: STOCK_QUOTE_CORE_TRADING_TTL_SECONDS };
        if (level === 'activity') return { keyPrefix: STOCK_QUOTE_ACTIVITY_CACHE_KEY_PREFIX, tradingTtlSeconds: STOCK_QUOTE_ACTIVITY_TRADING_TTL_SECONDS };
        if (level === 'fundamental') return { keyPrefix: STOCK_QUOTE_FUNDAMENTAL_CACHE_KEY_PREFIX, tradingTtlSeconds: STOCK_QUOTE_FUNDAMENTAL_TRADING_TTL_SECONDS };
        return null;
    }

    private static buildQuoteCacheKey(level: QuoteLevel, symbol: string): string | null {
        const config = this.getQuoteCacheConfig(level);
        if (!config) return null;
        return `${config.keyPrefix}${symbol}`;
    }

    private static async readCachedQuote(level: QuoteLevel, symbol: string): Promise<Record<string, any> | null> {
        const cacheKey = this.buildQuoteCacheKey(level, symbol);
        if (!cacheKey) return null;
        try {
            const cached = await CacheService.get<StockInfoCachePayload>(cacheKey);
            if (!isValidStockInfoCachePayload(cached)) return null;
            return cached.data;
        } catch (err) {
            console.error(`Error reading stock quote cache ${cacheKey}:`, err);
            return null;
        }
    }

    private static async writeCachedQuote(level: QuoteLevel, symbol: string, quote: Record<string, any>, ttlSeconds: number): Promise<void> {
        if (Object.keys(quote).length === 0) return;
        const cacheKey = this.buildQuoteCacheKey(level, symbol);
        if (!cacheKey) return;
        try {
            await CacheService.set(cacheKey, buildTimestampedCachePayload(quote), ttlSeconds);
        } catch (err) {
            console.error(`Error writing stock quote cache ${cacheKey}:`, err);
        }
    }

    private static isCacheableQuote(quote: Record<string, any>): boolean {
        if (!quote || typeof quote !== 'object' || Array.isArray(quote)) return false;
        if (Object.keys(quote).length === 0) return false;
        return !('错误' in quote);
    }

    private static async handleBatchQuotes(req: Request, level: QuoteLevel, res: Response): Promise<void> {
        const symbolsParam = req.query.symbols as string;

        if (!symbolsParam) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
            return;
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];
        if (symbols.length === 0) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
            return;
        }
        if (symbols.length > MAX_SYMBOLS) {
            createResponse(res, 400, `单次最多查询 ${MAX_SYMBOLS} 只股票`);
            return;
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            createResponse(res, 400, `Invalid symbol(s) - A股代码必须是6位数字: ${invalidSymbols.join(', ')}`);
            return;
        }

        try {
            const cacheConfig = this.getQuoteCacheConfig(level);
            const quotesBySymbol = new Map<string, Record<string, any>>();

            const cacheChecks = await Promise.all(symbols.map(async (symbol) => {
                const cached = await this.readCachedQuote(level, symbol);
                return { symbol, cached };
            }));

            const missedSymbols: string[] = [];
            for (const item of cacheChecks) {
                if (item.cached) {
                    quotesBySymbol.set(item.symbol, item.cached);
                } else {
                    missedSymbols.push(item.symbol);
                }
            }

            if (missedSymbols.length > 0) {
                const fetchedQuotes = await TushareQuoteService.getBatchQuotes(missedSymbols, level);
                const cacheableFetchedCount = fetchedQuotes.filter(quote => this.isCacheableQuote(quote)).length;
                const cacheTtlSeconds = cacheableFetchedCount > 0 && cacheConfig
                    ? await getAShareAdaptiveCacheTtlSeconds(cacheConfig.tradingTtlSeconds)
                    : null;

                const writeTasks: Promise<void>[] = [];
                fetchedQuotes.forEach((quote, index) => {
                    const symbol = missedSymbols[index];
                    quotesBySymbol.set(symbol, quote);
                    if (cacheTtlSeconds !== null && this.isCacheableQuote(quote)) {
                        writeTasks.push(this.writeCachedQuote(level, symbol, quote, cacheTtlSeconds));
                    }
                });

                if (writeTasks.length > 0) await Promise.all(writeTasks);
            }

            const results = symbols.map(symbol => quotesBySymbol.get(symbol) ?? { '股票代码': symbol, '错误': '查询失败' });
            const message = missedSymbols.length === 0 ? 'success (cached)' : 'success';

            createResponse(res, 200, message, {
                '来源': 'Tushare',
                '股票数量': results.length,
                '行情': results,
            });
        } catch (err: any) {
            console.error(`Error fetching ${level} batch quotes:`, err);
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    static async getCoreQuotes(req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.handleBatchQuotes(req, 'core', res);
    }

    static async getRealtimeQuotes(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbolsParam = req.query.symbols as string;

        if (!symbolsParam) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
            return;
        }

        const symbols = [...new Set(symbolsParam.split(',').map(s => s.trim()).filter(Boolean))];
        if (symbols.length === 0) {
            createResponse(res, 400, '缺少 symbols 参数，示例: ?symbols=000001,600519');
            return;
        }
        if (symbols.length > MAX_SYMBOLS) {
            createResponse(res, 400, `单次最多查询 ${MAX_SYMBOLS} 只股票`);
            return;
        }

        const invalidSymbols = symbols.filter(s => !isValidAShareSymbol(s));
        if (invalidSymbols.length > 0) {
            createResponse(res, 400, `Invalid symbol(s) - A股代码必须是6位数字: ${invalidSymbols.join(', ')}`);
            return;
        }

        try {
            const results = await EmQuoteService.getBatchQuotes(symbols, 'core');
            createResponse(res, 200, 'success', {
                '来源': '东方财富',
                '股票数量': results.length,
                '行情': results,
            });
        } catch (err: any) {
            console.error('Error fetching realtime batch quotes:', err);
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }

    static async getActivityQuotes(req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.handleBatchQuotes(req, 'activity', res);
    }

    static async getFundamentalQuotes(req: Request, res: Response, _next: NextFunction): Promise<void> {
        await this.handleBatchQuotes(req, 'fundamental', res);
    }

    static async getKLine(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = (req.query.symbol as string || '').trim();
        const kltParam = req.query.klt as string;
        const fqtParam = req.query.fqt as string;
        const limitParam = req.query.limit as string;
        const startDate = (req.query.startDate as string || '').trim();
        const endDate = (req.query.endDate as string || '').trim();

        if (!symbol) {
            createResponse(res, 400, '缺少 symbol 参数，示例: ?symbol=000001');
            return;
        }
        if (!isValidAShareSymbol(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        let klt: KLinePeriod = 101;
        if (kltParam) {
            const parsedKlt = this.parseIntegerParam(kltParam);
            if (parsedKlt === null || !SUPPORTED_KLT.has(parsedKlt)) {
                createResponse(res, 400, 'Invalid klt - klt 仅支持 1/5/15/30/60/101/102/103');
                return;
            }
            klt = parsedKlt as KLinePeriod;
        }

        const defaultFqt: KLineFqt = klt >= 100 ? 1 : 0;
        let fqt: KLineFqt = defaultFqt;
        if (fqtParam) {
            const parsedFqt = this.parseIntegerParam(fqtParam);
            if (parsedFqt !== 0 && parsedFqt !== 1 && parsedFqt !== 2) {
                createResponse(res, 400, 'Invalid fqt - fqt 仅支持 0/1/2');
                return;
            }
            fqt = parsedFqt;
        }

        let limit = 120;
        if (limitParam) {
            const parsedLimit = this.parseIntegerParam(limitParam);
            if (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0 || parsedLimit > MAX_KLINE_LIMIT) {
                createResponse(res, 400, `Invalid limit - limit 必须是 1-${MAX_KLINE_LIMIT} 的整数`);
                return;
            }
            limit = parsedLimit;
        }

        if (startDate && !/^\d{8}$/.test(startDate)) {
            createResponse(res, 400, 'Invalid startDate - startDate 格式必须为 YYYYMMDD');
            return;
        }
        if (endDate && !/^\d{8}$/.test(endDate)) {
            createResponse(res, 400, 'Invalid endDate - endDate 格式必须为 YYYYMMDD');
            return;
        }
        if (startDate && endDate && startDate > endDate) {
            createResponse(res, 400, 'Invalid date range - startDate 不能晚于 endDate');
            return;
        }

        try {
            const klines = await TushareKlineService.getKLine({
                symbol, klt, fqt, limit,
                startDate: startDate || undefined,
                endDate: endDate || undefined,
            });

            createResponse(res, 200, 'success', {
                '来源': 'Tushare',
                '股票代码': symbol,
                'K线周期': this.getKLinePeriodName(klt),
                '复权类型': this.getFqtName(fqt),
                '数量': klines.length,
                'K线': klines,
            });
        } catch (err: any) {
            console.error(`Error fetching kline for ${symbol}:`, err);
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
