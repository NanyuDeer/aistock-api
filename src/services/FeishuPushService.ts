/**
 * 飞书Bot定时推送服务
 *
 * 每日3次推送（9:00 / 13:00 / 19:00）：
 * 1. 自选股资讯推送
 * 2. 风口爆发股推送（3支）
 */

import pool from '../db';
import axios from 'axios';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// 推送时间配置
const PUSH_SCHEDULES = [
    { hour: 9, minute: 0, label: '早报' },
    { hour: 13, minute: 0, label: '午报' },
    { hour: 19, minute: 0, label: '晚报' },
];

// ==================== 飞书API ====================

async function getFeishuAppToken(): Promise<string> {
    const res = await axios.post(
        `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
        { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
    );
    return res.data?.app_access_token || '';
}

async function sendFeishuCardMessage(openId: string, card: any): Promise<boolean> {
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
        console.error('[FeishuPush] 发送卡片消息失败:', err?.response?.data || err.message);
        return false;
    }
}

// ==================== 数据查询 ====================

interface Subscriber {
    user_id: number;
    feishu_open_id: string;
    feishu_name: string;
}

async function getSubscribers(): Promise<Subscriber[]> {
    try {
        const result = await pool.query(
            `SELECT us.user_id, us.feishu_open_id, us.feishu_name
             FROM user_subscriptions us
             WHERE us.status = 'subscribed' AND us.feishu_open_id != ''`,
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

async function getUserFavoriteStocks(userId: number): Promise<FavoriteStock[]> {
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

interface StockInfo {
    symbol: string;
    name: string;
    title: string;
    source: string;
    keywords: string[];
    published_at: string;
}

async function getStockInfoForPush(symbols: string[], hours: number = 6): Promise<StockInfo[]> {
    try {
        if (symbols.length === 0) return [];
        const result = await pool.query(
            `SELECT DISTINCT ON (si.id) si.symbol, si.name, si.title, si.source, si.keywords, si.published_at
             FROM stock_info si
             WHERE si.symbol = ANY($1) AND si.published_at > NOW() - INTERVAL '${hours} hours'
             ORDER BY si.id DESC
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

function buildStockInfoCard(infos: StockInfo[], scheduleLabel: string): any {
    const elements: any[] = [];

    // 标题
    elements.push({
        tag: 'div',
        text: {
            tag: 'plain_text',
            content: `📊 ${scheduleLabel} - 自选股资讯`,
        },
    });

    if (infos.length === 0) {
        elements.push({
            tag: 'div',
            text: {
                tag: 'plain_text',
                content: '暂无新的自选股资讯',
            },
        });
    } else {
        for (const info of infos.slice(0, 8)) {
            const kwText = info.keywords.length > 0 ? ` [${info.keywords.slice(0, 3).join('/')}]` : '';
            elements.push({
                tag: 'div',
                text: {
                    tag: 'lark_md',
                    content: `**${info.name}** ${kwText}\n${info.title}\n<font color="grey">${info.source} ${info.published_at || ''}</font>`,
                },
            });
            elements.push({ tag: 'hr' });
        }
    }

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '🤖 AI股票资讯助手' },
            template: 'blue',
        },
        elements,
    };
}

function buildOutbreakCard(stocks: OutbreakStock[], scheduleLabel: string): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: {
            tag: 'plain_text',
            content: `🔥 ${scheduleLabel} - 风口爆发股`,
        },
    });

    if (stocks.length === 0) {
        elements.push({
            tag: 'div',
            text: {
                tag: 'plain_text',
                content: '今日暂无风口爆发信号',
            },
        });
    } else {
        for (const stock of stocks) {
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

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '🔥 风口爆发提醒' },
            template: 'red',
        },
        elements,
    };
}

// ==================== 推送执行 ====================

export class FeishuPushService {
    private static timer: NodeJS.Timeout | null = null;

    /**
     * 启动定时推送调度
     */
    static startScheduler(): void {
        if (this.timer) return;

        console.log('[FeishuPush] 启动定时推送调度器');

        // 每分钟检查是否到推送时间
        this.timer = setInterval(() => {
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();

            for (const schedule of PUSH_SCHEDULES) {
                if (hour === schedule.hour && minute === schedule.minute) {
                    console.log(`[FeishuPush] 到达推送时间: ${schedule.label}`);
                    this.executePush(schedule.label).catch(err => {
                        console.error(`[FeishuPush] ${schedule.label}推送失败:`, err.message);
                    });
                }
            }
        }, 60000); // 每分钟检查
    }

    /**
     * 停止定时推送
     */
    static stopScheduler(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            console.log('[FeishuPush] 停止定时推送调度器');
        }
    }

    /**
     * 执行一次推送
     */
    static async executePush(scheduleLabel: string): Promise<{ success: number; fail: number }> {
        const subscribers = await getSubscribers();
        console.log(`[FeishuPush] ${scheduleLabel}: ${subscribers.length} 个订阅用户`);

        let success = 0;
        let fail = 0;

        // 获取风口爆发股（所有用户共享）
        const outbreakStocks = await getOutbreakStocks();

        for (const sub of subscribers) {
            try {
                // 获取用户自选股资讯
                const favorites = await getUserFavoriteStocks(sub.user_id);
                const symbols = favorites.map(f => f.symbol);
                const stockInfos = await getStockInfoForPush(symbols, 6);

                // 推送自选股资讯
                if (stockInfos.length > 0) {
                    const infoCard = buildStockInfoCard(stockInfos, scheduleLabel);
                    const infoOk = await sendFeishuCardMessage(sub.feishu_open_id, infoCard);
                    if (infoOk) success++;
                    else fail++;
                }

                // 推送风口爆发股
                if (outbreakStocks.length > 0) {
                    const outbreakCard = buildOutbreakCard(outbreakStocks, scheduleLabel);
                    const outbreakOk = await sendFeishuCardMessage(sub.feishu_open_id, outbreakCard);
                    if (outbreakOk) success++;
                    else fail++;
                }
            } catch (err: any) {
                console.error(`[FeishuPush] 用户${sub.user_id}推送失败:`, err.message);
                fail++;
            }
        }

        console.log(`[FeishuPush] ${scheduleLabel}推送完成: 成功${success}, 失败${fail}`);
        return { success, fail };
    }

    /**
     * 手动触发推送（测试用）
     */
    static async manualPush(): Promise<{ success: number; fail: number }> {
        return this.executePush('手动推送');
    }
}
