/**
 * 风口关键词爆发检测服务
 *
 * 数据源：
 * 1. 财联社电报 - 实时快讯
 * 2. 格隆汇快讯 - 港股/A股资讯
 *
 * 核心逻辑：
 * - 定时爬取快讯文本
 * - 使用9维度关键词体系匹配
 * - 检测关键词频次异常（爆发信号）
 * - 将爆发关键词推送至后端存储
 */

import * as cheerio from 'cheerio';
import { formatToChinaTime } from '../utils/datetime';
import { cailianpressThrottler } from '../utils/throttlers';
import pool from '../db';

// ==================== 9维度关键词体系 ====================

export const KEYWORD_DIMENSIONS: Record<string, {
    label: string;
    color: string;
    keywords: string[];
}> = {
    supply_demand: {
        label: '供需关系',
        color: '#dc2626',
        keywords: ['缺货', '断供', '无货', '库存告急', '库存见底', '供不应求', '需求旺盛', '订单积压', '排产紧张', '产能满载', '产能利用率', '扩产', '新增产能', '产能瓶颈', '去库存', '库存下降', '低库存', '补库存'],
    },
    order_level: {
        label: '订单级别',
        color: '#ea580c',
        keywords: ['百亿订单', '十亿订单', '重大合同', '战略订单', '十年订单', '长期框架', '长单锁定', '订单爆发', '订单翻倍', '订单激增', '中标', '签约', '大客户', '头部客户', '导入客户', '验证通过'],
    },
    price_change: {
        label: '价格变动',
        color: '#ca8a04',
        keywords: ['涨价', '提价', '调价', '价格上调', '价格高位', '持续上涨', '价格创新高', '降价', '价格战', '价格下行'],
    },
    tech_breakthrough: {
        label: '技术突破',
        color: '#7c3aed',
        keywords: ['量产', '规模化', '批产', '小批量产', '独家', '独家供应', '唯一', '独家合作', '首发', '率先', '首发产品', '首发认证', '通过验证', '客户认证', '验厂通过', '导入阶段'],
    },
    policy_catalyst: {
        label: '政策催化',
        color: '#0891b2',
        keywords: ['政策利好', '补贴', '纳入目录', '国家战略', '获批'],
    },
    earnings_verify: {
        label: '业绩验证',
        color: '#059669',
        keywords: ['业绩超预期', '净利翻倍', '扭亏', '预告增长'],
    },
    industry_cycle: {
        label: '行业景气',
        color: '#4f46e5',
        keywords: ['景气度上行', '行业拐点', '周期反转'],
    },
    capital_action: {
        label: '股权/资本',
        color: '#9333ea',
        keywords: ['回购', '增持', '定增', '员工持股', '机构调研'],
    },
    risk_signal: {
        label: '风险信号',
        color: '#64748b',
        keywords: ['减持', '商誉减值', '诉讼', '被调查', '退市风险'],
    },
};

/** 关键词→维度映射 */
const keywordToDimension: Map<string, string> = new Map();
for (const [dimKey, dim] of Object.entries(KEYWORD_DIMENSIONS)) {
    for (const kw of dim.keywords) {
        keywordToDimension.set(kw, dimKey);
    }
}

/** 获取关键词所属维度 */
export function getKeywordDimension(keyword: string): { key: string; label: string; color: string } | null {
    const dimKey = keywordToDimension.get(keyword);
    if (!dimKey) return null;
    const dim = KEYWORD_DIMENSIONS[dimKey];
    return { key: dimKey, label: dim.label, color: dim.color };
}

// ==================== 财联社电报爬取 ====================

const CLS_TELEGRAPH_URL = 'https://www.cls.cn/api/csw?app=CailianpressWeb&os=web&sv=8.4.6&sign=9f8797a1f4de66c2370f7a03990d2737';
const CLS_HEADERS: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'https://www.cls.cn',
    'Referer': 'https://www.cls.cn/telegraph',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

