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

export class WechatPushService {
    private static readonly DAILY_LIMIT = 10;

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[WechatPush][${stage}] ${ts} ${message}${detail}`);
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

            if (await WechatPushService.isOverDailyLimit(openid)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'daily_limit_reached', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'daily_limit_reached' });
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
