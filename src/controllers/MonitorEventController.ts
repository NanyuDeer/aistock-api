import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createResponse } from '../utils/response';
import { isValidAShareSymbol } from '../utils/validator';
import { WechatPushService, type MonitorEvent } from '../services/WechatPushService';
import pool from '../db';

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
    '8207': 'L1',
    '8208': 'L1',
    '8209': 'L1',
    '8210': 'L1',
    '8211': 'L1',
    '8212': 'L1',
    '8201': 'L2',
    '8202': 'L2',
    '8203': 'L2',
    '8204': 'L2',
    '8215': 'L2',
    '8216': 'L2',
    '64': 'L3',
    '128': 'L3',
    '8193': 'L3',
    '8194': 'L3',
    '8213': 'L3',
    '8214': 'L3',
    '4': 'L4',
    '8': 'L4',
    '16': 'L4',
    '32': 'L4',
};

const CHANGE_TYPE_NAMES = new Set(Object.values(CHANGE_TYPES));

export class MonitorEventController {
    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[MonitorEvent][${stage}] ${ts} ${message}${detail}`);
    }

    private static generateEventId(symbol: string): string {
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        return `evt_${date}_${symbol}_${random}`;
    }

    private static normalizeEventTime(value: any, eventId?: string): string {
        if (typeof value === 'string' && value.trim()) {
            const text = value.trim();
            if (/^\d{2}:\d{2}(:\d{2})?$/.test(text)) {
                const dateMatch = String(eventId || '').match(/^(\d{4})(\d{2})(\d{2})_/);
                const date = dateMatch
                    ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
                    : new Date().toISOString().slice(0, 10);
                const time = text.length === 5 ? `${text}:00` : text;
                return `${date}T${time}+08:00`;
            }
            return text;
        }
        return new Date().toISOString();
    }

    private static normalizeText(value: any): string {
        if (typeof value === 'number') return String(value);
        return typeof value === 'string' ? value.trim() : '';
    }

    private static getChangeTypeCode(body: any): string {
        return MonitorEventController.normalizeText(
            body?.change_type_code
            || body?.changeTypeCode
            || body?.change_type
            || body?.changeType
            || body?.type_code
            || body?.typeCode
            || (CHANGE_TYPES[MonitorEventController.normalizeText(body?.event_type)] ? body?.event_type : ''),
        );
    }

    private static buildEastmoneyUrl(symbol: string): string {
        const market = symbol.startsWith('6') ? 'sh' : 'sz';
        return `https://quote.eastmoney.com/${market}${symbol}.html`;
    }

    private static parseEvent(body: any): { ok: true; event: MonitorEvent } | { ok: false; message: string } {
        let symbol = String(body?.symbol || body?.stock_code || body?.stockCode || '').trim();
        // 支持 SH600519/SZ000001 格式，自动去除市场前缀后验证
        if (/^(SH|SZ|sh|sz)[0-9]{6}$/.test(symbol)) {
            symbol = symbol.slice(2);
        }
        if (!isValidAShareSymbol(symbol)) {
            return { ok: false, message: 'Invalid stock_code - A share symbol must be 6 digits' };
        }
        // 统一转换为 SH/SZ 前缀格式存入数据库
        const marketPrefix = symbol.startsWith('6') ? 'SH' : 'SZ';
        const fullSymbol = `${marketPrefix}${symbol}`;

        const stockName = MonitorEventController.normalizeText(body?.stock_name || body?.stockName);
        const eventTypeInput = MonitorEventController.normalizeText(
            body?.['股票异动'] || body?.event_type || body?.alert_type || body?.eventType,
        );
        const changeTypeCode = MonitorEventController.getChangeTypeCode(body);
        const changeTypeName = changeTypeCode ? CHANGE_TYPES[changeTypeCode] : '';
        const eventType = !eventTypeInput || CHANGE_TYPES[eventTypeInput] || CHANGE_TYPE_NAMES.has(eventTypeInput)
            ? '短线异动'
            : eventTypeInput;
        const level = MonitorEventController.normalizeText(body?.level)
            || (changeTypeCode ? CHANGE_LEVELS[changeTypeCode] : '')
            || '中';
        const summary = MonitorEventController.normalizeText(
            body?.summary || body?.content || body?.change_type_name || body?.changeTypeName,
        ) || changeTypeName || (CHANGE_TYPE_NAMES.has(eventTypeInput) ? eventTypeInput : '');

        if (!stockName) return { ok: false, message: 'Missing stock_name' };
        if (!summary) return { ok: false, message: 'Missing summary' };

        const eventId = MonitorEventController.normalizeText(body?.event_id || body?.eventId)
            || MonitorEventController.generateEventId(symbol);

        return {
            ok: true,
            event: {
                event_id: eventId,
                symbol: fullSymbol,
                stock_code: symbol,
                stock_name: stockName,
                股票异动: eventType,
                event_type: eventType,
                level,
                summary,
                event_time: MonitorEventController.normalizeEventTime(body?.event_time || body?.eventTime, eventId),
                detail_url: MonitorEventController.normalizeText(body?.detail_url || body?.detailUrl)
                    || MonitorEventController.buildEastmoneyUrl(symbol),
            },
        };
    }

    private static getRequestEvents(body: any): { events: any[]; isBatch: boolean } {
        if (Array.isArray(body)) return { events: body, isBatch: true };
        if (Array.isArray(body?.events)) return { events: body.events, isBatch: true };
        return { events: [body], isBatch: false };
    }

    private static async saveEvent(event: MonitorEvent, rawBody: any): Promise<void> {
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
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT(event_id) DO NOTHING`,
            [
                event.event_id,
                event.symbol,
                event.stock_name,
                event.event_type,
                event.level,
                event.summary,
                event.event_time,
                event.detail_url,
                JSON.stringify(rawBody || {}),
            ],
        );
    }

    private static validateInternalToken(req: Request): boolean {
        const expected = process.env.INTERNAL_API_TOKEN;
        if (!expected) return false;

        const headerToken = req.header('x-internal-token') || '';
        const auth = req.header('authorization') || '';
        const bearerToken = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
        return headerToken === expected || bearerToken === expected;
    }

    static async mockMonitorEvent(req: Request, res: Response, _next: NextFunction): Promise<void> {
        MonitorEventController.log('mock', 'received mock monitor event request', { method: req.method });

        if (!process.env.INTERNAL_API_TOKEN) {
            createResponse(res, 500, 'INTERNAL_API_TOKEN is not configured');
            return;
        }

        if (!MonitorEventController.validateInternalToken(req)) {
            createResponse(res, 401, 'invalid internal token');
            return;
        }

        const { events, isBatch } = MonitorEventController.getRequestEvents(req.body);
        if (events.length === 0) {
            createResponse(res, 400, 'Missing monitor events');
            return;
        }

        if (!isBatch) {
            const parsed = MonitorEventController.parseEvent(events[0]);
            if (!parsed.ok) {
                createResponse(res, 400, parsed.message);
                return;
            }

            try {
                const { event } = parsed;
                await MonitorEventController.saveEvent(event, events[0]);
                const pushResult = await WechatPushService.dispatchMonitorEvent(event);

                createResponse(res, 200, 'success', {
                    event,
                    ...pushResult,
                });
            } catch (err: any) {
                const errMsg = err instanceof Error ? err.message : String(err);
                MonitorEventController.log('mock', 'failed to handle monitor event', { error: errMsg });
                createResponse(res, 500, errMsg);
            }
            return;
        }

        const results: any[] = [];
        const summary = {
            total: events.length,
            success: 0,
            failed: 0,
            matched_users: 0,
            sent: 0,
            skipped: 0,
            push_failed: 0,
        };

        for (const item of events) {
            const parsed = MonitorEventController.parseEvent(item);
            if (!parsed.ok) {
                summary.failed += 1;
                results.push({ status: 'failed', reason: parsed.message, raw: item });
                continue;
            }

            try {
                const { event } = parsed;
                await MonitorEventController.saveEvent(event, item);
                const pushResult = await WechatPushService.dispatchMonitorEvent(event);

                summary.success += 1;
                summary.matched_users += pushResult.matched_users;
                summary.sent += pushResult.sent;
                summary.skipped += pushResult.skipped;
                summary.push_failed += pushResult.failed;
                results.push({
                    status: 'success',
                    event_id: event.event_id,
                    stock_code: event.stock_code,
                    stock_name: event.stock_name,
                    ...pushResult,
                });
            } catch (err: any) {
                const errMsg = err instanceof Error ? err.message : String(err);
                summary.failed += 1;
                MonitorEventController.log('mock', 'failed to handle monitor event item', { error: errMsg });
                results.push({
                    status: 'failed',
                    event_id: parsed.event.event_id,
                    stock_code: parsed.event.stock_code,
                    stock_name: parsed.event.stock_name,
                    reason: errMsg,
                });
            }
        }

        createResponse(res, summary.failed > 0 ? 207 : 200, 'batch success', {
            summary,
            results,
        });
    }
}
