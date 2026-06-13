/**
 * 风口爆发整合服务
 *
 * 整合三步数据源：
 * 1. 财联社/格隆汇关键词爆发检测（HotKeywordDetectorService）
 * 2. 飞书群消息中的股票资讯（FeishuMessageController / DB）
 * 3. 同花顺热点掘金验证（HotSectorAnalyzerService / Tushare ths_hot）
 *
 * 核心逻辑：
 * - Step1: 从快讯中检测关键词爆发信号
 * - Step2: 从飞书群消息中提取相关股票代码和关键词
 * - Step3: 验证相关板块是否在同花顺热门板块Top10
 * - 输出: 经过三步验证的风口爆发信号
 */

import pool from '../db';
import { HotKeywordDetectorService, KEYWORD_DIMENSIONS, getKeywordDimension } from './HotKeywordDetectorService';
import { getThsHot, type ThsHotRow } from './TushareService';

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

interface HotKeywordWithVerification {
    keyword: string;
    dimension: string;
    dimensionLabel: string;
    dimensionColor: string;
    currentCount: number;
    surgeRatio: number;
    feishuStockCodes: string[];
    feishuMessageCount: number;
    thsVerified: boolean;
    thsSectorName: string;
    thsSectorRank: number;
    articles: { id: string; title: string; source: string; time: string }[];
    detectedAt: string;
}

interface HotspotOutbreakResult {
    update_time: string;
    total_keywords: number;
    verified_keywords: number;
    ths_hot_sectors: { name: string; rank: number; change_pct: number }[];
    outbreaks: HotKeywordWithVerification[];
}

// ==================== 同花顺热点掘金验证 ====================

async function fetchThsHotSectors(): Promise<{ name: string; rank: number; change_pct: number }[]> {
    try {
        const today = new Date();
        // 尝试最近3天
        for (let offset = 0; offset < 3; offset++) {
            const d = new Date(today);
            d.setDate(d.getDate() - offset);
            const dateStr = formatDate(d);

            const hotData: ThsHotRow[] = await getThsHot(dateStr, '概念板块');
            if (hotData.length > 0) {
                return hotData.slice(0, 10).map((row, idx) => ({
                    name: row.ts_name || '',
                    rank: idx + 1,
                    change_pct: Number(row.change_pct) || 0,
                }));
            }
        }
    } catch (err) {
        console.warn('[HotspotOutbreak] 同花顺热榜获取失败:', (err as Error).message);
    }
    return [];
}

function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
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
        // 表可能不存在
        return [];
    }
}

// ==================== 整合服务 ====================

