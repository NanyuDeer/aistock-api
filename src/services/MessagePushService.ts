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
import * as fs from 'fs';
import * as path from 'path';
import { HotspotOutbreakService } from './HotspotOutbreakService';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// 推送时间配置
const PUSH_SCHEDULES = [
    { hour: 8, minute: 30, label: '龙头股日报', type: 'leader' as const },
    { hour: 9, minute: 0, label: '早报', type: 'outbreak+stock' as const },
    { hour: 17, minute: 0, label: '晚报', type: 'outbreak+stock' as const },
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
            `SELECT us.id AS user_id, us.feishu_open_id, us.feishu_name, us.user_openid AS wechat_openid,
                    CASE WHEN us.feishu_open_id IS NOT NULL AND us.feishu_open_id != '' THEN 'feishu' ELSE 'wechat' END AS channel
             FROM user_subscriptions us
             WHERE us.status = 'subscribed'
               AND (us.feishu_open_id != '' OR us.user_openid != '')`,
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
        const result = await HotspotOutbreakService.detectOutbreak();
        return result.outbreaks.slice(0, 3).map(signal => ({
            name: signal.stockName || signal.symbol,
            concept: signal.thsSectorName || signal.newsKeywords.join('、'),
            change_pct: signal.resonanceScore,
            reason: buildOutbreakReason(signal),
        }));
    } catch (err: any) {
        console.error('[MessagePush] 获取风口爆发数据失败:', err?.message || err);
        return [];
    }
}

// ==================== 龙头股数据提取（渠道无关，飞书可复用） ====================

interface LeaderStockData {
    name: string;
    code: string;
    industry: string;
    change_pct: number;
    reason: string;
    score: number;
}

async function getLeaderStocksForPush(): Promise<LeaderStockData[]> {
    try {
        const dataFile = path.resolve(__dirname, '../../data/hot-sectors.json');
        const raw = fs.readFileSync(dataFile, 'utf-8');
        const data = JSON.parse(raw);
        const sectors = Array.isArray(data?.hot_sectors) ? data.hot_sectors : [];

        // 收集所有板块的main_stocks，附带板块名
        const allStocks: LeaderStockData[] = [];
        for (const sector of sectors) {
            const sectorName = sector.name || '';
            const mainStocks = Array.isArray(sector.main_stocks) ? sector.main_stocks : [];
            for (const stock of mainStocks) {
                allStocks.push({
                    name: stock.name || '',
                    code: stock.code || '',
                    industry: sectorName,
                    change_pct: Number(stock.change_pct) || 0,
                    reason: stock.reason || '',
                    score: Number(stock.score) || 0,
                });
            }
        }

        // 按score降序排列
        allStocks.sort((a, b) => b.score - a.score);

        // 跨板块去重（同一股票只保留得分最高的板块）
        const usedCodes = new Set<string>();
        const deduped: LeaderStockData[] = [];
        for (const stock of allStocks) {
            if (!usedCodes.has(stock.code)) {
                usedCodes.add(stock.code);
                deduped.push(stock);
            }
            if (deduped.length >= 3) break;
        }

        return deduped;
    } catch (err: any) {
        console.error('[MessagePush] 读取龙头股数据失败:', err?.message || err);
        return [];
    }
}

// ==================== 风口爆发数据提取（扩展字段，供微信模板使用） ====================

interface OutbreakPushData {
    name: string;
    code: string;
    sector: string;
    resonance_score: number;
    resonance_level: string;
    trigger_reason: string;
}

async function getOutbreakStocksForWechat(): Promise<OutbreakPushData[]> {
    try {
        const result = await HotspotOutbreakService.detectOutbreak();
        return result.outbreaks.slice(0, 3).map(signal => ({
            name: signal.stockName || signal.symbol,
            code: signal.symbol,
            sector: signal.thsSectorName || signal.newsKeywords.join('、'),
            resonance_score: signal.resonanceScore,
            resonance_level: signal.resonanceLevel === 'critical' ? '极高' : signal.resonanceLevel === 'high' ? '高' : signal.resonanceLevel === 'medium' ? '中' : '低',
            trigger_reason: buildOutbreakReason(signal),
        }));
    } catch (err: any) {
        console.error('[MessagePush] 获取风口爆发微信数据失败:', err?.message || err);
        return [];
    }
}

