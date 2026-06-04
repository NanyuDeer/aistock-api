import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import pool from '../db';
import { createResponse } from '../utils/response';
import { WechatPushService } from '../services/WechatPushService';

const CHANGE_TYPES: Record<string, string> = {
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

const CHANGE_LEVELS: Record<string, string> = {
    '8207': 'L1', '8208': 'L1', '8209': 'L1', '8210': 'L1',
    '8211': 'L1', '8212': 'L1',
    '8201': 'L2', '8202': 'L2', '8203': 'L2', '8204': 'L2',
    '8215': 'L2', '8216': 'L2',
    '64': 'L3', '128': 'L3', '8193': 'L3', '8194': 'L3',
    '8213': 'L3', '8214': 'L3',
    '4': 'L4', '8': 'L4', '16': 'L4', '32': 'L4',
};

const CHANGE_TYPE_CYCLES: Record<string, string> = {
    '4': 'short', '8': 'short', '16': 'short', '32': 'short',
    '64': 'short', '128': 'short', '8193': 'short', '8194': 'short',
    '8201': 'short', '8202': 'short', '8203': 'short', '8204': 'short',
    '8215': 'short', '8216': 'short',
    '8207': 'mid', '8208': 'mid', '8209': 'mid', '8210': 'mid',
    '8211': 'mid', '8212': 'mid',
    '8213': 'long', '8214': 'long',
};

const CYCLE_EVENT_TYPES: Record<string, string> = {
    short: '短线异动',
    mid: '中线异动',
    middle: '中线异动',
    long: '长线异动',
};

interface NormalizedMonitorEvent {
    event_id: string;
    symbol: string;
    stock_code: string;
    stock_name: string;
    股票异动: string;
    event_type: string;
    level: string;
    summary: string;
    event_time: string;
    detail_url: string;
    raw_data_json: Record<string, any>;
}

function cleanText(value: unknown): string {
    return String(value ?? '').trim();
}

function normalizeStockCode(payload: Record<string, any>): string {
    const raw = cleanText(payload.stock_code || payload.symbol || payload.code);
    return raw.replace(/^(SH|SZ|BJ)/i, '').trim();
}

function inferMarketPrefix(stockCode: string): string {
    if (/^(60|68|90|50|51|52|56|58)/.test(stockCode)) return 'SH';
    if (/^(00|30|20)/.test(stockCode)) return 'SZ';
    if (/^(43|83|87|92)/.test(stockCode)) return 'BJ';
    return '';
}

function normalizeSymbol(payload: Record<string, any>, stockCode: string): string {
    const raw = cleanText(payload.symbol || payload.stock_code || payload.code);
    if (/^(SH|SZ|BJ)\d{6}$/i.test(raw)) return raw.toUpperCase();
    const prefix = inferMarketPrefix(stockCode);
    return prefix ? `${prefix}${stockCode}` : stockCode;
}

function normalizeCycle(payload: Record<string, any>, changeType: string): string {
    const rawCycle = cleanText(payload.cycle || payload.period || payload.tag).toLowerCase();
    if (rawCycle) {
        if (rawCycle === 'short' || rawCycle.includes('短')) return 'short';
        if (rawCycle === 'mid' || rawCycle === 'middle' || rawCycle.includes('中')) return 'mid';
        if (rawCycle === 'long' || rawCycle.includes('长')) return 'long';
    }
    return CHANGE_TYPE_CYCLES[changeType] || 'short';
}

function normalizeEventType(payload: Record<string, any>, cycle: string): string {
    const raw = cleanText(payload.event_type || payload['股票异动']);
    if (raw === '短线异动' || raw === '中线异动' || raw === '长线异动') return raw;
    return CYCLE_EVENT_TYPES[cycle] || '短线异动';
}

function normalizeEventTime(payload: Record<string, any>): string {
    const raw = cleanText(payload.event_time || payload.time || payload.created_at);
    if (!raw) return new Date().toISOString();
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
    return raw;
}

function buildEventId(payload: Record<string, any>, stockCode: string, eventTime: string, changeType: string): string {
    const raw = cleanText(payload.event_id || payload.id);
    if (raw) return raw;
    const hash = crypto
        .createHash('sha1')
        .update(`${stockCode}|${eventTime}|${changeType}|${cleanText(payload.summary)}`)
        .digest('hex')
        .slice(0, 10);
    return `${eventTime.replace(/\D/g, '').slice(0, 14)}_${stockCode}_${hash}`;
}

function normalizeEvent(payload: Record<string, any>): NormalizedMonitorEvent {
    const stockCode = normalizeStockCode(payload);
    const changeType = cleanText(payload.change_type || payload.change_type_code || payload.event_code);
    const cycle = normalizeCycle(payload, changeType);
    const eventType = normalizeEventType(payload, cycle);
    const eventTime = normalizeEventTime(payload);
    const summary = cleanText(
        payload.summary ||
        payload.change_type_name ||
        payload.reason ||
        CHANGE_TYPES[changeType] ||
        eventType,
    );

    return {
        event_id: buildEventId(payload, stockCode, eventTime, changeType),
        symbol: normalizeSymbol(payload, stockCode),
        stock_code: stockCode,
        stock_name: cleanText(payload.stock_name || payload.name || payload.stockName),
        股票异动: eventType,
        event_type: eventType,
        level: cleanText(payload.level || CHANGE_LEVELS[changeType] || 'L1').toUpperCase(),
        summary,
        event_time: eventTime,
        detail_url: cleanText(payload.detail_url || payload.url),
        raw_data_json: {
            ...payload,
            stock_code: stockCode,
            change_type: changeType || null,
            change_type_name: CHANGE_TYPES[changeType] || payload.change_type_name || null,
            cycle,
        },
    };
}

function getPayloadEvents(body: any): Record<string, any>[] {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.events)) return body.events;
    if (body && typeof body === 'object') return [body];
    return [];
}

