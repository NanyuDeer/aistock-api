/**
 * 风口爆发股 - 核心分析引擎（TypeScript 版本）
 *
 * 使用同花顺 API + Tushare 数据源
 *
 * 核心逻辑：
 * 1. 从同花顺概念板块中筛选风口板块（十日上榜频次 + 资金流入）
 * 2. 根据概念板块成分股，判断强关联的二级行业
 * 3. 展开强关联二级行业的上下游二级行业
 * 4. 在二级行业中筛选股票（多因子：涨幅+资金+量比+市值+连续上涨）
 */

import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import { EmQuoteService } from './EmQuoteService';
import { thsThrottler } from '../utils/throttlers';
import {
    tushareRequest,
    getMoneyflowByDate,
    getDailyBasicByDate,
    getStockDailyRecent,
    getThsIndex,
    getThsDaily,
    getThsMember,
    type MoneyflowRow,
    type DailyBasicFullRow,
    type DailyPriceRow,
    type ThsIndexRow,
    type ThsDailyRow,
    type ThsMemberRow,
} from './TushareService';

// ==================== 缓存 ====================
const CACHE_DIR = path.resolve(__dirname, '../../data/hot-sector-cache');
const CACHE_TTL = 3600 * 1000; // 缓存1小时

/** Tushare概念/行业指数 名称→ts_code 映射缓存 */
let thsIndexNameMap: Map<string, string> | null = null;

async function getThsIndexNameMap(): Promise<Map<string, string>> {
    if (thsIndexNameMap) return thsIndexNameMap;
    const map = new Map<string, string>();
    try {
        // 概念指数
        const conceptIndices = await getThsIndex('N', 'A');
        for (const idx of conceptIndices) {
            map.set(idx.name, idx.ts_code);
        }
        // 行业指数
        const industryIndices = await getThsIndex('I', 'A');
        for (const idx of industryIndices) {
            map.set(idx.name, idx.ts_code);
        }
        console.log(`[HotSectorAnalyzer] Tushare指数映射构建完成: ${map.size}个`);
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare指数映射构建失败:', err);
    }
    thsIndexNameMap = map;
    return map;
}

function ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function cacheGet(key: string): any | null {
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${key}.json`);
        if (!fs.existsSync(fp)) return null;
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > CACHE_TTL) return null;
        const raw = fs.readFileSync(fp, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function cacheSet(key: string, data: any): void {
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, `${key}.json`);
        fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        console.warn('[HotSectorAnalyzer] 缓存写入失败:', err);
    }
}

// ==================== 同花顺板块数据 ====================

const THS_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.10jqka.com.cn/',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/** 同花顺HTML页面请求（GBK解码）
 *  注意：Node.js的fetch会自动解压gzip，arrayBuffer返回的是已解压的GBK原始字节
 */
async function fetchThsHtml(url: string): Promise<string> {
    await thsThrottler.throttle();
    const response = await fetch(url, { headers: THS_HEADERS });
    if (!response.ok) throw new Error(`同花顺请求失败: HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    // Node.js fetch已自动解压gzip，直接GBK解码
    return new TextDecoder('gbk').decode(buffer);
}

/** 同花顺JSON API请求 */
async function fetchThsJson(url: string): Promise<any> {
    await thsThrottler.throttle();
    const response = await fetch(url, { headers: THS_HEADERS });
    if (!response.ok) throw new Error(`同花顺API请求失败: HTTP ${response.status}`);
    return response.json();
}

/** 获取同花顺概念板块列表（从概念页面隐藏的#gnSection元素提取） */
async function getConceptBoards(): Promise<any[]> {
    const cacheKey = 'ths_concept_boards';
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const html = await fetchThsHtml('https://q.10jqka.com.cn/gn/');
        const $ = cheerio.load(html);

        // 从页面隐藏的#gnSection输入框提取概念板块数据
        const gnSectionVal = $('#gnSection').val() as string;
        if (gnSectionVal) {
            const data = new Function('return (' + gnSectionVal + ')')() as Record<string, any>;
            const result = Object.values(data).map((item: any) => ({
                code: String(item.cid || ''),
                name: item.platename || '',
                change: parseFloat(item[199112]) || 0,  // 涨跌幅
                price: 0,
                up_count: parseInt(item.zfl) || 0,       // 涨幅家数
                down_count: 0,
                net_inflow: (parseFloat(item.zjjlr) || 0) * 100000000, // 亿元→元
            })).filter((item: any) => item.code && item.name);

            if (result.length > 0) {
                console.log(`[HotSectorAnalyzer] 同花顺概念板块获取成功: ${result.length}个`);
                cacheSet(cacheKey, result);
                saveDailySnapshot('concept', result);
                return result;
            }
        }

        // Fallback: 从概念链接提取（无涨幅数据）
        const result: any[] = [];
        const seen = new Set<string>();
        $('a[href*="/gn/detail/code/"]').each((i, el) => {
            const name = $(el).text().trim();
            const href = $(el).attr('href') || '';
            const code = href.match(/code\/(\d+)/)?.[1] || '';
            if (name && code && !seen.has(code)) {
                seen.add(code);
                result.push({
                    code,
                    name,
                    change: 0,
                    price: 0,
                    up_count: 0,
                    down_count: 0,
                    net_inflow: 0,
                });
            }
        });

        if (result.length > 0) {
            console.log(`[HotSectorAnalyzer] 同花顺概念板块链接提取成功: ${result.length}个（无涨幅数据）`);
            cacheSet(cacheKey, result);
            saveDailySnapshot('concept', result);
            return result;
        }
    } catch (err) {
        console.error('[HotSectorAnalyzer] 同花顺概念板块获取失败:', err);
    }

    return [];
}

/** 获取同花顺行业板块列表 */
async function getIndustryBoards(): Promise<any[]> {
    const cacheKey = 'ths_industry_boards';
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const html = await fetchThsHtml('https://q.10jqka.com.cn/thshy/');
        const $ = cheerio.load(html);

        const industries: any[] = [];
        $('table tbody tr').each((i, el) => {
            const cells = $(el).find('td');
            if (cells.length < 8) return;

            const nameEl = cells.eq(1).find('a');
            const name = nameEl.text().trim();
            const href = nameEl.attr('href') || '';
            const code = href.match(/code\/(\d+)/)?.[1] || '';
            const change = parseFloat(cells.eq(2).text().trim()) || 0;
            const netInflow = parseFloat(cells.eq(5).text().trim()) || 0;
            const upCount = parseInt(cells.eq(6).text().trim()) || 0;
            const downCount = parseInt(cells.eq(7).text().trim()) || 0;
            const leadingStock = cells.eq(9).find('a').text().trim() || '';

            if (name && code) {
                industries.push({
                    code,
                    name,
                    change,
                    price: 0,
                    up_count: upCount,
                    down_count: downCount,
                    net_inflow: netInflow * 100000000, // 亿元→元
                    leading_stock: leadingStock,
                });
            }
        });

        console.log(`[HotSectorAnalyzer] 同花顺行业板块获取成功: ${industries.length}个`);
        cacheSet(cacheKey, industries);
        return industries;
    } catch (err) {
        console.error('[HotSectorAnalyzer] 同花顺行业板块列表获取失败:', err);
        return [];
    }
}

