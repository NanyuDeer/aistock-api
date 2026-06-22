/**
 * 媒体关注榜整合服务
 *
 * 整合三步数据源（个股代码驱动）：
 * 1. 财联社/格隆汇快讯中提取个股代码，检测个股爆发（HotKeywordDetectorService）
 * 2. 飞书群消息中的股票资讯关联（FeishuMessageController / DB）
 * 3. 同花顺热点掘金验证（Tushare ths_hot）
 *
 * 核心逻辑：
 * - Step1: 从快讯中提取个股代码，检测个股爆发信号
 * - Step2: 从飞书群消息中关联同只股票，提取关键词作为辅助解释
 * - Step3: 验证股票所属板块是否在同花顺热门板块Top10
 * - 输出: 经过三步验证的个股共振信号（关键词退居辅助标签）
 */

import pool from '../db';
import { HotKeywordDetectorService, extractStockCodes, type HotConceptResult } from './HotKeywordDetectorService';
import { getThsHot, type ThsHotRow } from './TushareService';
import { findResearchReportMessagesForStock } from './FeishuResearchReportService';
import { TushareQuoteService } from './TushareQuoteService';
import { TradingCalendarService } from './TradingCalendarService';

// ==================== 类型定义 ====================

export interface FeishuMessageRow {
    id: number;
    source: string;
    chat_id: string;
    chat_name: string;
    message_id: string;
    message_type: string;
    text: string;
    stock_codes: string[];
    keywords: { keyword: string; dimension: string }[];
    received_at: string;
}

/** 个股共振信号（个股代码为主维度，关键词为辅助解释） */
interface StockResonanceSignal {
    /** 股票代码，如 "300308" */
    symbol: string;
    /** 股票名称 */
    stockName: string;
    /** 资讯提及次数 */
    newsCount: number;
    /** 资讯爆发比率（当前/历史） */
    newsSurgeRatio: number;
    /** 资讯中出现的关键词（哪些关键词触发了该股票） */
    newsKeywords: string[];
    /** 飞书消息中该股票被提及次数 */
    feishuMessageCount: number;
    /** 飞书消息中匹配到的关键词 */
    feishuKeywords: string[];
    /** 同花顺验证 */
    thsVerified: boolean;
    thsSectorName: string;
    thsSectorRank: number;
    /** 共振强度得分 (0-100) */
    resonanceScore: number;
    /** 共振等级 */
    resonanceLevel: 'critical' | 'high' | 'medium' | 'low';
    /** 最新股价 */
    price: number | null;
    /** 涨跌幅(%) */
    changePct: number | null;
    /** 板块信息（同花顺验证板块或概念共振） */
    sectorInfo: string;
    /** 概念共振信息（共振一：细分概念交叉验证） */
    conceptResonance: {
        conceptName: string;       // 匹配到的细分概念
        clsCount: number;          // 财联社该概念出现次数
        glhCount: number;          // 格隆汇该概念出现次数
        conceptVerified: boolean;  // 共振一是否通过
    } | null;
    /** 相关快讯 */
    articles: { id: string; title: string; source: string; time: string }[];
    /** 检测时间 */
    detectedAt: string;
    /** 三重共振状态 */
    resonance1: { verified: boolean; conceptName: string; clsCount: number; glhCount: number };
    resonance2: { verified: boolean; rank?: number; sectorName?: string };
    resonance3: { verified: boolean; reportCount: number; latestReportTime?: string };
    /** 三重共振时间窗口校验 */
    timeWindow: {
        /** 时间窗口模式：1d=同一天内, 3d=三天内, none=超出窗口 */
        mode: '1d' | '3d' | 'none';
        /** 三个信号中最早的时间 */
        earliestSignalTime: string;
        /** 三个信号中最晚的时间 */
        latestSignalTime: string;
        /** 时间跨度（小时） */
        spanHours: number;
    };
    /** 有效共振数量（考虑时间窗口后，超3天降级为2） */
    effectiveResonanceCount: number;
}

interface HotBurstResult {
    update_time: string;
    total_stocks_checked: number;
    resonance_count: number;
    /** 有效三重共振信号数（时间窗口内） */
    triple_resonance_count: number;
    ths_hot_sectors: { name: string; rank: number; change_pct: number }[];
    outbreaks: StockResonanceSignal[];
    /** 细分概念爆发信号（共振一） */
    hot_concepts: HotConceptResult[];
}

