/**
 * 个股异动监测服务
 *
 * 职责：主动拉取东方财富盘口异动，入库并触发推送
 */

import pool from '../db';
import { MonitorEvent, WechatPushService } from './WechatPushService';

// 异动类型定义（与前端 mock/monitorEvents.js 对齐）
export const CHANGE_TYPES: Record<string, string> = {
    '4': '封涨停板',
    '8': '封跌停板',
    '16': '打开涨停板',
    '32': '打开跌停板',
    '64': '快速反弹',
    '128': '高台跳水',
    '8193': '火箭发射',
    '8194': '加速下跌',
    '8201': '大笔买入',
    '8202': '大笔卖出',
    '8203': '有大买盘',
    '8204': '有大卖盘',
    '8207': '高开5日线',
    '8208': '低开5日线',
    '8209': '向上缺口',
    '8210': '向下缺口',
    '8211': '60日新高',
    '8212': '60日新低',
    '8213': '60日大幅上涨',
    '8214': '60日大幅下跌',
    '8215': '竞价上涨',
    '8216': '竞价下跌',
};

// 异动级别
export const CHANGE_LEVELS: Record<string, string> = {
    '8207': 'L1', '8208': 'L1', '8209': 'L1', '8210': 'L1',
    '8211': 'L1', '8212': 'L1',
    '8201': 'L2', '8202': 'L2', '8203': 'L2', '8204': 'L2',
    '8215': 'L2', '8216': 'L2',
    '64': 'L3', '128': 'L3', '8193': 'L3', '8194': 'L3',
    '8213': 'L3', '8214': 'L3',
    '4': 'L4', '8': 'L4', '16': 'L4', '32': 'L4',
};

// 异动类型对应的周期分类
export const CHANGE_TYPE_CYCLES: Record<string, string> = {
    '4': 'short', '8': 'short', '16': 'short', '32': 'short',
    '64': 'short', '128': 'short', '8193': 'short', '8194': 'short',
    '8201': 'short', '8202': 'short', '8203': 'short', '8204': 'short',
    '8207': 'mid', '8208': 'mid', '8209': 'mid', '8210': 'mid',
    '8215': 'short', '8216': 'short',
    '8211': 'mid', '8212': 'mid', '8213': 'long', '8214': 'long',
};

const MONITOR_BASE_URL = process.env.EM_MONITOR_BASE_URL || 'https://push2ex.eastmoney.com/getAllStockChanges';
const MONITOR_QUOTE_BASE_URL = process.env.EM_MONITOR_QUOTE_BASE_URL || 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const MONITOR_UT_TOKEN = process.env.EM_UT_TOKEN || '7eea3edcaed734bea9cbfc24409ed989';
const MONITOR_DPT = process.env.EM_DPT || 'wzchanges';
const MONITOR_PAGE_SIZE = Math.min(Math.max(parseInt(process.env.EM_PAGE_SIZE || '64', 10) || 64, 1), 200);
const MONITOR_MAX_PAGES = Math.max(parseInt(process.env.EM_MONITOR_MAX_PAGES || '20', 10) || 20, 1);
const MONITOR_REQUEST_TIMEOUT_MS = Math.max(parseInt(process.env.EM_MONITOR_TIMEOUT_MS || '10000', 10) || 10000, 1000);
const MONITOR_PUSH_ENABLED = process.env.STOCK_MONITOR_PUSH_ENABLED !== 'false';
const MONITOR_ENRICH_ENABLED = process.env.STOCK_MONITOR_ENRICH_ENABLED === 'true';
const MONITOR_SCAN_ENRICH_ENABLED = process.env.STOCK_MONITOR_SCAN_ENRICH_ENABLED !== 'false';
const MONITOR_ENABLED_TYPES = [
    4, 8, 16, 32,
    64, 128,
    8193, 8194,
    8201, 8202, 8203, 8204,
    8207, 8208, 8209, 8210,
    8211, 8212,
    8213, 8214,
    8215, 8216,
];

interface EastmoneyChangeItem {
    c?: string;
    n?: string;
    tm?: number | string;
    t?: number | string;
    [key: string]: any;
}

interface EastmoneyChangeResponse {
    data?: {
        allstock?: EastmoneyChangeItem[];
        tc?: number | string;
    };
}