interface TelegraphItem {
    id: string;
    title: string;
    content: string;
    time: string;
    timestamp: number;
}

async function fetchClsTelegraph(lastTime: number = 0, limit: number = 100): Promise<TelegraphItem[]> {
    const payload = {
        lastTime,
        keyword: '',
        category: '',
        os: 'web',
        sv: '8.4.6',
        app: 'CailianpressWeb',
    };

    await cailianpressThrottler.throttle();

    const response = await fetch(CLS_TELEGRAPH_URL, {
        method: 'POST',
        headers: CLS_HEADERS,
        body: JSON.stringify(payload),
    });

    if (!response.ok) throw new Error(`财联社电报请求失败: ${response.status}`);

    let rawData: any = null;
    try { rawData = await response.json(); } catch { return []; }
    if (typeof rawData?.errno === 'number' && rawData.errno !== 0) return [];

    const entries = rawData?.data?.list || rawData?.list || [];
    const items: TelegraphItem[] = [];

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const ctime = Number(entry.ctime) || 0;
        if (ctime <= lastTime) continue;

        const $ = cheerio.load(entry.content || '');
        const title = (entry.title || '').trim() || ($.text() || '').trim().slice(0, 100);
        const content = ($.text() || '').trim();

        items.push({
            id: String(entry.id || ''),
            title: title.replace(/^【[^】]*】/, '').trim(),
            content: content.replace(/^【[^】]*】/, '').trim(),
            time: formatToChinaTime(ctime < 1e12 ? ctime * 1000 : ctime),
            timestamp: ctime,
        });

        if (items.length >= limit) break;
    }

    return items;
}

// ==================== 格隆汇快讯爬取 ====================

const GELONGHUI_URL = 'https://www.gelonghui.com/api/live/v3/live/list';
const GELONGHUI_HEADERS: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'https://www.gelonghui.com',
    'Referer': 'https://www.gelonghui.com/live',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

async function fetchGelonghuiNews(limit: number = 50): Promise<TelegraphItem[]> {
    try {
        const response = await fetch(`${GELONGHUI_URL}?count=${limit}`, {
            method: 'GET',
            headers: GELONGHUI_HEADERS,
        });

        if (!response.ok) return [];

        const rawData: any = await response.json();
        const entries = rawData?.data?.list || rawData?.data || [];
        const items: TelegraphItem[] = [];

        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const text = (entry.title || entry.content || entry.text || '').trim();
            if (!text) continue;

            const ts = entry.created_at || entry.timestamp || 0;
            const tsNumber = Number(ts);

            items.push({
                id: String(entry.id || entry.sn || ''),
                title: text.slice(0, 100),
                content: text,
                time: tsNumber ? formatToChinaTime(tsNumber < 1e12 ? tsNumber * 1000 : tsNumber) : '',
                timestamp: tsNumber,
            });
        }

        return items;
    } catch (err) {
        console.warn('[HotKeywordDetector] 格隆汇快讯获取失败:', (err as Error).message);
        return [];
    }
}

// ==================== 关键词匹配与爆发检测 ====================

interface KeywordMatch {
    keyword: string;
    dimension: string;
    dimensionLabel: string;
    count: number;
    articles: { id: string; title: string; source: string }[];
}

interface HotKeywordResult {
    keyword: string;
    dimension: string;
    dimensionLabel: string;
    dimensionColor: string;
    currentCount: number;
    previousCount: number;
    surgeRatio: number;
    articles: { id: string; title: string; source: string; time: string }[];
    detectedAt: string;
}

/** 从文本中匹配关键词 */
function matchKeywords(text: string): Map<string, { dimension: string; dimensionLabel: string }> {
    const matched = new Map<string, { dimension: string; dimensionLabel: string }>();
    for (const [kw, dimKey] of keywordToDimension.entries()) {
        if (text.includes(kw)) {
            const dim = KEYWORD_DIMENSIONS[dimKey];
            matched.set(kw, { dimension: dimKey, dimensionLabel: dim.label });
        }
    }
    return matched;
}