/** 保存每日板块数据快照（用于历史回溯） */
function saveDailySnapshot(type: 'concept' | 'industry', data: any[]): void {
    try {
        ensureCacheDir();
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const fp = path.join(CACHE_DIR, `snapshot_${type}_${today}.json`);
        if (!fs.existsSync(fp)) {
            fs.writeFileSync(fp, JSON.stringify(data), 'utf-8');
        }
    } catch { /* ignore */ }
}

/** 获取板块历史数据（通过Tushare ths_daily） */
async function getBoardHistory(boardName: string, days: number = 10): Promise<any[]> {
    const cacheKey = `board_history_${boardName}_${days}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const nameMap = await getThsIndexNameMap();
    const tsCode = nameMap.get(boardName);
    if (!tsCode) return [];

    try {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days * 2);
        const startDateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');

        const hist = await getThsDaily(tsCode, startDateStr);
        const result = hist
            .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
            .slice(-days)
            .map(h => ({
                date: String(h.trade_date),
                open: Number(h.open) || 0,
                close: Number(h.close) || 0,
                high: Number(h.high) || 0,
                low: Number(h.low) || 0,
                volume: Number(h.vol) || 0,
                amount: Number(h.vol) || 0, // ths_daily无成交额，用成交量近似
                change_pct: Number(h.pct_change) || 0,
            }));

        if (result.length > 0) {
            cacheSet(cacheKey, result);
        }
        return result;
    } catch (err) {
        console.warn(`[HotSectorAnalyzer] getBoardHistory失败(${boardName}):`, (err as Error).message);
        return [];
    }
}

/** 获取板块成分股（概念板块和行业板块均使用HTML解析） */
async function getBoardConstituents(boardCode: string, boardType: 'concept' | 'industry' = 'concept', pageSize: number = 100): Promise<any[]> {
    const cacheKey = `board_cons_${boardType}_${boardCode}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    if (boardType === 'concept') {
        // 概念板块: 使用 /index/index/board/all/ 接口（按涨跌幅排序的成分股列表）
        try {
            const result = await parseConceptConstituents(boardCode, pageSize);
            if (result.length > 0) {
                cacheSet(cacheKey, result);
                return result;
            }
        } catch (err) {
            console.warn(`[HotSectorAnalyzer] 概念${boardCode}成分股获取失败:`, (err as Error).message);
        }
        return [];
    } else {
        // 行业板块: HTML解析行业详情页
        try {
            const result = await parseIndustryConstituents(boardCode, pageSize);
            if (result.length > 0) {
                cacheSet(cacheKey, result);
            }
            return result;
        } catch (err) {
            console.warn(`[HotSectorAnalyzer] 行业${boardCode}成分股HTML解析失败:`, (err as Error).message);
            return [];
        }
    }
}

/** 解析概念板块成分股（使用同花顺board/all接口） */
async function parseConceptConstituents(boardCode: string, pageSize: number): Promise<any[]> {
    const result: any[] = [];
    const maxPages = Math.ceil(pageSize / 20);

    for (let page = 1; page <= maxPages; page++) {
        const url = `https://q.10jqka.com.cn/index/index/board/all/field/zdf/order/desc/page/${page}/ajax/1/code/${boardCode}`;
        const html = await fetchThsHtml(url);
        const $ = cheerio.load(html);

        let found = 0;
        $('table tbody tr').each((i, el) => {
            const cells = $(el).find('td');
            if (cells.length < 5) return;

            const code = cells.eq(1).text().trim();
            const name = cells.eq(2).find('a').text().trim() || cells.eq(2).text().trim();
            const price = parseFloat(cells.eq(3).text().trim()) || 0;
            const changePct = parseFloat(cells.eq(4).text().trim()) || 0;

            if (code && name && /^\d{6}$/.test(code)) {
                result.push({
                    code,
                    name,
                    price,
                    change_pct: changePct,
                    industry: '',
                });
                found++;
            }
        });

        if (found === 0) break;
    }

    console.log(`[HotSectorAnalyzer] 概念${boardCode}成分股获取: ${result.length}只`);
    return result;
}

/** 解析行业板块成分股（使用同花顺行业详情页） */
async function parseIndustryConstituents(boardCode: string, pageSize: number): Promise<any[]> {
    const result: any[] = [];
    const maxPages = Math.ceil(pageSize / 20);

    for (let page = 1; page <= maxPages; page++) {
        const url = page > 1
            ? `https://q.10jqka.com.cn/thshy/detail/code/${boardCode}/page/${page}/`
            : `https://q.10jqka.com.cn/thshy/detail/code/${boardCode}/`;
        const html = await fetchThsHtml(url);
        const $ = cheerio.load(html);

        let found = 0;
        $('table tbody tr').each((i, el) => {
            const cells = $(el).find('td');
            if (cells.length < 5) return;

            const code = cells.eq(1).text().trim();
            const name = cells.eq(2).find('a').text().trim() || cells.eq(2).text().trim();
            const price = parseFloat(cells.eq(3).text().trim()) || 0;
            const changePct = parseFloat(cells.eq(4).text().trim()) || 0;

            if (code && name && /^\d{6}$/.test(code)) {
                result.push({
                    code,
                    name,
                    price,
                    change_pct: changePct,
                    industry: '',
                });
                found++;
            }
        });

        if (found === 0) break;
    }

    console.log(`[HotSectorAnalyzer] 行业${boardCode}成分股获取: ${result.length}只`);
    return result;
}