// ==================== 同花顺热点掘金验证 ====================

async function fetchThsHotSectors(): Promise<{ name: string; rank: number; change_pct: number }[]> {
    try {
        const today = new Date();
        for (let offset = 0; offset < 3; offset++) {
            const d = new Date(today);
            d.setDate(d.getDate() - offset);
            const dateStr = formatDate(d);

            const hotData: ThsHotRow[] = await getThsHot(dateStr, '概念板块');
            if (hotData.length > 0) {
                return hotData.slice(0, 10).map((row, idx) => ({
                    name: row.ts_name || '',
                    rank: idx + 1,
                    change_pct: Number(row.pct_change) || 0,
                }));
            }
        }
    } catch (err) {
        console.warn('[HotBurst] 同花顺热榜获取失败:', (err as Error).message);
    }
    return [];
}

function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

// ==================== 辅助函数 ====================

/** 从 stocks 表查询股票名称 */
async function getStockName(symbol: string): Promise<string> {
    try {
        const result = await pool.query('SELECT name FROM stocks WHERE symbol = $1 LIMIT 1', [symbol]);
        return result.rows[0]?.name || '';
    } catch {
        return '';
    }
}

/** 查询个股所属板块（通过 stock_concept_mapping 表） */
async function getStockSector(symbol: string): Promise<string[]> {
    try {
        const result = await pool.query(
            `SELECT DISTINCT sector_name FROM stock_concept_mapping
             WHERE symbol = $1 LIMIT 20`,
            [symbol]
        );
        return result.rows.map((r: any) => r.sector_name);
    } catch {
        return [];
    }
}

/** 共振评分：资讯频次(30%) + 飞书讨论(30%) + 同花顺验证(40%) */
function calculateResonanceScore(
    newsCount: number, newsSurgeRatio: number,
    feishuMsgCount: number,
    thsRank: number, thsVerified: boolean
): { score: number; level: 'critical' | 'high' | 'medium' | 'low' } {
    // 资讯得分（爆发比率越高越好，上限100）
    const newsScore = Math.min(100, Math.min(newsCount, 10) * 10 + Math.min(newsSurgeRatio, 5) * 10);

    // 飞书得分（讨论数越多越好）
    const feishuScore = Math.min(100, feishuMsgCount * 25);

    // 同花顺得分（排名越前越高，未上榜=0）
    let thsScore = 0;
    if (thsVerified) {
        if (thsRank === 1) thsScore = 100;
        else if (thsRank <= 3) thsScore = 80;
        else if (thsRank <= 5) thsScore = 60;
        else if (thsRank <= 10) thsScore = 40;
    }

    const score = Math.round(newsScore * 0.30 + feishuScore * 0.30 + thsScore * 0.40);

    let level: 'critical' | 'high' | 'medium' | 'low';
    if (score >= 80) level = 'critical';
    else if (score >= 55) level = 'high';
    else if (score >= 30) level = 'medium';
    else level = 'low';

    return { score, level };
}

/** 计算信号通过的共振数量（0-3） */
function countResonances(sig: {
    resonance1: { verified: boolean };
    resonance2: { verified: boolean };
    resonance3: { verified: boolean };
}): number {
    return [sig.resonance1.verified, sig.resonance2.verified, sig.resonance3.verified]
        .filter(Boolean).length;
}

/**
 * 计算三重共振的时间窗口
 *
 * 规则：
 * - 三个信号在24h内发生 → mode='1d'（严格三重共振）
 * - 三个信号在72h内发生 → mode='3d'（宽松三重共振）
 * - 超过72h → mode='none'（不构成三重共振，降级为二重）
 *
 * 信号时间来源：
 * - 共振一：detectedAt（概念检测时间）
 * - 共振二：当天日期（热榜数据本身就是当天的）
 * - 共振三：resonance3.latestReportTime（研报时间）
 */
