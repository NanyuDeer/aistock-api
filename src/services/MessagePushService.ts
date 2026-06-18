/**
 * 统一消息推送服务
 *
 * 每日2次推送（9:00 / 17:00）：
 * - 股票异动监测提醒 + 爆发风口提醒，合并为一条消息
 * - 标签：【股票异动监测提醒】 / 【爆发风口提醒】 / 【股票异动监测提醒x爆发风口提醒】
 * - 支持多渠道：飞书卡片 / 微信文本
 */

import pool from '../db';
import axios from 'axios';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// 推送时间配置
const PUSH_SCHEDULES = [
    { hour: 9, minute: 0, label: '早报' },
    { hour: 17, minute: 0, label: '晚报' },
];

// ==================== 标签 ====================

type PushLabel = '【股票异动监测提醒】' | '【爆发风口提醒】' | '【股票异动监测提醒x爆发风口提醒】';

function getPushLabel(hasStockInfo: boolean, hasOutbreak: boolean): PushLabel {
    if (hasStockInfo && hasOutbreak) return '【股票异动监测提醒x爆发风口提醒】';
    if (hasStockInfo) return '【股票异动监测提醒】';
    return '【爆发风口提醒】';
}

// ==================== 飞书API ====================

async function getFeishuAppToken(): Promise<string> {
    const res = await axios.post(
        `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
        { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
    );
    return res.data?.app_access_token || '';
}

async function sendFeishuCard(openId: string, card: any): Promise<boolean> {
    try {
        const appToken = await getFeishuAppToken();
        await axios.post(
            `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`,
            {
                receive_id: openId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
            {
                headers: {
                    Authorization: `Bearer ${appToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        return true;
    } catch (err: any) {
        console.error('[MessagePush] 飞书发送失败:', err?.response?.data || err.message);
        return false;
    }
}

// ==================== 数据查询 ====================

interface Subscriber {
    user_id: number;
    feishu_open_id: string;
    feishu_name: string;
    wechat_openid: string;
    channel: 'feishu' | 'wechat';
}

async function getSubscribers(): Promise<Subscriber[]> {
    try {
        const result = await pool.query(
            `SELECT us.user_id, us.feishu_open_id, us.feishu_name, us.wechat_openid,
                    COALESCE(us.channel, 'feishu') AS channel
             FROM user_subscriptions us
             WHERE us.status = 'subscribed'
               AND (us.feishu_open_id != '' OR us.wechat_openid != '')`,
        );
        return result.rows;
    } catch {
        return [];
    }
}

interface FavoriteStock {
    symbol: string;
    name: string;
}

async function getUserFavorites(userId: number): Promise<FavoriteStock[]> {
    try {
        const result = await pool.query(
            `SELECT s.symbol, s.name
             FROM user_favorites uf
             JOIN stocks s ON uf.stock_id = s.id
             WHERE uf.user_id = $1
             ORDER BY uf.created_at DESC
             LIMIT 10`,
            [userId],
        );
        return result.rows;
    } catch {
        return [];
    }
}

interface StockInfoItem {
    symbol: string;
    name: string;
    title: string;
    source: string;
    keywords: string[];
    published_at: string;
}

async function getRecentStockInfo(symbols: string[], hours: number = 6): Promise<StockInfoItem[]> {
    try {
        if (symbols.length === 0) return [];
        const result = await pool.query(
            `SELECT DISTINCT ON (si.symbol, si.title) si.symbol, si.name, si.title, si.source, si.keywords, si.published_at
             FROM stock_info si
             WHERE si.symbol = ANY($1) AND si.published_at > NOW() - INTERVAL '${hours} hours'
             ORDER BY si.symbol, si.title, si.published_at DESC
             LIMIT 20`,
            [symbols],
        );
        return result.rows.map((row: any) => ({
            ...row,
            keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords || [],
        }));
    } catch {
        return [];
    }
}

interface OutbreakStock {
    name: string;
    concept: string;
    change_pct: number;
    reason: string;
}

async function getOutbreakStocks(): Promise<OutbreakStock[]> {
    try {
        const result = await pool.query(
            `SELECT name, concept, change_pct, reason
             FROM hot_sectors
             WHERE created_at > CURRENT_DATE
             ORDER BY change_pct DESC
             LIMIT 3`,
        );
        return result.rows;
    } catch {
        return [];
    }
}

// ==================== 消息构建 ====================

function buildUnifiedCard(
    label: PushLabel,
    stockInfos: StockInfoItem[],
    outbreakStocks: OutbreakStock[],
    scheduleLabel: string,
): any {
    const elements: any[] = [];

    // 标题行
    elements.push({
        tag: 'div',
        text: {
            tag: 'lark_md',
            content: `${label} ${scheduleLabel}`,
        },
    });
    elements.push({ tag: 'hr' });

    // 股票异动监测提醒段
    if (stockInfos.length > 0) {
        elements.push({
            tag: 'div',
            text: { tag: 'plain_text', content: '📊 股票异动监测提醒' },
        });
        for (const info of stockInfos.slice(0, 8)) {
            const kwText = info.keywords.length > 0 ? ` [${info.keywords.slice(0, 3).join('/')}]` : '';
            elements.push({
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**${info.name}**${kwText}\n${info.title}\n<font color="grey">${info.source}</font>`,
                },
            });
            elements.push({ tag: 'hr' });
        }
    }

    // 爆发风口提醒段
    if (outbreakStocks.length > 0) {
        elements.push({
            tag: 'div',
            text: { tag: 'plain_text', content: '🔥 爆发风口提醒' },
        });
        for (const stock of outbreakStocks) {
            const changeStr = stock.change_pct > 0 ? `+${stock.change_pct.toFixed(2)}%` : `${stock.change_pct.toFixed(2)}%`;
            elements.push({
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**${stock.name}** <font color="red">${changeStr}</font>\n板块: ${stock.concept}\n${stock.reason || ''}`,
                },
            });
            elements.push({ tag: 'hr' });
        }
    }

    const headerColor = label.includes('爆发风口提醒') ? 'red' : 'blue';

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: label },
            template: headerColor,
        },
        elements,
    };
}

