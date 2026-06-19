/**
 * 热点爆发整合服务
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

// ==================== 类型定义 ====================

interface FeishuMessageRow {
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
}

interface HotBurstResult {
    update_time: string;
    total_stocks_checked: number;
    resonance_count: number;
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

// ==================== 飞书消息查询 ====================

async function getFeishuMessages(hours: number = 6): Promise<FeishuMessageRow[]> {
    try {
        const result = await pool.query(
            `SELECT id, source, chat_id, chat_name, message_id, message_type, text, stock_codes, keywords, received_at
             FROM feishu_messages
             WHERE received_at > NOW() - INTERVAL '${hours} hours'
             ORDER BY received_at DESC
             LIMIT 200`,
        );
        return result.rows.map((row: any) => ({
            ...row,
            keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords || [],
        }));
    } catch {
        return [];
    }
}

// ==================== 整合服务 ====================

export class HotBurstService {
    /**
     * 执行完整的三步热点爆发检测（个股代码驱动）：
     * 1. 个股爆发检测（财联社/格隆汇快讯中提取股票代码）
     * 2. 飞书群消息关联（同只股票是否在群内讨论）
     * 3. 同花顺热榜验证（股票所属板块是否上榜）
     *
     * 关键词退居辅助解释层：附着在共振信号上说明原因
     */
    static async detectHotBurst(): Promise<HotBurstResult> {
        console.log('[HotBurst] 开始三步热点爆发检测（个股驱动）...');

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
        const feishuMessages = await getFeishuMessages(6);
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
        }

        console.log(`[HotBurst] 检测完成: ${outbreaks.length} 个共振信号`);

        return {
            update_time: now,
            total_stocks_checked: hotStocks.length,
            resonance_count: resonanceCount,
            ths_hot_sectors: thsHotSectors,
            outbreaks,
            hot_concepts: hotConcepts,
        };
    }

    /**
     * 获取最近的热点爆发检测结果
     * 短期方案：返回 null 让前端调用 detectHotBurst 获取最新数据
     */
    static async getRecentBursts(_hours: number = 6): Promise<HotBurstResult | null> {
        return null;
    }
}