function calculateTimeWindow(sig: StockResonanceSignal): {
    mode: '1d' | '3d' | 'none';
    earliestSignalTime: string;
    latestSignalTime: string;
    spanHours: number;
} {
    const signalTimes: Date[] = [];

    // 共振一时间
    if (sig.resonance1.verified) {
        signalTimes.push(sig.detectedAt ? new Date(sig.detectedAt) : new Date());
    }

    // 共振二时间（同花顺热榜 = 当天）
    if (sig.resonance2.verified) {
        signalTimes.push(new Date());
    }

    // 共振三时间（研报时间）
    if (sig.resonance3.verified && sig.resonance3.latestReportTime) {
        signalTimes.push(new Date(sig.resonance3.latestReportTime));
    } else if (sig.resonance3.verified) {
        signalTimes.push(new Date());
    }

    if (signalTimes.length < 3) {
        const now = new Date().toISOString();
        return { mode: 'none', earliestSignalTime: now, latestSignalTime: now, spanHours: 0 };
    }

    const earliest = new Date(Math.min(...signalTimes.map(t => t.getTime())));
    const latest = new Date(Math.max(...signalTimes.map(t => t.getTime())));
    const spanHours = (latest.getTime() - earliest.getTime()) / (1000 * 3600);

    let mode: '1d' | '3d' | 'none';
    if (spanHours <= 24) {
        mode = '1d';
    } else if (spanHours <= 72) {
        mode = '3d';
    } else {
        mode = 'none';
    }

    return {
        mode,
        earliestSignalTime: earliest.toISOString(),
        latestSignalTime: latest.toISOString(),
        spanHours: Math.round(spanHours * 10) / 10,
    };
}

// ==================== 飞书消息查询 ====================

/**
 * 补充飞书消息中的股票代码（当 stock_codes 为空时从文本提取）
 * 依赖 loadStockNameMap 已加载（detectHotBurst 中 detectHotStocks 会预加载）
 */
export function enrichFeishuStockCodes(messages: FeishuMessageRow[]): FeishuMessageRow[] {
    return messages.map(msg => {
        if (msg.stock_codes.length > 0) return msg;
        const codes = extractStockCodes(msg.text || '');
        const symbols = Array.from(codes.keys());
        if (symbols.length === 0) return msg;
        return { ...msg, stock_codes: symbols };
    });
}

async function getFeishuMessages(hours: number = 6): Promise<FeishuMessageRow[]> {
    try {
        const result = await pool.query(
            `SELECT id, source, chat_id, chat_name, message_id, message_type, text, stock_codes, keywords, received_at
             FROM feishu_messages
             WHERE received_at > NOW() - INTERVAL '${hours} hours'
             ORDER BY received_at DESC
             LIMIT 200`,
        );
        const rows: FeishuMessageRow[] = result.rows.map((row: any) => ({
            ...row,
            keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords || [],
        }));
        // 回退：当 stock_codes 为空时从文本提取
        return enrichFeishuStockCodes(rows);
    } catch {
        return [];
    }
}

// ==================== 整合服务 ====================