function buildOutbreakReason(signal: any): string {
    const parts: string[] = [];
    if (signal.newsCount > 0) parts.push(`资讯${signal.newsCount}次`);
    if (signal.newsSurgeRatio > 1) parts.push(`爆发比${signal.newsSurgeRatio.toFixed(1)}`);
    if (signal.feishuMessageCount > 0) parts.push(`飞书${signal.feishuMessageCount}次`);
    if (signal.thsVerified) parts.push(`同花顺验证(${signal.thsSectorName}#${signal.thsSectorRank})`);
    if (signal.resonance1?.verified) parts.push(`概念共振(${signal.resonance1.conceptName})`);
    if (signal.resonance3?.verified) parts.push(`研报${signal.resonance3.reportCount}篇`);
    return parts.length > 0 ? parts.join('，') : signal.newsKeywords.slice(0, 3).join('、') || '共振信号';
}

// ==================== 消息构建 ====================

function buildLeaderFeishuCard(stocks: LeaderStockData[]): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '**风口板块及龙头股推荐**' },
    });
    elements.push({ tag: 'hr' });

    const sectors = stocks.map(s => s.industry).join(' / ');
    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `风口板块：${sectors}` },
    });
    elements.push({ tag: 'hr' });

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        const changeStr = stock.change_pct > 0
            ? `+${stock.change_pct.toFixed(2)}%`
            : `${stock.change_pct.toFixed(2)}%`;
        const color = stock.change_pct > 0 ? 'red' : 'green';
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**龙头股${i + 1}：${stock.name}(${stock.code})** <font color="${color}">${changeStr}</font>\n推荐理由：${stock.reason}`,
            },
        });
        elements.push({ tag: 'hr' });
    }

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '<font color="grey">点击查看完整龙头股一览</font>' },
    });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '【龙头股日报】' },
            template: 'green',
        },
        elements,
    };
}

function buildOutbreakFeishuCard(stocks: OutbreakPushData[]): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '**风口爆发检测到共振信号**' },
    });
    elements.push({ tag: 'hr' });

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**${stock.name}(${stock.code})**\n概念板块：${stock.sector}\n共振强度：${stock.resonance_level}（${stock.resonance_score}分）\n触发原因：${stock.trigger_reason}`,
            },
        });
        elements.push({ tag: 'hr' });
    }

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '<font color="grey">三步验证通过，点击查看详情</font>' },
    });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '【风口爆发预警】' },
            template: 'red',
        },
        elements,
    };
}

interface StockInfoPushEventData {
    symbol: string;
    stock_name: string;
    info_type: string;
    title: string;
    ai_impact: string;
    ai_horizon: string;
    ai_summary: string;
    published_at: string;
}