interface EastmoneyQuoteItem {
    f2?: number | string;
    f3?: number | string;
    f8?: number | string;
    f10?: number | string;
    f12?: string;
    f100?: string;
}

interface ActiveMonitorEvent extends MonitorEvent {
    raw_data_json: Record<string, any>;
}

export interface StockMonitorScanResult {
    fetched: number;
    inserted: number;
    pushed: number;
    failed: number;
}

const chinaDateFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

function getChinaDateParts(date = new Date()): { dateKey: string; compact: string } {
    const parts = chinaDateFormatter.formatToParts(date);
    const values: Record<string, string> = {};
    for (const part of parts) {
        if (part.type !== 'literal') values[part.type] = part.value;
    }
    const dateKey = `${values.year}-${values.month}-${values.day}`;
    return { dateKey, compact: dateKey.replace(/\D/g, '') };
}

function normalizeEventTime(tmValue: unknown, now = new Date()): { iso: string; timeKey: string } | null {
    if (tmValue === undefined || tmValue === null || tmValue === '') return null;
    const digits = String(tmValue).replace(/\D/g, '').padStart(6, '0').slice(-6);
    const hour = digits.slice(0, 2);
    const minute = digits.slice(2, 4);
    const second = digits.slice(4, 6);
    const { dateKey } = getChinaDateParts(now);
    return {
        iso: `${dateKey}T${hour}:${minute}:${second}+08:00`,
        timeKey: `${hour}${minute}${second}`,
    };
}

function getEventTypeByCycle(cycle: string): string {
    if (cycle === 'mid') return '中线异动';
    if (cycle === 'long') return '长线异动';
    return '短线异动';
}

function inferSymbol(stockCode: string): string {
    if (/^(60|68|90|50|51|52|56|58)/.test(stockCode)) return `SH${stockCode}`;
    if (/^(43|83|87|92)/.test(stockCode)) return `BJ${stockCode}`;
    return `SZ${stockCode}`;
}

function buildDetailUrl(stockCode: string): string {
    if (/^(60|68|90|50|51|52|56|58)/.test(stockCode)) {
        return `https://quote.eastmoney.com/sh${stockCode}.html`;
    }
    return `https://quote.eastmoney.com/sz${stockCode}.html`;
}

function parseJsonp(text: string): EastmoneyChangeResponse {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const start = trimmed.indexOf('(');
    const end = trimmed.lastIndexOf(')');
    if (start < 0 || end <= start) throw new Error('东方财富异动接口返回格式异常');
    return JSON.parse(trimmed.slice(start + 1, end));
}

function generateCallback(): string {
    return `jQuery${Math.floor(100000 + Math.random() * 900000)}_${Date.now()}`;
}

function buildMonitorEvent(item: EastmoneyChangeItem): ActiveMonitorEvent | null {
    const stockCode = String(item.c || '').trim();
    const stockName = String(item.n || '').trim();
    const changeType = String(item.t || '').trim();
    const eventTime = normalizeEventTime(item.tm);
    if (!stockCode || !stockName || !changeType || !eventTime) return null;

    const { compact } = getChinaDateParts();
    const cycle = CHANGE_TYPE_CYCLES[changeType] || 'short';
    const eventType = getEventTypeByCycle(cycle);
    const summary = CHANGE_TYPES[changeType] || `未知(${changeType})`;

    return {
        event_id: `${compact}_${eventTime.timeKey}_${stockCode}`,
        symbol: inferSymbol(stockCode),
        stock_code: stockCode,
        stock_name: stockName,
        股票异动: eventType,
        event_type: eventType,
        level: CHANGE_LEVELS[changeType] || 'L1',
        summary,
        event_time: eventTime.iso,
        detail_url: buildDetailUrl(stockCode),
        raw_data_json: {
            source: 'eastmoney',
            change_type: changeType,
            change_type_name: summary,
            cycle,
            event_type: eventType,
            raw: item,
        },
    };
}

