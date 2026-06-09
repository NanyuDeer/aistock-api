import { StockInfoService, type StockInfoImpact, type StockInfoJudgementRow } from './StockInfoService';

const INFO_TYPE_LABELS: Record<string, string> = {
    announcement: '公告研判',
    news: '新闻研判',
};

const HORIZON_CYCLES: Record<string, string> = {
    短期: 'short',
    中期: 'mid',
    长期: 'long',
    中长期: 'long',
};

const TREND_HOTSPOT_IMPACTS = new Set<StockInfoImpact>(['重大利好', '利好', '中性', '利空', '重大利空']);

export interface MonitorEventItem {
    event_id: string;
    symbol: string;
    stock_code: string;
    stock_name: string;
    industry: string;
    change_type: string;
    change_type_name: string;
    level: string;
    cycle: string;
    price: number | null;
    change_pct: number | null;
    volume_ratio: number | null;
    turnover_rate: number | null;
    event_time: string | Date;
    title: string;
    summary: string;
    detail_url: string;
    info_type: string;
    ai_impact: string;
    ai_horizon: string;
    ai_keywords: string[];
    source: string;
}

export interface TrendHotspotStats {
    total: number;
    announcement: number;
    news: number;
    positive: number;
    negative: number;
}

function normalizeStockCode(value: string): string {
    return String(value || '').replace(/^(SH|SZ|BJ)/i, '').trim();
}

function normalizeCycle(value: string | undefined): string | undefined {
    if (!value || value === 'all') return undefined;
    return value;
}

function normalizeImpact(value: string | undefined): StockInfoImpact | undefined {
    return value && TREND_HOTSPOT_IMPACTS.has(value as StockInfoImpact)
        ? value as StockInfoImpact
        : undefined;
}

function mapJudgementToEvent(row: StockInfoJudgementRow): MonitorEventItem {
    return {
        event_id: `stock_info:${row.id}`,
        symbol: row.symbol,
        stock_code: normalizeStockCode(row.symbol),
        stock_name: row.stock_name || row.symbol,
        industry: '',
        change_type: row.info_type,
        change_type_name: INFO_TYPE_LABELS[row.info_type] || row.info_type,
        level: row.ai_impact,
        cycle: HORIZON_CYCLES[row.ai_horizon] || 'short',
        price: null,
        change_pct: null,
        volume_ratio: null,
        turnover_rate: null,
        event_time: row.published_at,
        title: row.title,
        summary: row.ai_summary,
        detail_url: row.url,
        info_type: row.info_type,
        ai_impact: row.ai_impact,
        ai_horizon: row.ai_horizon,
        ai_keywords: row.ai_keywords,
        source: row.source || '',
    };
}

export class StockMonitorService {
    static async getEvents(params: {
        cycle?: string;
        change_type?: string;
        stock_code?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ total: number; events: MonitorEventItem[] }> {
        const cycle = normalizeCycle(params.cycle);
        const result = await StockInfoService.queryJudgements({
            symbol: params.stock_code,
            info_type: params.change_type as any,
            impact: normalizeImpact(params.change_type),
            limit: params.limit || 20,
            offset: params.offset || 0,
        });

        const events = result.items.map(mapJudgementToEvent);
        const filteredEvents = cycle
            ? events.filter(event => event.cycle === cycle)
            : events;

        return {
            total: cycle ? filteredEvents.length : result.total,
            events: filteredEvents,
        };
    }

    static async getEventsByStockCode(stockCode: string, params?: {
        cycle?: string;
        limit?: number;
    }): Promise<MonitorEventItem[]> {
        const result = await StockMonitorService.getEvents({
            stock_code: stockCode,
            cycle: params?.cycle,
            limit: params?.limit || 20,
        });
        return result.events;
    }

    static async getStats(): Promise<TrendHotspotStats> {
        await StockInfoService.ensureSchema();
        const poolModule = await import('../db');
        const result = await poolModule.default.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE info_type = 'announcement')::int AS announcement,
                COUNT(*) FILTER (WHERE info_type = 'news')::int AS news,
                COUNT(*) FILTER (WHERE ai_impact IN ('重大利好', '利好'))::int AS positive,
                COUNT(*) FILTER (WHERE ai_impact IN ('重大利空', '利空'))::int AS negative
             FROM stock_info_judgements`,
        );

        const row = result.rows[0] || {};
        return {
            total: Number(row.total || 0),
            announcement: Number(row.announcement || 0),
            news: Number(row.news || 0),
            positive: Number(row.positive || 0),
            negative: Number(row.negative || 0),
        };
    }
}