/** 获取板块涨幅排名前N的股票 */
async function getBoardTopStocks(boardCode: string, topN: number = 5, boardType: 'concept' | 'industry' = 'concept'): Promise<any[]> {
    const cacheKey = `board_top_${boardType}_${boardCode}_${topN}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // 按指定类型获取成分股（已按涨幅排序）
    const stocks = await getBoardConstituents(boardCode, boardType, topN);

    const result = stocks.slice(0, topN).map(s => ({
        code: s.code,
        name: s.name,
        price: s.price,
        change_pct: s.change_pct,
        industry: s.industry || '',
        net_inflow: 0,
        turnover_rate: 0,
    }));

    if (result.length > 0) {
        cacheSet(cacheKey, result);
    }
    return result;
}

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ==================== 风口概念板块识别 ====================

interface HotConcept {
    code: string;
    name: string;
    type: string;
    frequency: number;
    avg_change: number;
    today_change: number;
    amount_trend: number;
    net_inflow: number;  // 板块主力净流入（万元，来自东方财富）
    driver: string;
    leading_stock: string;
    leading_change: number;
    up_count: number;
    down_count: number;
    score: number;
}

async function identifyHotConcepts(topN: number = 8, minFrequency: number = 3, days: number = 10): Promise<HotConcept[]> {
    const cacheKey = `hot_concepts_${days}_${minFrequency}_${topN}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log('[HotSectorAnalyzer] 使用缓存的风口概念数据');
        return cached;
    }

    // 获取概念板块列表（同花顺HTML）
    const concepts = await getConceptBoards();
    if (concepts.length === 0) return [];

    // 获取Tushare概念指数 名称→ts_code 映射
    const thsIndexMap = await getThsIndexNameMap();

    // 取涨幅最高的前30个概念
    const topConcepts = concepts
        .sort((a, b) => Math.abs(b.change || 0) - Math.abs(a.change || 0))
        .slice(0, 30);

    const candidates: HotConcept[] = [];
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days * 2);
    const startDateStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');

    for (const concept of topConcepts) {
        const todayChange = concept.change || 0;

        let upDays = 0;
        let avgChange = todayChange;
        let amountTrend = 0;

        // 通过Tushare ths_daily获取历史行情
        const tsCode = thsIndexMap.get(concept.name);
        if (tsCode) {
            try {
                const hist = await getThsDaily(tsCode, startDateStr);
                if (hist.length >= 3) {
                    // 取最近days个交易日
                    const recentHist = hist
                        .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)))
                        .slice(-days);

                    // 上榜频次：涨幅>1%的天数
                    upDays = recentHist.filter(h => Math.abs(Number(h.pct_change)) > 1.0).length;
                    avgChange = recentHist.reduce((sum, h) => sum + Number(h.pct_change), 0) / recentHist.length;

                    // 资金趋势：近5日成交量均值 vs 前5日
                    if (recentHist.length >= 5) {
                        const recentVol = recentHist.slice(-5).reduce((s, h) => s + Number(h.vol), 0) / 5;
                        const earlyVol = recentHist.slice(0, 5).reduce((s, h) => s + Number(h.vol), 0) / 5;
                        amountTrend = earlyVol > 0 ? (recentVol / earlyVol - 1) * 100 : 0;
                    }
                } else if (hist.length > 0) {
                    upDays = hist.filter(h => Math.abs(Number(h.pct_change)) > 1.0).length;
                    avgChange = hist.reduce((sum, h) => sum + Number(h.pct_change), 0) / hist.length;
                }
            } catch (err) {
                console.warn(`[HotSectorAnalyzer] Tushare ths_daily获取失败(${concept.name}):`, (err as Error).message);
            }
        }

        // 如果Tushare未获取到历史数据，使用当天数据
        if (upDays === 0 && todayChange > 1.0) {
            upDays = 1;
        }

        // 板块主力净流入
        const netInflow = concept.net_inflow || 0;

        candidates.push({
            code: concept.code,
            name: concept.name,
            type: 'concept',
            frequency: upDays,
            avg_change: Math.round(avgChange * 100) / 100,
            today_change: Math.round(todayChange * 100) / 100,
            amount_trend: Math.round(amountTrend * 100) / 100,
            net_inflow: netInflow,
            driver: '',
            leading_stock: '--',
            leading_change: 0,
            up_count: concept.up_count || 0,
            down_count: concept.down_count || 0,
            score: 0,
        });
    }

    // 筛选上榜频次 >= minFrequency
    let hotConcepts = candidates.filter(c => c.frequency >= minFrequency);

    // 如果筛选后太少，降低条件
    if (hotConcepts.length < topN) {
        hotConcepts = candidates.filter(c => c.frequency >= Math.max(1, minFrequency - 1));
    }

    // 如果仍然太少，直接用当天涨幅排序取topN
    if (hotConcepts.length < topN) {
        hotConcepts = candidates
            .sort((a, b) => Math.abs(b.today_change) - Math.abs(a.today_change))
            .slice(0, topN);
    }

    // 综合评分：频次35% + 平均涨幅25% + 资金趋势15% + 主力净流入25%
    for (const s of hotConcepts) {
        const inflowScore = Math.min(10, Math.abs(s.net_inflow) / 100000000 * 2);
        s.score = Math.round((s.frequency * 3.5 + s.avg_change * 2.5 + s.amount_trend * 0.15 + inflowScore * 2.5) * 100) / 100;
    }

    hotConcepts.sort((a, b) => b.score - a.score);
    const result = hotConcepts.slice(0, topN);

    // 筛选后再获取领涨股（减少请求量）
    for (const concept of result) {
        try {
            const topStocks = await getBoardTopStocks(concept.code, 1);
            concept.leading_stock = topStocks.length > 0 ? topStocks[0].name : '--';
            concept.leading_change = topStocks.length > 0 ? Math.round((topStocks[0].change_pct || 0) * 100) / 100 : 0;
        } catch { /* ignore */ }
    }

    cacheSet(cacheKey, result);
    return result;
}

// ==================== 概念→行业映射 ====================

interface IndustryMapping {
    name: string;
    code: string;
    overlap_count: number;
    overlap_ratio: number;
    stock_count: number;
    overlap_codes: string[];
}