export class HotBurstService {
    /**
     * 执行完整的三步媒体关注榜检测（个股代码驱动）：
     * 1. 个股爆发检测（财联社/格隆汇快讯中提取股票代码）
     * 2. 飞书群消息关联（同只股票是否在群内讨论）
     * 3. 同花顺热榜验证（股票所属板块是否上榜）
     *
     * 关键词退居辅助解释层：附着在共振信号上说明原因
     */
    static async detectHotBurst(): Promise<HotBurstResult> {
        console.log('[HotBurst] 开始三步媒体关注榜检测（个股驱动）...');

        const now = new Date().toISOString();

        // ===== Step 1: 个股爆发检测（代码提取替代关键词匹配） =====
        const hotStocks = await HotKeywordDetectorService.detectHotStocks();
        console.log(`[HotBurst] Step1: 检测到 ${hotStocks.length} 只爆发个股`);

        // ===== Step 1.5: 细分概念爆发检测（共振一：交叉验证） =====
        const hotConcepts = await HotKeywordDetectorService.detectHotConcepts();
        console.log(`[HotBurst] Step1.5: 检测到 ${hotConcepts.length} 个爆发细分概念`);

        // 构建：股票代码 → 匹配到的概念列表
        const stockConceptMap = new Map<string, HotConceptResult>();
        for (const concept of hotConcepts) {
            for (const stock of concept.stockCodes) {
                if (!stockConceptMap.has(stock.symbol)) {
                    stockConceptMap.set(stock.symbol, concept);
                }
            }
        }

        // 对爆发个股，同步匹配关键词作为"原因标签"
        const keywordResults = await HotKeywordDetectorService.detectHotKeywords();

        // 构建：每个股票代码 → 与其相关的关键词列表（通过 articleIds 交叉匹配）
        const stockKeywordsMap = new Map<string, string[]>();
        for (const stock of hotStocks) {
            const stockArticleIds = new Set(stock.articles.map(a => a.id));
            const matchedKws: string[] = [];
            for (const kw of keywordResults) {
                for (const a of kw.articles) {
                    if (stockArticleIds.has(a.id)) {
                        matchedKws.push(kw.keyword);
                        break;
                    }
                }
            }
            stockKeywordsMap.set(stock.symbol, [...new Set(matchedKws)]);
        }

        // ===== Step 2: 飞书群消息关联 =====
        const feishuWindowHours = TradingCalendarService.getFeishuWindowHours();
        console.log(`[HotBurst] 飞书消息查询窗口: ${feishuWindowHours}h`);
        const feishuMessages = await getFeishuMessages(feishuWindowHours);
        console.log(`[HotBurst] Step2: 获取到 ${feishuMessages.length} 条飞书群消息`);

        // 构建：股票代码 → 飞书消息数 + 关键词
        const feishuStockMap = new Map<string, { messageCount: number; keywords: Set<string> }>();
        for (const msg of feishuMessages) {
            for (const code of msg.stock_codes) {
                const existing = feishuStockMap.get(code);
                if (existing) {
                    existing.messageCount++;
                    for (const kw of msg.keywords) existing.keywords.add(kw.keyword);
                } else {
                    const kwSet = new Set<string>();
                    for (const kw of msg.keywords) kwSet.add(kw.keyword);
                    feishuStockMap.set(code, { messageCount: 1, keywords: kwSet });
                }
            }
        }

        // ===== Step 3: 同花顺热榜验证 =====
        const thsHotSectors = await fetchThsHotSectors();
        console.log(`[HotBurst] Step3: 同花顺热榜 ${thsHotSectors.length} 个板块`);

        const thsSectorNameSet = new Set(thsHotSectors.map(s => s.name));
        const thsSectorRankMap = new Map(thsHotSectors.map(s => [s.name, s.rank]));

        // ===== 整合：三个来源按股票代码对齐 =====
        const outbreaks: StockResonanceSignal[] = [];
        let resonanceCount = 0;

        for (const stock of hotStocks) {
            const feishuData = feishuStockMap.get(stock.symbol);
            const feishuMsgCount = feishuData?.messageCount || 0;
            const feishuKws = feishuData ? Array.from(feishuData.keywords) : [];

            // 合并关键词（快讯关键词 + 飞书关键词）
            const allKws = new Set(stockKeywordsMap.get(stock.symbol) || []);
            for (const kw of feishuKws) allKws.add(kw);

            // 同花顺验证：查该股票所属板块是否在热榜
            let thsVerified = false;
            let thsSectorName = '';
            let thsSectorRank = 0;

            const stockSectors = await getStockSector(stock.symbol);
            // 精确匹配
            for (const sector of stockSectors) {
                if (thsSectorNameSet.has(sector)) {
                    thsVerified = true;
                    thsSectorName = sector;
                    thsSectorRank = thsSectorRankMap.get(sector) || 0;
                    break;
                }
            }

            // 模糊匹配：热榜板块名包含在股票板块中或反之
            if (!thsVerified) {
                outer: for (const sector of stockSectors) {
                    for (const thsName of thsSectorNameSet) {
                        if (sector.includes(thsName) || thsName.includes(sector)) {
                            thsVerified = true;
                            thsSectorName = thsName;
                            thsSectorRank = thsSectorRankMap.get(thsName) || 0;
                            break outer;
                        }
                    }
                }
            }

            // 共振评分
            const { score, level } = calculateResonanceScore(
                stock.currentCount, stock.surgeRatio,
                feishuMsgCount,
                thsSectorRank, thsVerified
            );

            // 过滤无共振的低分信号（仅快讯暴增但无飞书讨论且无板块验证的过滤）
            if (level === 'low' && !thsVerified) continue;

            resonanceCount++;

            const stockName = stock.stockName || await getStockName(stock.symbol);

            outbreaks.push({
                symbol: stock.symbol,
                stockName,
                newsCount: stock.currentCount,
                newsSurgeRatio: stock.surgeRatio,
                newsKeywords: Array.from(allKws),
                feishuMessageCount: feishuMsgCount,
                feishuKeywords: feishuKws,
                thsVerified,
                thsSectorName,
                thsSectorRank,
                resonanceScore: score,
                resonanceLevel: level,
                price: null,
                changePct: null,
                sectorInfo: thsSectorName || stockConceptMap.get(stock.symbol)?.conceptName || '',
                conceptResonance: stockConceptMap.has(stock.symbol) ? {
                    conceptName: stockConceptMap.get(stock.symbol)!.conceptName,
                    clsCount: stockConceptMap.get(stock.symbol)!.clsCount,
                    glhCount: stockConceptMap.get(stock.symbol)!.glhCount,
                    conceptVerified: stockConceptMap.get(stock.symbol)!.crossVerified,
                } : null,
                articles: stock.articles,
                detectedAt: stock.detectedAt,
                resonance1: { verified: false, conceptName: '', clsCount: 0, glhCount: 0 },
                resonance2: { verified: false },
                resonance3: { verified: false, reportCount: 0 },
                timeWindow: { mode: 'none' as const, earliestSignalTime: now, latestSignalTime: now, spanHours: 0 },
                effectiveResonanceCount: 0,
            });
        }

        // 按共振评分降序
        outbreaks.sort((a, b) => b.resonanceScore - a.resonanceScore);

        // 补充三重共振状态
        for (const signal of outbreaks) {
            const reports = await findResearchReportMessagesForStock(signal.symbol, 24);
            signal.resonance1 = {
                verified: !!signal.conceptResonance?.conceptVerified,
                conceptName: signal.conceptResonance?.conceptName || '',
                clsCount: signal.conceptResonance?.clsCount || 0,
                glhCount: signal.conceptResonance?.glhCount || 0,
            };
            signal.resonance2 = {
                verified: signal.thsVerified,
                rank: signal.thsSectorRank,
                sectorName: signal.thsSectorName,
            };
            signal.resonance3 = {
                verified: reports.length > 0,
                reportCount: reports.length,
                latestReportTime: reports[0]?.receivedAt,
            };

            // 计算时间窗口
            const tw = calculateTimeWindow(signal);
            signal.timeWindow = tw;

            // 有效共振数量：如果三重共振超出时间窗口，降级为二重
            if (countResonances(signal) >= 3 && tw.mode === 'none') {
                signal.effectiveResonanceCount = 2;
            } else {
                signal.effectiveResonanceCount = countResonances(signal);
            }
        }

        console.log(`[HotBurst] 检测完成: ${outbreaks.length} 个媒体关注信号`);

        // 批量获取股价（并发，限制并发数避免压垮接口）
        const QUOTE_CONCURRENCY = 5;
        for (let i = 0; i < outbreaks.length; i += QUOTE_CONCURRENCY) {
            const batch = outbreaks.slice(i, i + QUOTE_CONCURRENCY);
            await Promise.all(batch.map(async (signal) => {
                try {
                    const quote = await TushareQuoteService.getQuote(signal.symbol, 'core');
                    signal.price = quote['最新价'] ?? null;
                    signal.changePct = quote['涨跌幅'] ?? null;
                } catch (err) {
                    console.warn(`[HotBurst] 获取${signal.symbol}股价失败:`, (err as Error).message);
                }
            }));
        }

        const result: HotBurstResult = {
            update_time: now,
            total_stocks_checked: hotStocks.length,
            resonance_count: resonanceCount,
            triple_resonance_count: outbreaks.filter(s => s.effectiveResonanceCount >= 3).length,
            ths_hot_sectors: thsHotSectors,
            outbreaks,
            hot_concepts: hotConcepts,
        };

        // 更新缓存
        HotBurstService.lastDetectResult = result;
        HotBurstService.lastDetectTime = Date.now();

        // 保存到历史表（不阻塞返回）
        HotBurstService.saveHistory(result).catch(() => {});

        return result;
    }