function toNullableNumber(value: unknown): number | null {
    if (value === undefined || value === null || value === '' || value === '-') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export interface MonitorEventItem {
    event_id: string;
    symbol: string;
    stock_code: string;
    stock_name: string;
    industry: string;
    change_type: string;
    change_type_name: string;
    level: string;
    cycle: string;
    price: number | null;
    change_pct: number | null;
    volume_ratio: number | null;
    turnover_rate: number | null;
    event_time: string;
}

export class StockMonitorService {
    /**
     * 查询异动事件列表
     * 当前：从数据库 stock_monitor_events 表查询
     * 后续：可增加 Redis 缓存层，减少数据库压力
     */
    static async getEvents(params: {
        cycle?: string;
        change_type?: string;
        stock_code?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ total: number; events: MonitorEventItem[] }> {
        const { cycle, change_type, stock_code, limit = 20, offset = 0 } = params;

        // 构建查询条件
        const conditions: string[] = [];
        const values: any[] = [];
        let paramIdx = 1;

        if (stock_code) {
            // 支持纯数字代码(如600519)和带市场前缀代码(如SH600519)
            if (/^\d{6}$/.test(stock_code)) {
                conditions.push(`(symbol = $${paramIdx} OR symbol = $${paramIdx + 1} OR symbol = $${paramIdx + 2} OR symbol = $${paramIdx + 3})`);
                values.push(stock_code, `SH${stock_code}`, `SZ${stock_code}`, `BJ${stock_code}`);
                paramIdx += 4;
            } else {
                conditions.push(`symbol = $${paramIdx++}`);
                values.push(stock_code);
            }
        }

        if (change_type) {
            conditions.push(`(
                raw_data_json->>'change_type' = $${paramIdx}
                OR raw_data_json->'raw_data_json'->>'change_type' = $${paramIdx}
                OR event_type = $${paramIdx}
            )`);
            values.push(change_type);
            paramIdx += 1;
        }

        // 日期过滤：只查当天的异动
        conditions.push(`event_time >= CURRENT_DATE`);

        const whereClause = conditions.length > 0
            ? 'WHERE ' + conditions.join(' AND ')
            : '';

        // 查询总数
        const countResult = await pool.query(
            `SELECT COUNT(*) as total FROM stock_monitor_events ${whereClause}`,
            values,
        );
        const total = parseInt(countResult.rows[0]?.total || '0', 10);

        // 查询数据
        const dataResult = await pool.query(
            `SELECT event_id, symbol, stock_name, event_type, level, summary, event_time, detail_url, raw_data_json
             FROM stock_monitor_events ${whereClause}
             ORDER BY event_time DESC
             LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...values, limit, offset],
        );

        // 将数据库记录转换为前端需要的格式
        const events: MonitorEventItem[] = dataResult.rows.map((row: any) => {
            const raw = row.raw_data_json || {};
            // raw_data_json 可能是嵌套结构: { raw_data_json: { change_type: "4", ... } }
            const inner = raw.raw_data_json || raw;
            const changeType = inner.change_type || inner.change_type_code || raw.change_type || raw.change_type_code || '';
            return {
                event_id: row.event_id,
                symbol: row.symbol,
                stock_code: row.symbol.replace(/^(SH|SZ|BJ)/, ''),
                stock_name: row.stock_name,
                industry: inner.industry || raw.industry || '',
                change_type: changeType,
                change_type_name: CHANGE_TYPES[changeType] || row.summary || '',
                level: CHANGE_LEVELS[changeType] || row.level || 'L1',
                cycle: CHANGE_TYPE_CYCLES[changeType] || 'short',
                price: inner.price ?? raw.price ?? null,
                change_pct: inner.change_pct ?? inner.change_percent ?? raw.change_pct ?? raw.change_percent ?? null,
                volume_ratio: inner.volume_ratio ?? raw.volume_ratio ?? null,
                turnover_rate: inner.turnover_rate ?? raw.turnover_rate ?? null,
                event_time: row.event_time,
            };
        });

        // 默认快速返回数据库事件；如需临时批量补全，可用 STOCK_MONITOR_ENRICH_ENABLED=true 开启。
        if (MONITOR_ENRICH_ENABLED && events.length > 0) {
            const uniqueCodes = [...new Set(events.map(e => e.stock_code))];
            try {
                const quotes = await StockMonitorService.fetchBatchQuoteInfo(uniqueCodes);
                const quoteMap = new Map<string, EastmoneyQuoteItem>();
                for (const quote of quotes) {
                    if (quote.f12) quoteMap.set(String(quote.f12), quote);
                }

                for (const event of events) {
                    const quote = quoteMap.get(event.stock_code);
                    if (!quote) continue;
                    if (!event.industry) event.industry = quote.f100 || '';
                    if (event.price == null) event.price = toNullableNumber(quote.f2);
                    if (event.change_pct == null) event.change_pct = toNullableNumber(quote.f3);
                    if (event.volume_ratio == null) event.volume_ratio = toNullableNumber(quote.f10);
                    if (event.turnover_rate == null) event.turnover_rate = toNullableNumber(quote.f8);
                }
            } catch (err) {
                console.warn('[StockMonitorService] 列表临时补全失败，返回入库数据:', err);
            }
        }

        // 周期过滤（在应用层过滤，因为 cycle 不在数据库中）
        const filtered = cycle && cycle !== 'all'
            ? events.filter(e => e.cycle === cycle)
            : events;

        return {
            total: cycle && cycle !== 'all' ? filtered.length : total,
            events: filtered,
        };
    }

    /**
     * 查询指定股票的异动事件
     */
    static async getEventsByStockCode(stockCode: string, params?: {
        cycle?: string;
        limit?: number;
    }): Promise<MonitorEventItem[]> {
        const result = await StockMonitorService.getEvents({
            stock_code: stockCode,
            cycle: params?.cycle,
            limit: params?.limit || 20,
        });
        return result.events;
    }

    /**
     * 获取异动统计概览
     * 当前：从数据库统计
     * 后续：可从 Redis 缓存中读取
     */
    static async getStats(): Promise<{
        total: number;
        limit_up: number;
        limit_down: number;
        rocket: number;
        dive: number;
    }> {
        const result = await pool.query(
            `SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '4' OR raw_data_json->>'change_type' = '4') as limit_up,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '8' OR raw_data_json->>'change_type' = '8') as limit_down,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '8193' OR raw_data_json->>'change_type' = '8193') as rocket,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '8194' OR raw_data_json->>'change_type' = '8194') as dive
             FROM stock_monitor_events
             WHERE event_time >= CURRENT_DATE`,
        );

        const row = result.rows[0] || {};
        return {
            total: parseInt(row.total || '0', 10),
            limit_up: parseInt(row.limit_up || '0', 10),
            limit_down: parseInt(row.limit_down || '0', 10),
            rocket: parseInt(row.rocket || '0', 10),
            dive: parseInt(row.dive || '0', 10),
        };
    }

    private static async enrichMonitorEvents(events: ActiveMonitorEvent[]): Promise<ActiveMonitorEvent[]> {
        if (!MONITOR_SCAN_ENRICH_ENABLED || events.length === 0) return events;

        const uniqueCodes = [...new Set(events.map(event => event.stock_code))];
        const quoteMap = new Map<string, EastmoneyQuoteItem>();

        try {
            const quotes = await StockMonitorService.fetchBatchQuoteInfo(uniqueCodes);
            for (const quote of quotes) {
                const code = quote.f12;
                if (code) quoteMap.set(String(code), quote);
            }
        } catch (err) {
            console.warn('[StockMonitorService] 扫描行情/行业批量补全失败:', err);
        }

        for (const event of events) {
            const quote = quoteMap.get(event.stock_code);
            const enrich = {
                industry: quote?.f100 || '',
                price: toNullableNumber(quote?.f2),
                change_pct: toNullableNumber(quote?.f3),
                volume_ratio: toNullableNumber(quote?.f10),
                turnover_rate: toNullableNumber(quote?.f8),
            };

            event.raw_data_json = {
                ...event.raw_data_json,
                ...enrich,
                enriched_at: new Date().toISOString(),
            };
        }

        return events;
    }

    private static async fetchBatchQuoteInfo(stockCodes: string[]): Promise<EastmoneyQuoteItem[]> {
        if (stockCodes.length === 0) return [];

        const url = new URL(MONITOR_QUOTE_BASE_URL);
        url.searchParams.set('fltt', '2');
        url.searchParams.set('invt', '2');
        url.searchParams.set('fields', 'f2,f3,f8,f10,f12,f100');
        url.searchParams.set('secids', stockCodes.map(code => {
            const marketId = inferSymbol(code).startsWith('SH') ? '1' : '0';
            return `${marketId}.${code}`;
        }).join(','));
        url.searchParams.set('_', String(Date.now()));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MONITOR_REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Referer': 'https://quote.eastmoney.com/',
                },
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`东方财富批量行情接口请求失败: ${response.status}`);

            const json: any = await response.json();
            return Array.isArray(json.data?.diff) ? json.data.diff : [];
        } finally {
            clearTimeout(timer);
        }
    }

    private static async fetchMonitorPage(changeType: number, pageIndex: number): Promise<{ events: ActiveMonitorEvent[]; total: number }> {
        const url = new URL(MONITOR_BASE_URL);
        url.searchParams.set('type', String(changeType));
        url.searchParams.set('cb', generateCallback());
        url.searchParams.set('ut', MONITOR_UT_TOKEN);
        url.searchParams.set('pageindex', String(pageIndex));
        url.searchParams.set('pagesize', String(MONITOR_PAGE_SIZE));
        url.searchParams.set('dpt', MONITOR_DPT);
        url.searchParams.set('_', String(Date.now()));

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MONITOR_REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'zh-CN,zh;q=0.9',
                    'Referer': 'https://data.eastmoney.com/',
                },
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`东方财富异动接口请求失败: ${response.status}`);

            const data = parseJsonp(await response.text());
            const items = data.data?.allstock || [];
            const events = items
                .map(item => buildMonitorEvent(item))
                .filter((event): event is ActiveMonitorEvent => Boolean(event));
            return { events, total: Number(data.data?.tc || 0) };
        } finally {
            clearTimeout(timer);
        }
    }

    private static async upsertMonitorEvent(event: ActiveMonitorEvent): Promise<boolean> {
        const result = await pool.query(
            `INSERT INTO stock_monitor_events (
                event_id,
                symbol,
                stock_name,
                event_type,
                level,
                summary,
                event_time,
                detail_url,
                raw_data_json
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb)
            ON CONFLICT(event_id) DO UPDATE SET
                raw_data_json = stock_monitor_events.raw_data_json || EXCLUDED.raw_data_json,
                detail_url = COALESCE(EXCLUDED.detail_url, stock_monitor_events.detail_url),
                summary = EXCLUDED.summary
            RETURNING (xmax = 0) AS inserted`,
            [
                event.event_id,
                event.symbol,
                event.stock_name,
                event.event_type,
                event.level,
                event.summary,
                event.event_time,
                event.detail_url,
                JSON.stringify(event.raw_data_json),
            ],
        );
        return Boolean(result.rows[0]?.inserted);
    }

    /**
     * 主动扫描东方财富盘口异动。
     */
    static async scanAndDispatch(): Promise<StockMonitorScanResult> {
        const summary: StockMonitorScanResult = { fetched: 0, inserted: 0, pushed: 0, failed: 0 };

        for (const changeType of MONITOR_ENABLED_TYPES) {
            for (let pageIndex = 0; pageIndex < MONITOR_MAX_PAGES; pageIndex++) {
                const { events, total } = await StockMonitorService.fetchMonitorPage(changeType, pageIndex);
                if (events.length === 0) break;

                summary.fetched += events.length;
                const enrichedEvents = await StockMonitorService.enrichMonitorEvents(events);
                for (const event of enrichedEvents) {
                    try {
                        const inserted = await StockMonitorService.upsertMonitorEvent(event);
                        if (inserted) summary.inserted += 1;

                        if (inserted && MONITOR_PUSH_ENABLED) {
                            const pushResult = await WechatPushService.dispatchMonitorEvent(event);
                            summary.pushed += pushResult?.sent || 0;
                        }
                    } catch (err: any) {
                        summary.failed += 1;
                        if (summary.failed <= 5) {
                            console.error('[StockMonitorService] 异动事件处理失败:', err?.message || err);
                        }
                    }
                }

                if (total > 0 && (pageIndex + 1) * MONITOR_PAGE_SIZE >= total) break;
            }
        }

        return summary;
    }
}