async function mapConceptToIndustries(conceptCode: string, conceptName: string, topN: number = 3): Promise<IndustryMapping[]> {
    const cacheKey = `concept_industry_map_${conceptName}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    // 获取概念成分股
    const conceptCons = await getBoardConstituents(conceptCode, 'concept', 200);
    if (conceptCons.length === 0) {
        console.log(`[HotSectorAnalyzer] 概念 ${conceptName} 成分股获取失败，使用排名接口映射`);
        const result = await mapByRankingIndustry(conceptName, topN);
        cacheSet(cacheKey, result);
        return result;
    }

    const conceptCodes = new Set(conceptCons.map(s => s.code));
    console.log(`[HotSectorAnalyzer] 概念 ${conceptName} 成分股: ${conceptCodes.size} 只`);

    // 获取行业板块列表
    const industries = await getIndustryBoards();

    // 并发获取所有行业成分股（约50个行业，5个一批并发）
    const industryOverlaps: IndustryMapping[] = [];
    const batchSize = 5;

    for (let i = 0; i < industries.length; i += batchSize) {
        const batch = industries.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async (ind) => {
            const indCons = await getBoardConstituents(ind.code, 'industry', 200);
            if (indCons.length === 0) return null;

            const indCodes = new Set(indCons.map(s => s.code));
            const overlap = [...conceptCodes].filter(c => indCodes.has(c));
            const overlapCount = overlap.length;

            if (overlapCount === 0) return null;

            const overlapRatio = conceptCodes.size > 0 ? overlapCount / conceptCodes.size : 0;

            return {
                name: ind.name,
                code: ind.code,
                overlap_count: overlapCount,
                overlap_ratio: Math.round(overlapRatio * 1000) / 1000,
                stock_count: indCodes.size,
                overlap_codes: overlap,
            } as IndustryMapping;
        }));

        for (const r of results) {
            if (r) industryOverlaps.push(r);
        }
    }

    // 按重叠度排序
    industryOverlaps.sort((a, b) => b.overlap_count - a.overlap_count || b.overlap_ratio - a.overlap_ratio);

    const result = industryOverlaps.slice(0, topN);
    cacheSet(cacheKey, result);
    return result;
}

async function mapByRankingIndustry(conceptName: string, topN: number = 3): Promise<IndustryMapping[]> {
    // 当成分股接口不可用时，通过行业涨幅排名映射
    const industries = await getIndustryBoards();
    const topIndustries = industries
        .sort((a, b) => Math.abs(b.change || 0) - Math.abs(a.change || 0))
        .slice(0, topN);

    return topIndustries.map(ind => ({
        name: ind.name,
        code: ind.code,
        overlap_count: 0,
        overlap_ratio: 0,
        stock_count: 0,
        overlap_codes: [],
    }));
}

// ==================== 产业链上下游 ====================

const INDUSTRY_CHAIN: Record<string, { upstream: string[]; downstream: string[] }> = {
    '半导体': { upstream: ['电子化学品', '金属新材料', '小金属'], downstream: ['消费电子', '计算机设备', '通信设备', '汽车零部件'] },
    '元件': { upstream: ['电子化学品', '半导体', '金属新材料'], downstream: ['消费电子', '通信设备', '计算机设备'] },
    '通信设备': { upstream: ['半导体', '元件', '金属新材料'], downstream: ['计算机设备', '传媒', '游戏'] },
    '贵金属': { upstream: ['工业金属', '小金属'], downstream: ['珠宝首饰', '半导体'] },
    '小金属': { upstream: ['工业金属', '金属新材料'], downstream: ['半导体', '电力设备', '汽车零部件'] },
    '自动化设备': { upstream: ['半导体', '元件', '通用设备'], downstream: ['汽车零部件', '电力设备'] },
    '计算机设备': { upstream: ['半导体', '元件', '通信设备'], downstream: ['软件开发', '传媒'] },
    '电力设备': { upstream: ['半导体', '元件', '金属新材料', '小金属'], downstream: ['环保', '建筑装饰'] },
    '汽车零部件': { upstream: ['半导体', '元件', '金属新材料', '自动化设备'], downstream: ['汽车整车'] },
    '消费电子': { upstream: ['半导体', '元件', '电子化学品'], downstream: ['软件开发', '传媒'] },
    '电子化学品': { upstream: ['化学制品', '工业金属'], downstream: ['半导体', '元件'] },
    '金属新材料': { upstream: ['工业金属', '小金属'], downstream: ['半导体', '元件', '电力设备'] },
    '工业金属': { upstream: ['小金属', '贵金属'], downstream: ['金属新材料', '半导体', '电力设备'] },
    '化学制品': { upstream: ['石油加工', '基础化工'], downstream: ['电子化学品', '医药商业'] },
    '软件开发': { upstream: ['计算机设备', '通信设备'], downstream: ['传媒', '游戏'] },
    '煤炭开采加工': { upstream: ['石油加工'], downstream: ['电力', '钢铁', '化学制品'] },
    '电力': { upstream: ['煤炭开采加工', '电力设备'], downstream: ['钢铁', '化学制品', '有色金属'] },
    '钢铁': { upstream: ['煤炭开采加工', '工业金属'], downstream: ['建筑装饰', '汽车零部件', '通用设备'] },
    '光学光电子': { upstream: ['半导体', '元件', '电子化学品'], downstream: ['消费电子', '通信设备'] },
    '通用设备': { upstream: ['钢铁', '金属新材料', '工业金属'], downstream: ['自动化设备', '汽车零部件', '电力设备'] },
    '专用设备': { upstream: ['通用设备', '自动化设备', '金属新材料'], downstream: ['半导体', '电力设备'] },
    '建筑装饰': { upstream: ['钢铁', '建筑材料', '专用设备'], downstream: ['房地产'] },
    '建筑材料': { upstream: ['钢铁', '化学制品'], downstream: ['建筑装饰'] },
    '汽车整车': { upstream: ['汽车零部件', '自动化设备', '金属新材料'], downstream: [] },
    '环保': { upstream: ['电力设备', '专用设备'], downstream: [] },
    '传媒': { upstream: ['软件开发', '计算机设备'], downstream: ['游戏'] },
    '游戏': { upstream: ['传媒', '软件开发'], downstream: [] },
    '医药商业': { upstream: ['化学制品', '医药生物'], downstream: [] },
    '电网设备': { upstream: ['电力设备', '金属新材料', '自动化设备'], downstream: ['电力'] },
};

function getUpstreamDownstream(industryName: string): { upstream: string[]; downstream: string[] } {
    return INDUSTRY_CHAIN[industryName] || { upstream: [], downstream: [] };
}

// ==================== 传导因子计算 ====================

interface TransmissionItem {
    name: string;
    code: string;
    factor: number;
    direction: string;
    source_industry: string;
}

interface TransmissionResult {
    upstream: TransmissionItem[];
    downstream: TransmissionItem[];
}

async function calculateTransmissionFactor(
    conceptName: string,
    relatedIndustries: IndustryMapping[],
): Promise<TransmissionResult> {
    const result: TransmissionResult = { upstream: [], downstream: [] };

    // 获取风口概念的历史行情
    const mainHist = await getBoardHistory(conceptName, 10);

    // 收集所有上下游行业（去重）
    const upstreamSet = new Map<string, string>(); // name -> source_industry
    const downstreamSet = new Map<string, string>();

    for (const ind of relatedIndustries) {
        const chain = getUpstreamDownstream(ind.name);
        for (const up of chain.upstream) {
            if (!relatedIndustries.some(r => r.name === up) && !upstreamSet.has(up)) {
                upstreamSet.set(up, ind.name);
            }
        }
        for (const down of chain.downstream) {
            if (!relatedIndustries.some(r => r.name === down) && !downstreamSet.has(down)) {
                downstreamSet.set(down, ind.name);
            }
        }
    }

    // 获取行业板块列表用于查找code
    const industryBoards = await getIndustryBoards();
    const industryCodeMap = new Map(industryBoards.map(i => [i.name, i.code]));

    // 计算传导因子
    const directions: Array<{ dir: 'upstream' | 'downstream'; set: Map<string, string> }> = [
        { dir: 'upstream', set: upstreamSet },
        { dir: 'downstream', set: downstreamSet },
    ];

    for (const { dir, set } of directions) {
        const positionWeight = dir === 'upstream' ? 0.4 : 0.3;

        for (const [indName, sourceIndustry] of set) {
            let factor: number;

            if (mainHist.length === 0) {
                factor = Math.round(positionWeight * 0.7 * 1000) / 1000;
            } else {
                const relatedHist = await getBoardHistory(indName, 10);

                if (relatedHist.length === 0) {
                    factor = Math.round(positionWeight * 0.7 * 1000) / 1000;
                } else {
                    const minLen = Math.min(mainHist.length, relatedHist.length);
                    if (minLen >= 3) {
                        const mainChanges = mainHist.slice(-minLen).map(h => h.change_pct);
                        const relatedChanges = relatedHist.slice(-minLen).map(h => h.change_pct);
                        const correlation = Math.abs(pearsonCorrelation(mainChanges, relatedChanges));
                        const corr = isNaN(correlation) ? 0.3 : correlation;

                        // 资金流向相关性
                        const mainAmounts = mainHist.slice(-minLen).map(h => h.amount);
                        const relatedAmounts = relatedHist.slice(-minLen).map(h => h.amount);
                        const amountCorr = Math.abs(pearsonCorrelation(mainAmounts, relatedAmounts));
                        const aCorr = isNaN(amountCorr) ? 0.3 : amountCorr;

                        factor = Math.round((positionWeight * 0.4 + corr * 0.35 + aCorr * 0.25) * 1000) / 1000;
                    } else {
                        factor = Math.round(positionWeight * 0.7 * 1000) / 1000;
                    }
                }
            }

            result[dir].push({
                name: indName,
                code: industryCodeMap.get(indName) || '',
                factor,
                direction: dir,
                source_industry: sourceIndustry,
            });
        }
    }

    // 按传导因子排序
    result.upstream.sort((a, b) => b.factor - a.factor);
    result.downstream.sort((a, b) => b.factor - a.factor);

    return result;
}

/** 皮尔逊相关系数 */
function pearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;

    const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
    const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }

    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
}

// ==================== AI判断持续性 ====================

interface AiAnalysis {
    persistence: string;
    persistence_reason: string;
    heat_transfer: boolean;
    transfer_direction: string;
    transfer_reason: string;
    risk_warning: string;
}

async function aiAnalyzeSector(sectorName: string, sectorData: HotConcept, transmission: TransmissionResult): Promise<AiAnalysis> {
    const apiKey = process.env.OPENAI_API_KEY || '';
    const apiBase = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    const model = process.env.AI_MODEL || 'gpt-4o-mini';

    if (!apiKey) {
        console.log('[HotSectorAnalyzer] 未配置OPENAI_API_KEY，使用规则引擎判断');
        return ruleBasedAnalysis(sectorName, sectorData, transmission);
    }

    try {
        const prompt = `你是一位资深A股市场分析师。请根据以下数据，分析该风口概念板块的持续性和热度传递。

## 概念板块数据
- 概念名称：${sectorName}
- 近10日上榜频次：${sectorData.frequency}天
- 平均涨幅：${sectorData.avg_change}%
- 今日涨幅：${sectorData.today_change}%
- 资金趋势：${sectorData.amount_trend}%
- 上涨家数/下跌家数：${sectorData.up_count}/${sectorData.down_count}

## 上下游传导
- 上游：${JSON.stringify(transmission.upstream)}
- 下游：${JSON.stringify(transmission.downstream)}

请以JSON格式返回分析结果，包含以下字段：
1. persistence: 持续时间判断，值为"短期(1-3天)"/"中期(1-2周)"/"长期(1月+)"
2. persistence_reason: 持续性判断理由（50字以内）
3. heat_transfer: 热度是否会在板块间传递，true/false
4. transfer_direction: 传递方向
5. transfer_reason: 传递判断理由（50字以内）
6. risk_warning: 风险提示（30字以内）

只返回JSON，不要其他文字。`;

        const resp = await fetch(`${apiBase}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 500,
            }),
        });

        if (!resp.ok) throw new Error(`AI API HTTP ${resp.status}`);

        const json: any = await resp.json();
        let content = json?.choices?.[0]?.message?.content?.trim() || '';
        if (content.startsWith('```')) {
            content = content.split('```')[1];
            if (content.startsWith('json')) content = content.slice(4);
        }

        return JSON.parse(content.trim());
    } catch (err) {
        console.error('[HotSectorAnalyzer] AI分析失败，使用规则引擎:', err);
        return ruleBasedAnalysis(sectorName, sectorData, transmission);
    }
}