    /** 将检测结果保存到历史表 */
    static async saveHistory(result: HotBurstResult): Promise<void> {
        // 仅入库有效三重共振信号（effectiveResonanceCount >= 3）
        const tripleResonanceSignals = result.outbreaks.filter(s => s.effectiveResonanceCount >= 3);
        if (!tripleResonanceSignals.length) {
            console.log('[HotBurst] 无有效三重共振信号，跳过历史入库');
            return;
        }
        try {
            const detectedAt = result.update_time;
            const rows = tripleResonanceSignals.map(s => [
                detectedAt, s.symbol, s.stockName || s.symbol,
                s.resonanceScore, s.resonanceLevel,
                s.price, s.changePct, s.sectorInfo,
                [...new Set([...(s.newsKeywords || []), ...(s.feishuKeywords || [])])].join('、'),
                s.newsCount, s.feishuMessageCount, s.thsVerified,
                s.effectiveResonanceCount,
            ]);
            const placeholders = rows.map((_, i) =>
                `($${i * 13 + 1}, $${i * 13 + 2}, $${i * 13 + 3}, $${i * 13 + 4}, $${i * 13 + 5}, $${i * 13 + 6}, $${i * 13 + 7}, $${i * 13 + 8}, $${i * 13 + 9}, $${i * 13 + 10}, $${i * 13 + 11}, $${i * 13 + 12}, $${i * 13 + 13})`
            ).join(', ');
            const values = rows.flat();
            await pool.query(
                `INSERT INTO media_attention_history (detected_at, symbol, stock_name, resonance_score, resonance_level, price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count)
                 VALUES ${placeholders}`,
                values
            );
            console.log(`[HotBurst] 保存 ${rows.length} 条三重共振历史记录（总信号 ${result.outbreaks.length} 条）`);
        } catch (err) {
            console.error('[HotBurst] 保存历史记录失败:', (err as Error).message);
        }
    }