/** 分析一批快讯，返回关键词匹配统计 */
function analyzeArticles(articles: TelegraphItem[], source: string): Map<string, KeywordMatch> {
    const keywordMap = new Map<string, KeywordMatch>();

    for (const article of articles) {
        const text = `${article.title} ${article.content}`;
        const matched = matchKeywords(text);

        for (const [kw, dimInfo] of matched.entries()) {
            const existing = keywordMap.get(kw);
            if (existing) {
                existing.count++;
                existing.articles.push({ id: article.id, title: article.title, source });
            } else {
                keywordMap.set(kw, {
                    keyword: kw,
                    dimension: dimInfo.dimension,
                    dimensionLabel: dimInfo.dimensionLabel,
                    count: 1,
                    articles: [{ id: article.id, title: article.title, source }],
                });
            }
        }
    }

    return keywordMap;
}

// ==================== DB 持久化 ====================

async function ensureSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS hot_keyword_snapshots (
            id SERIAL PRIMARY KEY,
            snapshot_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            keyword TEXT NOT NULL,
            dimension TEXT NOT NULL,
            dimension_label TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '',
            article_count INT NOT NULL DEFAULT 0,
            article_ids TEXT[] DEFAULT '{}',
            article_titles TEXT[] DEFAULT '{}',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_hks_keyword ON hot_keyword_snapshots(keyword);
        CREATE INDEX IF NOT EXISTS idx_hks_snapshot_time ON hot_keyword_snapshots(snapshot_time);
        CREATE INDEX IF NOT EXISTS idx_hks_dimension ON hot_keyword_snapshots(dimension);
    `);
}

/** 保存关键词快照 */
async function saveSnapshot(keywordMatches: Map<string, KeywordMatch>, source: string): Promise<void> {
    await ensureSchema();

    const now = new Date().toISOString();
    for (const [, match] of keywordMatches.entries()) {
        await pool.query(
            `INSERT INTO hot_keyword_snapshots (snapshot_time, keyword, dimension, dimension_label, source, article_count, article_ids, article_titles)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                now,
                match.keyword,
                match.dimension,
                match.dimensionLabel,
                source,
                match.count,
                match.articles.map(a => a.id),
                match.articles.map(a => a.title),
            ],
        );
    }
}

/** 获取关键词历史频次（最近N小时） */
async function getKeywordHistory(keyword: string, hours: number = 2): Promise<{ snapshot_time: string; article_count: number }[]> {
    const result = await pool.query(
        `SELECT snapshot_time, article_count
         FROM hot_keyword_snapshots
         WHERE keyword = $1 AND snapshot_time > NOW() - INTERVAL '${hours} hours'
         ORDER BY snapshot_time ASC`,
        [keyword],
    );
    return result.rows;
}

// ==================== 爆发检测核心 ====================