function ruleBasedAnalysis(sectorName: string, sectorData: HotConcept, transmission: TransmissionResult): AiAnalysis {
    const freq = sectorData.frequency;
    const avgChange = sectorData.avg_change;
    const amountTrend = sectorData.amount_trend;

    let persistence: string, reason: string;
    if (freq >= 6 && avgChange > 2 && amountTrend > 10) {
        persistence = '长期(1月+)';
        reason = '高频上榜+持续放量+资金加速流入，趋势强劲';
    } else if (freq >= 4 && avgChange > 1) {
        persistence = '中期(1-2周)';
        reason = '中频上榜+涨幅稳定，有一定持续性';
    } else {
        persistence = '短期(1-3天)';
        reason = '上榜频次较低或资金流出，持续性存疑';
    }

    const upFactors = transmission.upstream.map(u => u.factor);
    const downFactors = transmission.downstream.map(d => d.factor);
    const maxUp = upFactors.length > 0 ? Math.max(...upFactors) : 0;
    const maxDown = downFactors.length > 0 ? Math.max(...downFactors) : 0;

    let heatTransfer: boolean, direction: string, transferReason: string;
    if (maxUp > 0.5 || maxDown > 0.5) {
        heatTransfer = true;
        if (maxUp > maxDown) {
            direction = '上游→中游';
            transferReason = '上游传导因子较高，原材料端先行启动';
        } else {
            direction = '中游→下游';
            transferReason = '下游传导因子较高，需求端拉动效应明显';
        }
    } else {
        heatTransfer = false;
        direction = '无明显传递';
        transferReason = '上下游传导因子均较低，板块联动性弱';
    }

    const risk = freq < 4 ? '追高风险较大，注意板块轮动节奏' : '关注量能变化，缩量需警惕';

    return {
        persistence,
        persistence_reason: reason,
        heat_transfer: heatTransfer,
        transfer_direction: direction,
        transfer_reason: transferReason,
        risk_warning: risk,
    };
}

// ==================== 选股打分 ====================

interface SelectedStock {
    code: string;
    name: string;
    industry: string;
    score: number;
    reason: string;
    reason_tag: string;
    reason_tag_class: string;
    source: string;
    in_concept: boolean;
    chain_position?: string;
    related_industry?: string;
    overlap_ratio?: number;
    transmission_factor?: number;
    source_industry?: string;
    price?: number;
    change_pct?: number;
}

/** 将东方财富6位代码转为Tushare ts_code格式 */
function toTsCodeFromEm(emCode: string): string {
    if (!emCode || emCode.length !== 6) return '';
    const first = emCode[0];
    const suffix = first === '6' ? '.SH' : (first === '0' || first === '3') ? '.SZ' : first === '8' || first === '4' ? '.BJ' : '.SZ';
    return emCode + suffix;
}

/** 批量获取Tushare增强数据（资金流向+每日指标），返回Map<ts_code, data> */
async function fetchTushareEnhancement(stockCodes: string[]): Promise<{
    moneyflowMap: Map<string, MoneyflowRow>;
    dailyBasicMap: Map<string, DailyBasicFullRow>;
    dailyHistMap: Map<string, DailyPriceRow[]>;
}> {
    const moneyflowMap = new Map<string, MoneyflowRow>();
    const dailyBasicMap = new Map<string, DailyBasicFullRow>();
    const dailyHistMap = new Map<string, DailyPriceRow[]>();

    // 获取最近交易日（Tushare需要trade_date参数）
    const today = new Date();
    const tradeDateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    // 批量获取单日全市场资金流向
    try {
        const mfRows = await getMoneyflowByDate(tradeDateStr);
        for (const row of mfRows) {
            moneyflowMap.set(row.ts_code, row);
        }
        // 如果当天没数据（非交易日），尝试前一个交易日
        if (mfRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const ydStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
            const ydRows = await getMoneyflowByDate(ydStr);
            for (const row of ydRows) {
                moneyflowMap.set(row.ts_code, row);
            }
        }
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare资金流向获取失败:', err);
    }

    // 批量获取单日全市场每日指标
    try {
        const dbRows = await getDailyBasicByDate(tradeDateStr);
        for (const row of dbRows) {
            dailyBasicMap.set(row.ts_code, row);
        }
        if (dbRows.length === 0) {
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const ydStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');
            const ydRows = await getDailyBasicByDate(ydStr);
            for (const row of ydRows) {
                dailyBasicMap.set(row.ts_code, row);
            }
        }
    } catch (err) {
        console.warn('[HotSectorAnalyzer] Tushare每日指标获取失败:', err);
    }

    // 对候选股获取近10日日线（用于计算连续上涨天数），限制并发
    const tsCodes = stockCodes.map(c => toTsCodeFromEm(c)).filter(Boolean);
    const batchSize = 5;
    for (let i = 0; i < tsCodes.length; i += batchSize) {
        const batch = tsCodes.slice(i, i + batchSize);
        const promises = batch.map(async (tsCode) => {
            try {
                const rows = await getStockDailyRecent(tsCode.split('.')[0], 10);
                dailyHistMap.set(tsCode, rows);
            } catch { /* ignore */ }
        });
        await Promise.all(promises);
    }

    return { moneyflowMap, dailyBasicMap, dailyHistMap };
}