function buildStockInfoFeishuCard(event: StockInfoPushEventData): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '**您的自选股有新动态**' },
    });
    elements.push({ tag: 'hr' });

    const eventType = event.info_type === 'announcement' ? '公告研判' : '新闻研判';
    const time = new Date(event.published_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    elements.push({
        tag: 'div',
        text: {
            tag: 'lark_md',
            content: `股票：**${event.stock_name}**(${event.symbol})\n事件类型：${eventType}\n影响级别：${event.ai_impact}/${event.ai_horizon}\n摘要：${event.ai_summary || event.title}\n发生时间：${time}`,
        },
    });
    elements.push({ tag: 'hr' });

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '<font color="grey">点击查看完整分析</font>' },
    });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '【自选股异动提醒】' },
            template: 'orange',
        },
        elements,
    };
}

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
                    this.executePush(schedule).catch(err => {
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

    static async executePush(schedule: { label: string; type: string }): Promise<{ success: number; fail: number }> {
        // 龙头股日报推送
        if (schedule.type === 'leader') {
            return this.executeLeaderPush();
        }

        // 原有的 outbreak+stock 推送逻辑
        return this.executeOutbreakAndStockPush(schedule.label);
    }

    // ==================== 龙头股推送 ====================

    static async executeLeaderPush(force: boolean = false): Promise<{ success: number; fail: number; detail?: any }> {
        const stocks = await getLeaderStocksForPush();
        if (stocks.length === 0) {
            console.log('[MessagePush] 龙头股日报: 无数据，跳过推送');
            return { success: 0, fail: 0, detail: { reason: 'no_stocks', stocksCount: 0 } };
        }

        console.log(`[MessagePush] 龙头股日报: 提取到${stocks.length}只龙头股`, stocks.map(s => `${s.name}(${s.code}) score=${s.score}`));

        let success = 0;
        let fail = 0;

        // 微信推送
        const { WechatPushService } = await import('./WechatPushService');
        const leaderStocks: any[] = stocks.map(s => ({
            name: s.name,
            code: s.code,
            industry: s.industry,
            change_pct: s.change_pct,
            reason: s.reason,
        }));
        const wxResult = await WechatPushService.dispatchLeaderStocks(leaderStocks, force);
        success += wxResult.sent;
        fail += wxResult.failed;
        console.log(`[MessagePush] 龙头股日报微信推送: 发送${wxResult.sent}, 跳过${wxResult.skipped}, 失败${wxResult.failed}`);

        // 飞书推送
        const subscribers = await getSubscribers();
        const feishuSubs = subscribers.filter(s => s.feishu_open_id);
        if (feishuSubs.length > 0) {
            const card = buildLeaderFeishuCard(stocks);
            for (const sub of feishuSubs) {
                const sent = await sendFeishuCard(sub.feishu_open_id, card);
                if (sent) success++;
                else fail++;
            }
            console.log(`[MessagePush] 龙头股日报飞书推送: ${feishuSubs.length} 个用户`);
        }

        console.log(`[MessagePush] 龙头股日报推送完成: 成功${success}, 失败${fail}`);
        return { success, fail, detail: { wxMatched: wxResult.matched_users, wxSkipped: wxResult.skipped, feishuCount: feishuSubs.length, logs: wxResult.logs } };
    }

    // ==================== 风口爆发+个股资讯推送 ====================

    /** 手动触发风口爆发推送（测试用） */
    static async executeOutbreakPush(testData?: any[], force: boolean = false): Promise<{ success: number; fail: number; detail?: any }> {
        const { WechatPushService } = await import('./WechatPushService');
        let outbreakData: OutbreakPushData[];
        if (testData && testData.length > 0) {
            outbreakData = testData;
        } else {
            outbreakData = await getOutbreakStocksForWechat();
        }
        if (outbreakData.length === 0) {
            console.log('[MessagePush] 无风口爆发数据，跳过推送');
            return { success: 0, fail: 0, detail: { message: '无风口爆发数据' } };
        }
        console.log(`[MessagePush] 检测到 ${outbreakData.length} 只风口爆发股，开始推送`);

        // 微信推送
        const wxResult = await WechatPushService.dispatchOutbreakStocks(outbreakData, force);

        // 飞书推送
        const feishuSubs = await getSubscribers();
        const feishuUsers = feishuSubs.filter(s => s.feishu_open_id);
        let feishuSent = 0;
        let feishuFail = 0;
        if (feishuUsers.length > 0) {
            const card = buildOutbreakFeishuCard(outbreakData);
            for (const sub of feishuUsers) {
                const ok = await sendFeishuCard(sub.feishu_open_id, card);
                if (ok) feishuSent++;
                else feishuFail++;
            }
        }

        return {
            success: wxResult.sent,
            fail: wxResult.failed,
            detail: {
                wxMatched: wxResult.matched_users, wxSkipped: wxResult.skipped,
                feishuSent, feishuFail,
                outbreakData, logs: wxResult.logs,
            },
        };
    }

    static async executeOutbreakAndStockPush(scheduleLabel: string): Promise<{ success: number; fail: number }> {
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
                    // 微信风口爆发：通过模板消息推送
                    if (hasOutbreak) {
                        const outbreakData = await getOutbreakStocksForWechat();
                        if (outbreakData.length > 0) {
                            await WechatPushService.dispatchOutbreakStocks(outbreakData);
                        }
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
        return this.executePush({ label: '手动推送', type: 'outbreak+stock' });
    }

    // ==================== 自选股异动飞书实时推送 ====================

    static async dispatchStockInfoToFeishu(event: StockInfoPushEventData, pushToAll: boolean = false): Promise<{ sent: number; failed: number }> {
        try {
            let rows: any[];
            if (pushToAll) {
                // 测试模式：推送给所有有飞书ID的订阅用户
                const result = await pool.query(
                    `SELECT DISTINCT feishu_open_id
                     FROM user_subscriptions
                     WHERE status = 'subscribed'
                       AND feishu_open_id IS NOT NULL
                       AND feishu_open_id != ''`,
                );
                rows = result.rows;
            } else {
                const result = await pool.query(
                    `SELECT DISTINCT us.feishu_open_id
                     FROM user_subscriptions us
                     INNER JOIN user_stocks ust ON us.user_openid = ust.openid
                     WHERE ust.symbol = $1
                       AND us.status = 'subscribed'
                       AND us.feishu_open_id IS NOT NULL
                       AND us.feishu_open_id != ''`,
                    [event.symbol],
                );
                rows = result.rows;
            }

            if (rows.length === 0) return { sent: 0, failed: 0 };

            const card = buildStockInfoFeishuCard(event);
            let sent = 0;
            let failed = 0;

            for (const row of rows) {
                const openId = String(row.feishu_open_id);
                const ok = await sendFeishuCard(openId, card);
                if (ok) sent++;
                else failed++;
            }

            console.log(`[MessagePush] 自选股异动飞书推送: ${event.stock_name}(${event.symbol}), 发送${sent}, 失败${failed}`);
            return { sent, failed };
        } catch (err: any) {
            console.error('[MessagePush] 自选股异动飞书推送失败:', err.message);
            return { sent: 0, failed: 0 };
        }
    }
}