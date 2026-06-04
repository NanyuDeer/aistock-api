/**
 * 风口爆发股服务
 *
 * 读取 data/hot-sectors.json，提供风口板块及龙头个股数据
 * 数据由外部 Python 分析引擎通过 POST /api/internal/hot-sectors 推送
 */

import fs from 'fs';
import path from 'path';

const DATA_FILE = path.resolve(__dirname, '../../data/hot-sectors.json');

let cachedData: any = null;
let cachedTime = 0;
const CACHE_TTL = 60 * 1000; // 缓存1分钟

function loadData(): any {
    const now = Date.now();
    if (cachedData && now - cachedTime < CACHE_TTL) {
        return cachedData;
    }

    try {
        if (!fs.existsSync(DATA_FILE)) {
            return null;
        }
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        cachedData = JSON.parse(raw);
        cachedTime = now;
        return cachedData;
    } catch (err) {
        console.error('[HotSectorService] 读取 hot-sectors.json 失败:', err);
        return cachedData;
    }
}

function invalidateCache(): void {
    cachedData = null;
    cachedTime = 0;
}

/** 格式化股票数据，保留完整字段 */
function formatStock(s: any): any {
    return {
        code: s.code,
        name: s.name,
        industry: s.industry,
        score: s.score,
        reason: s.reason,
        reason_tag: s.reason_tag,
        reason_tag_class: s.reason_tag_class || '',
        in_concept: s.in_concept,
        chain_position: s.chain_position,
        source: s.source || '',
        overlap_ratio: s.overlap_ratio || 0,
        transmission_factor: s.transmission_factor || 0,
        related_industry: s.related_industry || '',
        price: s.price ?? null,
        change_pct: s.change_pct ?? null,
    };
}

export class HotSectorService {
    /**
     * 获取风口爆发股分析结果（完整数据，含 flow_data、leading_stock_info 等）
     * @param limit 返回的风口板块数量，默认8
     */
    static getAnalysis(limit: number = 8): {
        update_time: string;
        hot_sectors: any[];
    } | null {
        const data = loadData();
        if (!data) return null;

        const sectors = (data.hot_sectors || []).slice(0, limit).map((sector: any) => ({
            name: sector.name,
            type: sector.type,
            frequency: sector.frequency,
            avg_change: sector.avg_change,
            today_change: sector.today_change,
            amount_trend: sector.amount_trend,
            score: sector.score ?? 0,
            leading_stock: sector.leading_stock,
            leading_change: sector.leading_change || 0,
            up_count: sector.up_count || 0,
            down_count: sector.down_count || 0,
            driver: sector.driver,
            related_industries: sector.related_industries || [],
            industry_data: sector.industry_data || [],
            ai_analysis: sector.ai_analysis || null,
            main_stocks: (sector.main_stocks || []).map(formatStock),
            upstream_stocks: (sector.upstream_stocks || []).map(formatStock),
            downstream_stocks: (sector.downstream_stocks || []).map(formatStock),
            flow_data: sector.flow_data || null,
            leading_stock_info: sector.leading_stock_info || null,
        }));

        return {
            update_time: data.update_time || '',
            hot_sectors: sectors,
        };
    }

    /**
     * 保存风口爆发股数据（由外部推送调用）
     */
    static saveData(data: any): void {
        try {
            const dir = path.dirname(DATA_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
            invalidateCache();
        } catch (err) {
            console.error('[HotSectorService] 保存 hot-sectors.json 失败:', err);
            throw err;
        }
    }
}