/** 计算连续上涨天数（从最近一天往前数） */
function calcConsecutiveUpDays(dailyRows: DailyPriceRow[]): number {
    let count = 0;
    for (const row of dailyRows) {
        if (row.pct_chg > 0) count++;
        else break;
    }
    return count;
}

async function selectStocksFromIndustry(
    industryCode: string,
    industryName: string,
    conceptName: string,
    conceptCodes: Set<string>,
    maxStocks: number = 3,
    enhancement?: {
        moneyflowMap: Map<string, MoneyflowRow>;
        dailyBasicMap: Map<string, DailyBasicFullRow>;
        dailyHistMap: Map<string, DailyPriceRow[]>;
    },
): Promise<SelectedStock[]> {
    const stocks: SelectedStock[] = [];

    // 获取板块成分股（涨幅排序，取前20）
    const topStocks = await getBoardTopStocks(industryCode, 20, 'industry');
    if (topStocks.length === 0) return [];

    // 获取板块近5日K线，用于判断连续上涨
    const hist = await getBoardHistory(industryName, 5);
    const isBoardUptrend = hist.length >= 3 && hist.slice(-3).every(h => h.change_pct > 0);

    for (const stock of topStocks) {
        if (stocks.length >= maxStocks) break;
        if (stocks.some(s => s.code === stock.code)) continue;

        const changePct = stock.change_pct || 0;

        // Tushare增强数据
        const tsCode = toTsCodeFromEm(stock.code);
        const mfData = enhancement?.moneyflowMap.get(tsCode);
        const dbData = enhancement?.dailyBasicMap.get(tsCode);
        const histData = enhancement?.dailyHistMap.get(tsCode);

        // 换手率：优先用Tushare数据，回退到同花顺HTML解析值
        const turnover = dbData?.turnover_rate || stock.turnover_rate || 0;

        // Tushare资金净流入（万元）
        const netMfAmount = mfData?.net_mf_amount || 0;
        // 大单+特大单净买入（万元）
        const bigNetAmount = mfData ? ((mfData.buy_lg_amount || 0) - (mfData.sell_lg_amount || 0) + (mfData.buy_elg_amount || 0) - (mfData.sell_elg_amount || 0)) : 0;

        // 资金净流入（元）：优先用Tushare数据（万元→元），回退到同花顺HTML解析值
        const netInflowEm = netMfAmount ? netMfAmount * 10000 : (stock.net_inflow || 0);
        // 量比
        const volumeRatio = dbData?.volume_ratio || 0;
        // 流通市值（万元）
        const circMv = dbData?.circ_mv || 0;
        // 换手率（自由流通股）
        const turnoverF = dbData?.turnover_rate_f || 0;
        // 连续上涨天数
        const consecutiveUpDays = histData ? calcConsecutiveUpDays(histData) : 0;

        // 市值过滤：流通市值 < 20亿 的跳过（容易被操纵）
        if (circMv > 0 && circMv < 200000) {
            continue;
        }

        // 多因子打分
        let baseScore = 0;
        let reason = '';
        let reasonTag = '';
        let reasonTagClass = '';

        // 连续上涨加分（独立于其他条件）
        const consecutiveBonus = consecutiveUpDays >= 3 ? (consecutiveUpDays - 2) * 5 : 0;

        if (changePct > 5 && turnover > 5) {
            // 量价齐升
            baseScore = Math.min(90, Math.abs(changePct) * 5 + turnover * 2 + Math.min(Math.abs(netInflowEm) / 100000000, 10) * 3);
            reason = `量价齐升，涨幅${changePct.toFixed(1)}%`;
            reasonTag = '量价齐升';
            reasonTagClass = 'tag-trend';
        } else if (consecutiveUpDays >= 3) {
            // 连续上涨3天以上
            baseScore = Math.min(88, Math.abs(changePct) * 5 + consecutiveUpDays * 6 + turnover * 1.5);
            reason = `连续${consecutiveUpDays}日上涨，阶段涨幅${changePct.toFixed(1)}%`;
            reasonTag = '连续上涨';
            reasonTagClass = 'tag-bullish';
        } else if (changePct > 3 && isBoardUptrend) {
            // 板块连续上涨 + 个股强势
            baseScore = Math.min(86, Math.abs(changePct) * 6 + turnover * 1.5 + Math.min(Math.abs(netInflowEm) / 100000000, 10) * 2);
            reason = `板块联动上涨，涨幅${changePct.toFixed(1)}%`;
            reasonTag = '连续上涨';
            reasonTagClass = 'tag-bullish';
        } else if (changePct > 3) {
            // 强势上涨
            baseScore = Math.min(85, Math.abs(changePct) * 6 + turnover * 1.5);
            reason = `涨幅${changePct.toFixed(1)}%`;
            reasonTag = '强势上涨';
            reasonTagClass = 'tag-bullish';
        } else if (bigNetAmount > 5000) {
            // 大单净买入 > 5000万（Tushare数据，更精准）
            baseScore = Math.min(82, 40 + Math.min(bigNetAmount / 10000, 20) * 2);
            reason = `主力大单净买入${(bigNetAmount / 10000).toFixed(2)}亿`;
            reasonTag = '持续放量';
            reasonTagClass = 'tag-fund';
        } else if (Math.abs(netInflowEm) > 500000000) {
            // 东方财富资金大幅流入
            baseScore = Math.min(80, 40 + Math.min(Math.abs(netInflowEm) / 100000000, 20) * 2);
            reason = `持续放量，主力净流入${(netInflowEm / 100000000).toFixed(2)}亿`;
            reasonTag = '持续放量';
            reasonTagClass = 'tag-fund';
        } else if (changePct > 0 && turnover > 3) {
            // 放量上涨
            baseScore = Math.min(75, Math.abs(changePct) * 8 + turnover * 1.2);
            reason = `放量上涨${changePct.toFixed(1)}%，换手率${turnover.toFixed(1)}%`;
            reasonTag = '量价齐升';
            reasonTagClass = 'tag-trend';
        } else if (changePct > 0) {
            // 上涨
            baseScore = Math.min(70, Math.abs(changePct) * 8 + turnover);
            reason = `涨幅${changePct.toFixed(1)}%`;
            reasonTag = '上涨';
            reasonTagClass = 'tag-trend';
        } else {
            continue; // 跳过下跌股
        }

        // 量比加分（量比>2说明明显放量）
        const volumeRatioBonus = volumeRatio > 2 ? Math.min(8, (volumeRatio - 2) * 3) : 0;
        if (volumeRatioBonus > 0 && !reason.includes('放量')) {
            reason += `，量比${volumeRatio.toFixed(1)}`;
        }

        // 概念标签加分
        const conceptBonus = conceptCodes.has(stock.code) ? 10 : 0;
        if (conceptBonus > 0) {
            reasonTag = '概念共振';
            reasonTagClass = 'tag-bullish';
        }

        const totalScore = baseScore + consecutiveBonus + volumeRatioBonus + conceptBonus;

        stocks.push({
            code: stock.code,
            name: stock.name,
            industry: industryName,
            score: Math.round(totalScore * 10) / 10,
            reason,
            reason_tag: reasonTag,
            reason_tag_class: reasonTagClass,
            source: reasonTag === '概念共振' ? conceptName : reasonTag,
            in_concept: conceptBonus > 0,
            price: stock.price,
            change_pct: stock.change_pct,
        });
    }

    // 按评分排序
    stocks.sort((a, b) => b.score - a.score);
    return stocks.slice(0, maxStocks);
}