function buildWechatText(
    label: PushLabel,
    stockInfos: StockInfoItem[],
    outbreakStocks: OutbreakStock[],
): string {
    const lines: string[] = [`${label}`];

    if (stockInfos.length > 0) {
        lines.push('\n📊 股票异动监测提醒');
        for (const info of stockInfos.slice(0, 5)) {
            lines.push(`• ${info.name} ${info.title}`);
        }
    }

    if (outbreakStocks.length > 0) {
        lines.push('\n🔥 爆发风口提醒');
        for (const stock of outbreakStocks) {
            const changeStr = stock.change_pct > 0 ? `+${stock.change_pct.toFixed(2)}%` : `${stock.change_pct.toFixed(2)}%`;
            lines.push(`• ${stock.name} ${changeStr} ${stock.concept}`);
        }
    }

    return lines.join('\n');
}

// ==================== 推送执行 ====================

export class MessagePushService {
    private static timer: NodeJS.Timeout | null = null;

    static startScheduler(): void {
        if (this.timer) return;

        console.log('[MessagePush] 启动定时推送调度器');

        this.timer = setInterval(() => {
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();

            for (const schedule of PUSH_SCHEDULES) {
                if (hour === schedule.hour && minute === schedule.minute) {
                    console.log(`[MessagePush] 到达推送时间: ${schedule.label}`);
                    this.executePush(schedule.label).catch(err => {
                        console.error(`[MessagePush] ${schedule.label}推送失败:`, err.message);
                    });
                }
            }
        }, 60000);
    }

    static stopScheduler(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[MessagePush] 停止定时推送调度器');
        }
    }

    static async executePush(scheduleLabel: string): Promise<{ success: number; fail: number }> {
        const subscribers = await getSubscribers();
        console.log(`[MessagePush] ${scheduleLabel}: ${subscribers.length} 个订阅用户`);

        let success = 0;
        let fail = 0;

        // 全量获取爆发风口提醒股（所有用户共享）
        const outbreakStocks = await getOutbreakStocks();

        for (const sub of subscribers) {
            try {
                // 获取用户自选股资讯
                const favorites = await getUserFavorites(sub.user_id);
                const symbols = favorites.map(f => f.symbol);
                const stockInfos = await getRecentStockInfo(symbols, 6);

                const hasStockInfo = stockInfos.length > 0;
                const hasOutbreak = outbreakStocks.length > 0;

                if (!hasStockInfo && !hasOutbreak) continue;

                const label = getPushLabel(hasStockInfo, hasOutbreak);

                if (sub.channel === 'wechat' && sub.wechat_openid) {
                    // 微信：逐条模板消息推送
                    const { WechatPushService } = await import('./WechatPushService');
                    for (const info of stockInfos) {
                        await WechatPushService.dispatchStockInfoJudgement({
                            id: 0, symbol: info.symbol, stock_name: info.name,
                            info_type: 'news', title: info.title, url: '',
                            published_at: info.published_at,
                            ai_impact: '', ai_horizon: '', ai_keywords: info.keywords, ai_summary: '',
                        });
                    }
                    // 微信爆发风口提醒暂用飞书兜底，后续可扩展模板消息
                    if (hasOutbreak) {
                        const card = buildUnifiedCard(label, [], outbreakStocks, scheduleLabel);
                        const sent = await sendFeishuCard(sub.feishu_open_id, card);
                        if (sent) success++;
                        else fail++;
                    }
                    success++;
                } else if (sub.feishu_open_id) {
                    // 飞书：卡片消息
                    const card = buildUnifiedCard(label, stockInfos, outbreakStocks, scheduleLabel);
                    const sent = await sendFeishuCard(sub.feishu_open_id, card);
                    if (sent) success++;
                    else fail++;
                }
            } catch (err: any) {
                console.error(`[MessagePush] 用户${sub.user_id}推送失败:`, err.message);
                fail++;
            }
        }

        console.log(`[MessagePush] ${scheduleLabel}推送完成: 成功${success}, 失败${fail}`);
        return { success, fail };
    }

    static async manualPush(): Promise<{ success: number; fail: number }> {
        return this.executePush('手动推送');
    }
}