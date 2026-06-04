import pool from '../db';
import { ScanLoginController } from '../controllers/ScanLoginController';

export interface MonitorEvent {
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
}

export interface PushLogItem {
    openid: string;
    status: 'sent' | 'skipped' | 'failed';
    reason: string | null;
    wechat_response?: any;
}

export interface PushResult {
    matched_users: number;
    sent: number;
    skipped: number;
    failed: number;
    logs: PushLogItem[];
}

export interface QueueResult {
    queued: boolean;
    reason: string | null;
    queue_size: number;
}

export class WechatPushService {
    private static readonly DAILY_LIMIT = 5;
    private static readonly STOCK_COOLDOWN_MINUTES = 30;
    private static readonly QUEUE_MAX_SIZE = Number(process.env.WECHAT_PUSH_QUEUE_MAX || 5000);
    private static readonly QUEUE_INTERVAL_MS = Number(process.env.WECHAT_PUSH_QUEUE_INTERVAL_MS || 300);
    private static readonly pushQueue: MonitorEvent[] = [];
    private static readonly queuedEventIds = new Set<string>();
    private static isQueueProcessing = false;
    private static readonly LEVEL_RANK: Record<string, number> = {
        L1: 1,
        L2: 2,
        L3: 3,
        L4: 4,
    };
    private static readonly EVENT_TYPE_SETTING_MAP: Record<string, string> = {
        '短线异动': 'push_tag_short_term',
        '中线异动': 'push_tag_mid_term',
        '长线异动': 'push_tag_long_term',
    };

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[WechatPush][${stage}] ${ts} ${message}${detail}`);
    }

    private static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private static startQueueWorker(): void {
        if (WechatPushService.isQueueProcessing) return;
        WechatPushService.isQueueProcessing = true;
        setImmediate(() => {
            WechatPushService.processQueue().catch(err => {
                WechatPushService.isQueueProcessing = false;
                WechatPushService.log('queue', 'worker crashed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        });
    }

    private static async processQueue(): Promise<void> {
        while (WechatPushService.pushQueue.length > 0) {
            const event = WechatPushService.pushQueue.shift();
            if (!event) continue;
            WechatPushService.queuedEventIds.delete(event.event_id);

            try {
                const result = await WechatPushService.dispatchMonitorEvent(event);
                WechatPushService.log('queue', 'event dispatched', {
                    event_id: event.event_id,
                    symbol: event.symbol,
                    matched_users: result.matched_users,
                    sent: result.sent,
                    skipped: result.skipped,
                    failed: result.failed,
                    queue_size: WechatPushService.pushQueue.length,
                });
            } catch (err: any) {
                WechatPushService.log('queue', 'event dispatch failed', {
                    event_id: event.event_id,
                    symbol: event.symbol,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            if (WechatPushService.QUEUE_INTERVAL_MS > 0) {
                await WechatPushService.sleep(WechatPushService.QUEUE_INTERVAL_MS);
            }
        }

        WechatPushService.isQueueProcessing = false;
        if (WechatPushService.pushQueue.length > 0) {
            WechatPushService.startQueueWorker();
        }
    }

    static enqueueMonitorEvent(event: MonitorEvent): QueueResult {
        if (WechatPushService.queuedEventIds.has(event.event_id)) {
            return {
                queued: false,
                reason: 'duplicate_queued',
                queue_size: WechatPushService.pushQueue.length,
            };
        }

        if (WechatPushService.pushQueue.length >= WechatPushService.QUEUE_MAX_SIZE) {
            WechatPushService.log('queue', 'queue full, event rejected', {
                event_id: event.event_id,
                symbol: event.symbol,
                queue_size: WechatPushService.pushQueue.length,
                queue_max_size: WechatPushService.QUEUE_MAX_SIZE,
            });
            return {
                queued: false,
                reason: 'queue_full',
                queue_size: WechatPushService.pushQueue.length,
            };
        }

        WechatPushService.pushQueue.push(event);
        WechatPushService.queuedEventIds.add(event.event_id);
        WechatPushService.startQueueWorker();

        return {
            queued: true,
            reason: null,
            queue_size: WechatPushService.pushQueue.length,
        };
    }

    private static buildDetailUrl(detailUrl: string): string {
        if (/^https?:\/\//i.test(detailUrl)) return detailUrl;
        const base = process.env.FRONTEND_URL || '';
        if (!base) return detailUrl;
        return `${base.replace(/\/+$/, '')}/${detailUrl.replace(/^\/+/, '')}`;
    }

    private static formatEventTime(eventTime: string): string {
        if (!eventTime) return '';
        const normalized = eventTime.replace('T', ' ');
        const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        return match ? `${match[1]} ${match[2]}` : eventTime;
    }

    private static async isPushEnabled(openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT enabled
             FROM user_settings
             WHERE openid = $1 AND setting_type = 'stock_push'
             LIMIT 1`,
            [openid],
        );
        const setting = result.rows[0];
        return !setting || Number(setting.enabled) !== 0;
    }

    private static async isEventTypeMatched(openid: string, eventType: string): Promise<boolean> {
        const requiredSetting = WechatPushService.EVENT_TYPE_SETTING_MAP[eventType];
        if (!requiredSetting) return true;

        const result = await pool.query(
            `SELECT setting_type, enabled
             FROM user_settings
             WHERE openid = $1
               AND setting_type IN ('push_tag_short_term', 'push_tag_mid_term', 'push_tag_long_term')`,
            [openid],
        );

        const settings = result.rows || [];
        if (settings.length === 0) {
            return true;
        }

        return settings.some((item: any) =>
            item.setting_type === requiredSetting && Number(item.enabled) === 1,
        );
    }

    private static async hasPushed(eventId: string, openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT id
             FROM wechat_push_logs
             WHERE event_id = $1 AND openid = $2
             LIMIT 1`,
            [eventId, openid],
        );
        return (result.rowCount || 0) > 0;
    }

    private static async isOverDailyLimit(openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM wechat_push_logs
             WHERE openid = $1
               AND status = 'sent'
               AND sent_at::date = CURRENT_DATE`,
            [openid],
        );
        return Number(result.rows[0]?.count || 0) >= WechatPushService.DAILY_LIMIT;
    }

    private static getLevelRank(level: string): number {
        return WechatPushService.LEVEL_RANK[String(level || '').toUpperCase()] || 0;
    }

    private static isLowPriorityLevel(level: string): boolean {
        return WechatPushService.getLevelRank(level) <= WechatPushService.LEVEL_RANK.L1;
    }

    private static async isInStockCooldown(event: MonitorEvent, openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT level
             FROM wechat_push_logs
             WHERE openid = $1
               AND symbol = $2
               AND status = 'sent'
               AND sent_at >= CURRENT_TIMESTAMP - ($3::text || ' minutes')::interval
             ORDER BY sent_at DESC
             LIMIT 1`,
            [openid, event.symbol, WechatPushService.STOCK_COOLDOWN_MINUTES],
        );

        const lastSent = result.rows[0];
        if (!lastSent) return false;

        const currentRank = WechatPushService.getLevelRank(event.level);
        const lastRank = WechatPushService.getLevelRank(lastSent.level);
        return currentRank <= lastRank;
    }

    private static async insertPushLog(
        event: MonitorEvent,
        openid: string,
        status: PushLogItem['status'],
        errorMsg: string | null,
        responseJson: any,
    ): Promise<void> {
        await pool.query(
            `INSERT INTO wechat_push_logs (
                event_id,
                openid,
                symbol,
                stock_name,
                event_type,
                level,
                summary,
                template_id,
                status,
                error_msg,
                wechat_response_json,
                click_url
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             ON CONFLICT(event_id, openid) DO NOTHING`,
            [
                event.event_id,
                openid,
                event.symbol,
                event.stock_name,
                event.event_type,
                event.level,
                event.summary,
                process.env.WECHAT_TEMPLATE_ID || '',
                status,
                errorMsg,
                responseJson ? JSON.stringify(responseJson) : null,
                WechatPushService.buildDetailUrl(event.detail_url),
            ],
        );
    }

    private static async sendTemplateMessage(event: MonitorEvent, openid: string): Promise<any> {
        if (!process.env.WECHAT_TEMPLATE_ID) {
            throw new Error('WECHAT_TEMPLATE_ID is not configured');
        }

        const accessToken = await ScanLoginController.getServerAccessToken();
        const detailUrl = WechatPushService.buildDetailUrl(event.detail_url);
        const res = await fetch(
            `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    touser: openid,
                    template_id: process.env.WECHAT_TEMPLATE_ID,
                    url: detailUrl,
                    data: {
                        stock: { value: `${event.stock_name} (${event.symbol})` },
                        event_type: { value: event.event_type },
                        level: { value: event.level },
                        summary: { value: event.summary },
                        time: { value: WechatPushService.formatEventTime(event.event_time) },
                    },
                }),
            },
        );
        const data: any = await res.json();
        if (data.errcode && data.errcode !== 0) {
            throw new Error(`wechat template send failed: ${data.errmsg || data.errcode}`);
        }
        return data;
    }

    static async dispatchMonitorEvent(event: MonitorEvent): Promise<PushResult> {
        const result = await pool.query(
            `SELECT DISTINCT u.openid
             FROM users u
             INNER JOIN user_stocks us ON u.openid = us.openid
             WHERE us.symbol = $1`,
            [event.symbol],
        );

        const users = result.rows || [];
        const pushResult: PushResult = {
            matched_users: users.length,
            sent: 0,
            skipped: 0,
            failed: 0,
            logs: [],
        };

        for (const user of users) {
            const openid = String(user.openid || '');
            if (!openid) continue;

            if (await WechatPushService.hasPushed(event.event_id, openid)) {
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'duplicate_event' });
                continue;
            }

            if (!(await WechatPushService.isPushEnabled(openid))) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'stock_push_disabled', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'stock_push_disabled' });
                continue;
            }

            if (!(await WechatPushService.isEventTypeMatched(openid, event.event_type))) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'tag_mismatch', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'tag_mismatch' });
                continue;
            }

            if (WechatPushService.isLowPriorityLevel(event.level)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'low_level', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'low_level' });
                continue;
            }

            if (await WechatPushService.isOverDailyLimit(openid)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'daily_limit_reached', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'daily_limit_reached' });
                continue;
            }

            if (await WechatPushService.isInStockCooldown(event, openid)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'stock_cooldown', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'stock_cooldown' });
                continue;
            }

            try {
                const wxResponse = await WechatPushService.sendTemplateMessage(event, openid);
                await WechatPushService.insertPushLog(event, openid, 'sent', null, wxResponse);
                pushResult.sent += 1;
                pushResult.logs.push({ openid, status: 'sent', reason: null, wechat_response: wxResponse });
            } catch (err: any) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                WechatPushService.log('send', 'template send failed', {
                    openid,
                    event_id: event.event_id,
                    error: errorMsg,
                });
                await WechatPushService.insertPushLog(event, openid, 'failed', errorMsg, { error: errorMsg });
                pushResult.failed += 1;
                pushResult.logs.push({ openid, status: 'failed', reason: errorMsg });
            }
        }

        return pushResult;
    }
}