// ==================== 构建层级流向图 ====================

interface FlowNode {
    id: string;
    type: string;
    label: string;
}

interface FlowLink {
    source: string;
    target: string;
    factor: number;
    direction: string;
}

function buildFlowData(
    conceptName: string,
    relatedIndustries: IndustryMapping[],
    transmission: TransmissionResult,
    aiAnalysis: AiAnalysis,
): { nodes: FlowNode[]; links: FlowLink[]; transfer_direction: string } {
    const nodes: FlowNode[] = [
        { id: conceptName, type: 'main', label: conceptName },
    ];
    const links: FlowLink[] = [];

    // 概念 → 强关联行业
    for (const ind of relatedIndustries) {
        nodes.push({ id: ind.name, type: 'related', label: ind.name });
        links.push({
            source: conceptName,
            target: ind.name,
            factor: ind.overlap_ratio || 0.5,
            direction: 'related',
        });
    }

    // 强关联行业 → 上游
    for (const up of transmission.upstream) {
        if (!nodes.some(n => n.id === up.name)) {
            nodes.push({ id: up.name, type: 'upstream', label: up.name });
        }
        links.push({
            source: up.name,
            target: up.source_industry,
            factor: up.factor,
            direction: 'upstream',
        });
    }

    // 强关联行业 → 下游
    for (const down of transmission.downstream) {
        if (!nodes.some(n => n.id === down.name)) {
            nodes.push({ id: down.name, type: 'downstream', label: down.name });
        }
        links.push({
            source: down.source_industry,
            target: down.name,
            factor: down.factor,
            direction: 'downstream',
        });
    }

    return {
        nodes,
        links,
        transfer_direction: aiAnalysis.transfer_direction || '',
    };
}

// ==================== 提取龙头股信息 ====================

interface LeadingStockInfo {
    name: string;
    code: string;
    industry: string;
    price: number | null;
    change_pct: number | null;
    reason: string;
    in_concept: boolean;
}

async function extractLeadingStock(
    conceptName: string,
    concept: HotConcept,
    mainStocks: SelectedStock[],
    conceptCode: string,
): Promise<LeadingStockInfo> {
    // 优先从已筛选的mainStocks中取评分最高的
    if (mainStocks.length > 0) {
        const best = mainStocks.reduce((a, b) => (a.score > b.score ? a : b));
        // 尝试获取实时价格（始终尝试，因为 topStocks 的 price 可能为 "-" 或无效值）
        let price = best.price || null;
        let changePct = best.change_pct || null;
        if (best.code) {
            try {
                const quote = await EmQuoteService.getQuote(best.code, 'core');
                if (quote['最新价'] && quote['最新价'] !== '-') price = quote['最新价'];
                if (quote['涨跌幅']) changePct = quote['涨跌幅'];
            } catch { /* ignore */ }
        }
        return {
            name: best.name,
            code: best.code,
            industry: best.industry,
            price,
            change_pct: changePct,
            reason: best.reason,
            in_concept: best.in_concept,
        };
    }

    // 备选：从概念板块的领涨股中取
    const topStocks = await getBoardTopStocks(conceptCode, 1);
    if (topStocks.length > 0) {
        const stock = topStocks[0];
        let price = stock.price || null;
        let changePct = stock.change_pct || null;
        if (stock.code) {
            try {
                const quote = await EmQuoteService.getQuote(stock.code, 'core');
                if (quote['最新价'] && quote['最新价'] !== '-') price = quote['最新价'];
                if (quote['涨跌幅']) changePct = quote['涨跌幅'];
            } catch { /* ignore */ }
        }
        return {
            name: stock.name,
            code: stock.code,
            industry: stock.industry || '',
            price,
            change_pct: changePct,
            reason: concept.driver || '',
            in_concept: true,
        };
    }

    return {
        name: concept.leading_stock !== '--' ? concept.leading_stock : '',
        code: '',
        industry: '',
        price: null,
        change_pct: null,
        reason: concept.driver || '',
        in_concept: false,
    };
}

// ==================== 获取关联行业行情统计 ====================

async function getIndustryStats(industryNames: string[]): Promise<any[]> {
    const industryBoards = await getIndustryBoards();
    const result: any[] = [];

    for (const name of industryNames) {
        const ind = industryBoards.find(i => i.name === name);
        if (ind) {
            result.push({
                name,
                change: ind.change || 0,
                up_count: ind.up_count || 0,
                down_count: ind.down_count || 0,
                leading_stock: '--',
            });
        } else {
            result.push({ name, change: 0, up_count: 0, down_count: 0, leading_stock: '--' });
        }
    }

    return result;
}

// ==================== 完整分析流程 ====================

export interface FullAnalysisResult {
    update_time: string;
    hot_sectors: any[];
}