function validateInternalToken(req: Request): boolean {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) return false;
    const token = req.headers['x-internal-token'];
    return String(Array.isArray(token) ? token[0] : token || '') === expected;
}

async function saveEvent(event: NormalizedMonitorEvent): Promise<void> {
    await pool.query(
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
            symbol = EXCLUDED.symbol,
            stock_name = EXCLUDED.stock_name,
            event_type = EXCLUDED.event_type,
            level = EXCLUDED.level,
            summary = EXCLUDED.summary,
            event_time = EXCLUDED.event_time,
            detail_url = EXCLUDED.detail_url,
            raw_data_json = EXCLUDED.raw_data_json`,
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
}

export class MonitorEventController {
    static async mockMonitorEvent(req: Request, res: Response, _next: NextFunction): Promise<void> {
        if (!validateInternalToken(req)) {
            createResponse(res, 401, 'invalid internal token');
            return;
        }

        const payloadEvents = getPayloadEvents(req.body);
        if (payloadEvents.length === 0) {
            createResponse(res, 400, 'missing monitor event payload');
            return;
        }

        const results: any[] = [];
        const summary = {
            total: payloadEvents.length,
            success: 0,
            failed: 0,
            matched_users: 0,
            sent: 0,
            skipped: 0,
            push_failed: 0,
        };

        for (const payload of payloadEvents) {
            try {
                const event = normalizeEvent(payload);
                if (!event.stock_code || !event.stock_name) {
                    throw new Error('stock_code/stock_name is required');
                }

                await saveEvent(event);
                const pushResult = await WechatPushService.dispatchMonitorEvent(event);

                summary.success += 1;
                summary.matched_users += pushResult?.matched_users || 0;
                summary.sent += pushResult?.sent || 0;
                summary.skipped += pushResult?.skipped || 0;
                summary.push_failed += pushResult?.failed || 0;

                results.push({
                    event,
                    ...pushResult,
                });
            } catch (err: any) {
                summary.failed += 1;
                results.push({
                    status: 'failed',
                    error: err instanceof Error ? err.message : String(err),
                    raw: payload,
                });
            }
        }

        const code = summary.failed > 0 ? 207 : 200;
        createResponse(res, code, payloadEvents.length > 1 ? 'batch success' : 'success', {
            summary,
            results,
            event: results[0]?.event,
        });
    }
}