    /**
     * 查询历史媒体关注榜记录
     * @param tripleResonanceOnly 仅返回三重共振（resonance_count >= 3）的记录
     */
    static async getHistory(
        limit: number = 50,
        offset: number = 0,
        tripleResonanceOnly: boolean = true
    ): Promise<{ total: number; records: any[] }> {
        if (tripleResonanceOnly) {
            // 三重共振过滤：仅 resonance_count >= 3
            const countResult = await pool.query(
                `SELECT COUNT(*)::int AS total FROM media_attention_history
                 WHERE resonance_count >= 3`
            );
            const total = countResult.rows[0]?.total || 0;

            const result = await pool.query(
                `SELECT id, detected_at, symbol, stock_name, resonance_score, resonance_level,
                        price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count
                 FROM media_attention_history
                 WHERE resonance_count >= 3
                 ORDER BY detected_at DESC, resonance_score DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            );

            return { total, records: result.rows };
        }

        const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM media_attention_history');
        const total = countResult.rows[0]?.total || 0;

        const result = await pool.query(
            `SELECT id, detected_at, symbol, stock_name, resonance_score, resonance_level,
                    price, change_pct, sector_info, keywords, news_count, feishu_count, ths_verified, resonance_count
             FROM media_attention_history
             ORDER BY detected_at DESC, resonance_score DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        return { total, records: result.rows };
    }

    /** 最近一次检测结果缓存 */
    private static lastDetectResult: HotBurstResult | null = null;
    private static lastDetectTime: number = 0;
    private static readonly DETECT_CACHE_TTL = 6 * 3600 * 1000; // 6小时缓存

    /**
     * 获取最近的媒体关注榜检测结果
     * 优先返回缓存，缓存过期则执行一次检测
     * @param minResonanceCount 最小有效共振数量过滤（0=不过滤）
     */
    static async getRecentBursts(_hours: number = 6, minResonanceCount: number = 0): Promise<HotBurstResult | null> {
        // 如果有缓存且未过期，直接返回
        if (HotBurstService.lastDetectResult && (Date.now() - HotBurstService.lastDetectTime) < HotBurstService.DETECT_CACHE_TTL) {
            if (minResonanceCount > 0) {
                return {
                    ...HotBurstService.lastDetectResult,
                    outbreaks: HotBurstService.lastDetectResult.outbreaks.filter(
                        s => s.effectiveResonanceCount >= minResonanceCount
                    ),
                };
            }
            return HotBurstService.lastDetectResult;
        }
        // 缓存过期或无缓存，执行一次检测
        try {
            const result = await HotBurstService.detectHotBurst();
            HotBurstService.lastDetectResult = result;
            HotBurstService.lastDetectTime = Date.now();
            if (minResonanceCount > 0) {
                return {
                    ...result,
                    outbreaks: result.outbreaks.filter(
                        s => s.effectiveResonanceCount >= minResonanceCount
                    ),
                };
            }
            return result;
        } catch (err) {
            console.error('[HotBurst] getRecentBursts 检测失败，返回旧缓存:', (err as Error).message);
            return HotBurstService.lastDetectResult;
        }
    }
}