export class HotSectorAnalyzerService {
    /**
     * 执行完整的风口爆发股分析流程
     *
     * 流程：
     * 1. 从概念板块中识别风口概念
     * 2. 根据概念成分股映射强关联二级行业
     * 3. 展开上下游二级行业
     * 4. 计算传导因子
     * 5. AI判断持续性
     * 6. 在各行业中选股（概念标签加分）
     * 7. 构建层级流向图
     */
    static async runFullAnalysis(): Promise<FullAnalysisResult> {
        console.log('[HotSectorAnalyzer] 开始执行风口爆发股分析...');

        // 1. 识别风口概念板块
        let hotConcepts = await identifyHotConcepts(8, 3, 10);
        if (hotConcepts.length === 0) {
            console.log('[HotSectorAnalyzer] 未识别到风口概念，降低筛选条件重试');
            hotConcepts = await identifyHotConcepts(8, 2, 10);
        }

        const result: FullAnalysisResult = {
            update_time: new Date().toLocaleString('zh-CN', { hour12: false }),
            hot_sectors: [],
        };

        // 预先收集所有候选股代码，用于批量获取Tushare增强数据
        const allCandidateCodes: string[] = [];
        const conceptCodeSets: Map<string, Set<string>> = new Map();
        const conceptIndustryMap: Map<string, any[]> = new Map(); // 缓存行业映射结果
        const industryBoards = await getIndustryBoards();

        for (const concept of hotConcepts) {
            // 获取概念成分股代码集合
            const conceptCons = await getBoardConstituents(concept.code, 'concept', 200);
            const conceptCodes = new Set(conceptCons.map(s => s.code));
            conceptCodeSets.set(concept.code, conceptCodes);

            // 收集强关联行业的候选股代码
            const relatedIndustries = await mapConceptToIndustries(concept.code, concept.name, 3);
            conceptIndustryMap.set(concept.code, relatedIndustries);
            for (const ind of relatedIndustries) {
                const topStocks = await getBoardTopStocks(ind.code, 10, 'industry');
                for (const s of topStocks) {
                    if (s.code && !allCandidateCodes.includes(s.code)) {
                        allCandidateCodes.push(s.code);
                    }
                }
            }

            // 收集上下游行业的候选股代码（限制数量）
            const transmission = await calculateTransmissionFactor(concept.name, relatedIndustries);
            for (const up of transmission.upstream.slice(0, 1)) {
                const indCode = industryBoards.find(i => i.name === up.name)?.code || '';
                if (!indCode) continue;
                const topStocks = await getBoardTopStocks(indCode, 10, 'industry');
                for (const s of topStocks) {
                    if (s.code && !allCandidateCodes.includes(s.code)) {
                        allCandidateCodes.push(s.code);
                    }
                }
            }
            for (const down of transmission.downstream.slice(0, 1)) {
                const indCode = industryBoards.find(i => i.name === down.name)?.code || '';
                if (!indCode) continue;
                const topStocks = await getBoardTopStocks(indCode, 10, 'industry');
                for (const s of topStocks) {
                    if (s.code && !allCandidateCodes.includes(s.code)) {
                        allCandidateCodes.push(s.code);
                    }
                }
            }
        }

        // 批量获取Tushare增强数据（资金流向+每日指标+近10日日线）
        console.log(`[HotSectorAnalyzer] 批量获取Tushare增强数据，共${allCandidateCodes.length}只候选股...`);
        const enhancement = await fetchTushareEnhancement(allCandidateCodes);
        console.log(`[HotSectorAnalyzer] Tushare增强数据获取完成：资金流向${enhancement.moneyflowMap.size}只，每日指标${enhancement.dailyBasicMap.size}只，日线${enhancement.dailyHistMap.size}只`);

        // 清除概念板块和行业映射的缓存，让后续调用重新获取（因为前面已经获取过一次了）
        // 不清除，因为缓存TTL=1小时，同一次分析内复用是合理的

        for (const concept of hotConcepts) {
            console.log(`[HotSectorAnalyzer] 分析风口概念: ${concept.name}`);

            // 2. 映射强关联二级行业
            const relatedIndustries = await mapConceptToIndustries(concept.code, concept.name, 3);
            const relatedIndNames = relatedIndustries.map(r => r.name);

            // 获取概念成分股代码集合
            const conceptCodes = conceptCodeSets.get(concept.code) || new Set();

            // 3. 计算上下游传导
            const transmission = await calculateTransmissionFactor(concept.name, relatedIndustries);

            // 4. AI判断持续性
            const aiAnalysis = await aiAnalyzeSector(concept.name, concept, transmission);

            // 5. 选股 - 强关联行业（风口精选）
            const mainStocks: SelectedStock[] = [];
            for (const ind of relatedIndustries) {
                const indStocks = await selectStocksFromIndustry(
                    ind.code, ind.name, concept.name, conceptCodes, 2, enhancement,
                );
                for (const s of indStocks) {
                    s.chain_position = '核心';
                    s.related_industry = ind.name;
                    s.overlap_ratio = ind.overlap_ratio;
                }
                mainStocks.push(...indStocks);
            }

            // 去重（按股票代码去重，保留评分最高的）
            const seenCodes = new Set<string>();
            const uniqueMain: SelectedStock[] = [];
            for (const s of mainStocks.sort((a, b) => b.score - a.score)) {
                if (!seenCodes.has(s.code)) {
                    seenCodes.add(s.code);
                    uniqueMain.push(s);
                }
            }
            const finalMainStocks = uniqueMain.slice(0, 5);

            // 6. 选股 - 上下游行业
            const upstreamStocks: SelectedStock[] = [];
            for (const up of transmission.upstream.slice(0, 2)) {
                const indCode = industryBoards.find(i => i.name === up.name)?.code || '';
                if (!indCode) continue;
                const stocks = await selectStocksFromIndustry(
                    indCode, up.name, concept.name, conceptCodes, 2, enhancement,
                );
                for (const s of stocks) {
                    s.chain_position = '上游';
                    s.transmission_factor = up.factor;
                    s.source_industry = up.source_industry;
                }
                upstreamStocks.push(...stocks);
            }

            const downstreamStocks: SelectedStock[] = [];
            for (const down of transmission.downstream.slice(0, 2)) {
                const indCode = industryBoards.find(i => i.name === down.name)?.code || '';
                if (!indCode) continue;
                const stocks = await selectStocksFromIndustry(
                    indCode, down.name, concept.name, conceptCodes, 2, enhancement,
                );
                for (const s of stocks) {
                    s.chain_position = '下游';
                    s.transmission_factor = down.factor;
                    s.source_industry = down.source_industry;
                }
                downstreamStocks.push(...stocks);
            }

            // 跨类别去重：上游和下游中移除已出现在核心的股票
            const mainCodes = new Set(finalMainStocks.map(s => s.code));
            const filteredUpstream = upstreamStocks.filter(s => !mainCodes.has(s.code));
            const filteredDownstream = downstreamStocks.filter(s => !mainCodes.has(s.code) && !filteredUpstream.some(u => u.code === s.code));

            // 7. 构建层级流向图数据
            const flowData = buildFlowData(concept.name, relatedIndustries, transmission, aiAnalysis);

            // 8. 获取关联行业行情数据
            const industryData = await getIndustryStats(relatedIndNames);

            // 9. 提取龙头股信息
            const leadingStockInfo = await extractLeadingStock(
                concept.name, concept, finalMainStocks, concept.code,
            );

            result.hot_sectors.push({
                name: concept.name,
                type: concept.type,
                frequency: concept.frequency,
                avg_change: concept.avg_change,
                today_change: concept.today_change,
                amount_trend: concept.amount_trend,
                leading_stock: concept.leading_stock,
                leading_change: concept.leading_change,
                up_count: concept.up_count,
                down_count: concept.down_count,
                driver: concept.driver,
                related_industries: relatedIndNames,
                industry_data: industryData,
                ai_analysis: aiAnalysis,
                main_stocks: finalMainStocks,
                upstream_stocks: filteredUpstream,
                downstream_stocks: filteredDownstream,
                flow_data: flowData,
                leading_stock_info: leadingStockInfo,
            });
        }

        // 保存结果
        const dataDir = path.resolve(__dirname, '../../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        const dataFile = path.join(dataDir, 'hot-sectors.json');
        fs.writeFileSync(dataFile, JSON.stringify(result, null, 2), 'utf-8');
        console.log(`[HotSectorAnalyzer] 风口爆发股分析完成，共 ${result.hot_sectors.length} 个板块，结果已保存到 ${dataFile}`);

        return result;
    }
}