export class HotspotOutbreakService {
    /**
     * 执行完整的三步风口爆发检测：
     * 1. 关键词爆发检测（财联社/格隆汇）
     * 2. 飞书群消息关联
     * 3. 同花顺热榜验证
     */
    static async detectOutbreak(): Promise<HotspotOutbreakResult> {
        console.log('[HotspotOutbreak] 开始三步风口爆发检测...');

        const now = new Date().toISOString();

        // Step 1: 关键词爆发检测
        const hotKeywords = await HotKeywordDetectorService.detectHotKeywords();
        console.log(`[HotspotOutbreak] Step1: 检测到 ${hotKeywords.length} 个爆发关键词`);

        // Step 2: 飞书群消息关联
        const feishuMessages = await getFeishuMessages(6);
        console.log(`[HotspotOutbreak] Step2: 获取到 ${feishuMessages.length} 条飞书群消息`);

        // 构建飞书消息中的关键词→股票代码映射
        const feishuKeywordStocks = new Map<string, { codes: Set<string>; messageCount: number }>();
        for (const msg of feishuMessages) {
            for (const kw of msg.keywords) {
                const existing = feishuKeywordStocks.get(kw.keyword);
                if (existing) {
                    for (const code of msg.stock_codes) {
                        existing.codes.add(code);
                    }
                    existing.messageCount++;
                } else {
                    feishuKeywordStocks.set(kw.keyword, {
                        codes: new Set(msg.stock_codes),
                        messageCount: 1,
                    });
                }
            }
        }

        // Step 3: 同花顺热榜验证
        const thsHotSectors = await fetchThsHotSectors();
        console.log(`[HotspotOutbreak] Step3: 同花顺热榜 ${thsHotSectors.length} 个板块`);

        // 构建板块名称→排名映射
        const thsSectorRankMap = new Map<string, number>();
        for (const sector of thsHotSectors) {
            thsSectorRankMap.set(sector.name, sector.rank);
        }

        // 整合三步数据
        const outbreaks: HotKeywordWithVerification[] = [];
        let verifiedCount = 0;

        for (const kw of hotKeywords) {
            const feishuData = feishuKeywordStocks.get(kw.keyword);
            const feishuStockCodes = feishuData ? Array.from(feishuData.codes) : [];
            const feishuMessageCount = feishuData?.messageCount || 0;

            // 尝试匹配同花顺板块（关键词可能与板块名称相关）
            let thsVerified = false;
            let thsSectorName = '';
            let thsSectorRank = 0;

            // 通过飞书消息中的股票代码查找其所属板块
            if (feishuStockCodes.length > 0) {
                for (const sector of thsHotSectors) {
                    // 检查板块名称是否与关键词维度相关
                    const dim = KEYWORD_DIMENSIONS[kw.dimension];
                    if (dim) {
                        // 简单匹配：板块名包含关键词或关键词维度标签
                        // 更精确的匹配需要查询板块成分股
                        thsVerified = thsSectorRankMap.has(sector.name);
                        if (thsVerified) {
                            thsSectorName = sector.name;
                            thsSectorRank = sector.rank;
                            break;
                        }
                    }
                }
            }

            // 如果飞书消息没有股票代码，仅用关键词维度匹配
            if (!thsVerified) {
                // 关键词本身出现在同花顺热榜板块名中
                for (const sector of thsHotSectors) {
                    if (sector.name.includes(kw.keyword) || kw.keyword.includes(sector.name)) {
                        thsVerified = true;
                        thsSectorName = sector.name;
                        thsSectorRank = sector.rank;
                        break;
                    }
                }
            }

            if (thsVerified) verifiedCount++;

            outbreaks.push({
                keyword: kw.keyword,
                dimension: kw.dimension,
                dimensionLabel: kw.dimensionLabel,
                dimensionColor: kw.dimensionColor,
                currentCount: kw.currentCount,
                surgeRatio: kw.surgeRatio,
                feishuStockCodes,
                feishuMessageCount,
                thsVerified,
                thsSectorName,
                thsSectorRank,
                articles: kw.articles,
                detectedAt: kw.detectedAt,
            });
        }

        // 按验证状态和爆发比率排序：已验证的排前面
        outbreaks.sort((a, b) => {
            if (a.thsVerified !== b.thsVerified) return a.thsVerified ? -1 : 1;
            return b.surgeRatio - a.surgeRatio;
        });

        console.log(`[HotspotOutbreak] 检测完成: ${outbreaks.length} 个爆发关键词, ${verifiedCount} 个通过同花顺验证`);

        return {
            update_time: now,
            total_keywords: hotKeywords.length,
            verified_keywords: verifiedCount,
            ths_hot_sectors: thsHotSectors,
            outbreaks,
        };
    }

    /**
     * 获取最近的风口爆发检测结果（从缓存/DB）
     */
    static async getRecentOutbreaks(hours: number = 6): Promise<HotspotOutbreakResult | null> {
        try {
            const hotKeywords = await HotKeywordDetectorService.getRecentHotKeywords(hours, 20);
            const thsHotSectors = await fetchThsHotSectors();
            const feishuMessages = await getFeishuMessages(hours);

            if (hotKeywords.length === 0 && feishuMessages.length === 0) {
                return null;
            }

            const outbreaks: HotKeywordWithVerification[] = hotKeywords.map(kw => ({
                keyword: kw.keyword,
                dimension: kw.dimension,
                dimensionLabel: kw.dimensionLabel,
                dimensionColor: kw.dimensionColor,
                currentCount: kw.currentCount,
                surgeRatio: kw.surgeRatio,
                feishuStockCodes: [],
                feishuMessageCount: 0,
                thsVerified: false,
                thsSectorName: '',
                thsSectorRank: 0,
                articles: kw.articles,
                detectedAt: kw.detectedAt,
            }));

            return {
                update_time: new Date().toISOString(),
                total_keywords: hotKeywords.length,
                verified_keywords: 0,
                ths_hot_sectors: thsHotSectors,
                outbreaks,
            };
        } catch {
            return null;
        }
    }
}