export class HotKeywordDetectorService {
    /**
     * 执行一次完整的爆发检测流程：
     * 1. 爬取财联社电报 + 格隆汇快讯
     * 2. 匹配8维度关键词
     * 3. 与历史频次对比，检测爆发信号
     * 4. 返回爆发关键词列表
     */
    static async detectHotKeywords(): Promise<HotKeywordResult[]> {
        console.log('[HotKeywordDetector] 开始关键词爆发检测...');

        // 1. 爬取快讯
        const [clsArticles, glhArticles] = await Promise.all([
            fetchClsTelegraph(0, 100).catch(err => {
                console.warn('[HotKeywordDetector] 财联社电报获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
            fetchGelonghuiNews(50).catch(err => {
                console.warn('[HotKeywordDetector] 格隆汇快讯获取失败:', err.message);
                return [] as TelegraphItem[];
            }),
        ]);

        console.log(`[HotKeywordDetector] 获取快讯: 财联社=${clsArticles.length}, 格隆汇=${glhArticles.length}`);

        // 2. 匹配关键词
        const clsMatches = analyzeArticles(clsArticles, '财联社');
        const glhMatches = analyzeArticles(glhArticles, '格隆汇');

        // 合并匹配结果
        const allMatches = new Map<string, KeywordMatch>();
        for (const [kw, match] of clsMatches.entries()) {
            allMatches.set(kw, { ...match });
        }
        for (const [kw, match] of glhMatches.entries()) {
            const existing = allMatches.get(kw);
            if (existing) {
                existing.count += match.count;
                existing.articles.push(...match.articles);
            } else {
                allMatches.set(kw, { ...match });
            }
        }

        // 3. 保存快照
        await saveSnapshot(clsMatches, '财联社');
        await saveSnapshot(glhMatches, '格隆汇');

        // 4. 爆发检测：与历史对比
        const hotKeywords: HotKeywordResult[] = [];
        const now = new Date().toISOString();

        for (const [kw, match] of allMatches.entries()) {
            // 跳过只出现1次的关键词（噪声过滤）
            if (match.count < 2) continue;

            const dim = KEYWORD_DIMENSIONS[match.dimension];
            const history = await getKeywordHistory(kw, 2);

            // 计算历史平均频次
            let previousCount = 0;
            if (history.length > 1) {
                // 排除最新快照，计算之前的平均
                const previousSnapshots = history.slice(0, -1);
                previousCount = previousSnapshots.reduce((sum, h) => sum + h.article_count, 0);
            }

            // 爆发比率：当前频次 / 历史平均频次
            let surgeRatio = 0;
            if (previousCount > 0) {
                surgeRatio = match.count / previousCount;
            } else {
                // 无历史数据时，频次>=3即视为爆发
                surgeRatio = match.count >= 3 ? 3 : 0;
            }

            // 爆发阈值：频次是历史的2倍以上，或首次出现且频次>=3
            if (surgeRatio >= 2 || (previousCount === 0 && match.count >= 3)) {
                hotKeywords.push({
                    keyword: kw,
                    dimension: match.dimension,
                    dimensionLabel: match.dimensionLabel,
                    dimensionColor: dim?.color || '#64748b',
                    currentCount: match.count,
                    previousCount,
                    surgeRatio: Math.round(surgeRatio * 100) / 100,
                    articles: match.articles.slice(0, 5).map(a => ({
                        id: a.id,
                        title: a.title,
                        source: a.source,
                        time: '',
                    })),
                    detectedAt: now,
                });
            }
        }

        // 按爆发比率降序排序
        hotKeywords.sort((a, b) => b.surgeRatio - a.surgeRatio);

        console.log(`[HotKeywordDetector] 检测到 ${hotKeywords.length} 个爆发关键词`);
        return hotKeywords;
    }

    /**
     * 获取最近爆发关键词（从DB查询）
     */
    static async getRecentHotKeywords(hours: number = 6, limit: number = 20): Promise<HotKeywordResult[]> {
        await ensureSchema();

        const result = await pool.query(
            `SELECT keyword, dimension, dimension_label, article_count, snapshot_time,
                    array_length(article_ids, 1) as article_total
             FROM hot_keyword_snapshots
             WHERE snapshot_time > NOW() - INTERVAL '${hours} hours'
             GROUP BY keyword, dimension, dimension_label, article_count, snapshot_time
             ORDER BY article_count DESC
             LIMIT $1`,
            [limit],
        );

        return result.rows.map((row: any) => {
            const dim = KEYWORD_DIMENSIONS[row.dimension];
            return {
                keyword: row.keyword,
                dimension: row.dimension,
                dimensionLabel: row.dimension_label || dim?.label || '',
                dimensionColor: dim?.color || '#64748b',
                currentCount: row.article_count,
                previousCount: 0,
                surgeRatio: 0,
                articles: [],
                detectedAt: row.snapshot_time,
            };
        });
    }
}
