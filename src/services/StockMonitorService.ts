/**
 * 个股异动监测服务
 *
 * 职责：从数据源拉取全市场行情，计算异动指标，生成异动事件
 *
 * 当前状态：预留接口，返回空数据
 * 后续升级：接入东方财富全市场行情批量接口，实现主动监测引擎
 */

import pool from '../db';
import { EmQuoteService } from './EmQuoteService';
import { EmService } from './EmInfoService';

// 异动类型定义（与前端 mock/monitorEvents.js 对齐）
export const CHANGE_TYPES: Record<string, string> = {
    '4': '封涨停板',
    '8': '封跌停板',
    '16': '打开涨停板',
    '32': '打开跌停板',
    '64': '快速反弹',
    '128': '高台跳水',
    '8193': '火箭发射',
    '8194': '加速下跌',
    '8201': '大笔买入',
    '8202': '大笔卖出',
    '8203': '有大买盘',
    '8204': '有大卖盘',
    '8207': '高开5日线',
    '8208': '低开5日线',
    '8209': '向上缺口',
    '8210': '向下缺口',
    '8211': '60日新高',
    '8212': '60日新低',
    '8213': '60日大幅上涨',
    '8214': '60日大幅下跌',
    '8215': '竞价上涨',
    '8216': '竞价下跌',
};

// 异动级别
export const CHANGE_LEVELS: Record<string, string> = {
    '8207': 'L1', '8208': 'L1', '8209': 'L1', '8210': 'L1',
    '8211': 'L1', '8212': 'L1',
    '8201': 'L2', '8202': 'L2', '8203': 'L2', '8204': 'L2',
    '8215': 'L2', '8216': 'L2',
    '64': 'L3', '128': 'L3', '8193': 'L3', '8194': 'L3',
    '8213': 'L3', '8214': 'L3',
    '4': 'L4', '8': 'L4', '16': 'L4', '32': 'L4',
};

// 异动类型对应的周期分类
export const CHANGE_TYPE_CYCLES: Record<string, string> = {
    '4': 'short', '8': 'short', '16': 'short', '32': 'short',
    '64': 'short', '128': 'short', '8193': 'short', '8194': 'short',
    '8201': 'short', '8202': 'short', '8203': 'short', '8204': 'short',
    '8207': 'mid', '8208': 'mid', '8209': 'mid', '8210': 'mid',
    '8215': 'short', '8216': 'short',
    '8211': 'mid', '8212': 'mid', '8213': 'long', '8214': 'long',
};

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
    event_time: string;
}

export class StockMonitorService {
    /**
     * 查询异动事件列表
     * 当前：从数据库 stock_monitor_events 表查询
     * 后续：可增加 Redis 缓存层，减少数据库压力
     */
    static async getEvents(params: {
        cycle?: string;
        change_type?: string;
        stock_code?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ total: number; events: MonitorEventItem[] }> {
        const { cycle, change_type, stock_code, limit = 20, offset = 0 } = params;

        // 构建查询条件
        const conditions: string[] = [];
        const values: any[] = [];
        let paramIdx = 1;

        if (stock_code) {
            // 支持纯数字代码(如600519)和带市场前缀代码(如SH600519)
            if (/^\d{6}$/.test(stock_code)) {
                conditions.push(`(symbol = $${paramIdx} OR symbol = $${paramIdx + 1} OR symbol = $${paramIdx + 2})`);
                values.push(stock_code, `SH${stock_code}`, `SZ${stock_code}`);
                paramIdx += 3;
            } else {
                conditions.push(`symbol = $${paramIdx++}`);
                values.push(stock_code);
            }
        }

        if (change_type) {
            conditions.push(`event_type = $${paramIdx++}`);
            values.push(change_type);
        }

        // 日期过滤：只查当天的异动
        conditions.push(`event_time >= CURRENT_DATE`);

        const whereClause = conditions.length > 0
            ? 'WHERE ' + conditions.join(' AND ')
            : '';

        // 查询总数
        const countResult = await pool.query(
            `SELECT COUNT(*) as total FROM stock_monitor_events ${whereClause}`,
            values,
        );
        const total = parseInt(countResult.rows[0]?.total || '0', 10);

        // 查询数据
        const dataResult = await pool.query(
            `SELECT event_id, symbol, stock_name, event_type, level, summary, event_time, detail_url, raw_data_json
             FROM stock_monitor_events ${whereClause}
             ORDER BY event_time DESC
             LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
            [...values, limit, offset],
        );

        // 将数据库记录转换为前端需要的格式
        const events: MonitorEventItem[] = dataResult.rows.map((row: any) => {
            const raw = row.raw_data_json || {};
            // raw_data_json 可能是嵌套结构: { raw_data_json: { change_type: "4", ... } }
            const inner = raw.raw_data_json || raw;
            const changeType = inner.change_type || inner.change_type_code || raw.change_type || raw.change_type_code || '';
            return {
                event_id: row.event_id,
                symbol: row.symbol,
                stock_code: row.symbol.replace(/^(SH|SZ)/, ''),
                stock_name: row.stock_name,
                industry: '',
                change_type: changeType,
                change_type_name: CHANGE_TYPES[changeType] || row.summary || '',
                level: CHANGE_LEVELS[changeType] || row.level || 'L1',
                cycle: CHANGE_TYPE_CYCLES[changeType] || 'short',
                price: inner.price ?? raw.price ?? null,
                change_pct: inner.change_pct ?? inner.change_percent ?? raw.change_pct ?? raw.change_percent ?? null,
                volume_ratio: inner.volume_ratio ?? raw.volume_ratio ?? null,
                turnover_rate: inner.turnover_rate ?? raw.turnover_rate ?? null,
                event_time: row.event_time,
            };
        });

        // 数据拼接：批量获取行情和行业信息
        if (events.length > 0) {
            // 收集去重后的股票代码（纯6位数字）
            const uniqueCodes = [...new Set(events.map(e => e.stock_code))];
            try {
                // 批量获取行情（activity级别包含价格、涨跌幅、量比、换手率）
                const quotes = await EmQuoteService.getBatchQuotes(uniqueCodes, 'activity');
                const quoteMap = new Map<string, Record<string, any>>();
                for (const q of quotes) {
                    const code = q['股票代码'];
                    if (code) quoteMap.set(String(code), q);
                }

                // 批量获取行业信息（去重后最多limit个不同股票）
                const industryMap = new Map<string, string>();
                const batchSize = 10;
                for (let i = 0; i < uniqueCodes.length; i += batchSize) {
                    const batch = uniqueCodes.slice(i, i + batchSize);
                    const industryResults = await Promise.allSettled(
                        batch.map(code => EmService.getStockInfo(code))
                    );
                    for (let j = 0; j < industryResults.length; j++) {
                        const result = industryResults[j];
                        if (result.status === 'fulfilled') {
                            const industry = result.value['所属行业'] || result.value['行业板块'] || '';
                            if (industry) industryMap.set(batch[j], String(industry));
                        }
                    }
                }

                // 合并行情和行业数据到事件列表
                for (const event of events) {
                    const quote = quoteMap.get(event.stock_code);
                    if (quote) {
                        // 行情数据：优先使用实时行情
                        if (quote['最新价'] != null && event.price == null) {
                            event.price = Number(quote['最新价']);
                        }
                        if (quote['涨跌幅'] != null && event.change_pct == null) {
                            event.change_pct = Number(quote['涨跌幅']);
                        }
                        if (quote['量比'] != null && event.volume_ratio == null) {
                            event.volume_ratio = Number(quote['量比']);
                        }
                        if (quote['换手率'] != null && event.turnover_rate == null) {
                            event.turnover_rate = Number(quote['换手率']);
                        }
                    }
                    // 行业数据
                    const industry = industryMap.get(event.stock_code);
                    if (industry) {
                        event.industry = industry;
                    }
                }
            } catch (err) {
                console.warn('[StockMonitorService] 数据拼接失败，返回原始数据:', err);
            }
        }

        // 周期过滤（在应用层过滤，因为 cycle 不在数据库中）
        const filtered = cycle && cycle !== 'all'
            ? events.filter(e => e.cycle === cycle)
            : events;

        return {
            total: cycle && cycle !== 'all' ? filtered.length : total,
            events: filtered,
        };
    }

    /**
     * 查询指定股票的异动事件
     */
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

    /**
     * 获取异动统计概览
     * 当前：从数据库统计
     * 后续：可从 Redis 缓存中读取
     */
    static async getStats(): Promise<{
        total: number;
        limit_up: number;
        limit_down: number;
        rocket: number;
        dive: number;
    }> {
        const result = await pool.query(
            `SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '4' OR raw_data_json->>'change_type' = '4') as limit_up,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '8' OR raw_data_json->>'change_type' = '8') as limit_down,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '8193' OR raw_data_json->>'change_type' = '8193') as rocket,
                COUNT(*) FILTER (WHERE raw_data_json->'raw_data_json'->>'change_type' = '8194' OR raw_data_json->>'change_type' = '8194') as dive
             FROM stock_monitor_events
             WHERE event_time >= CURRENT_DATE`,
        );

        const row = result.rows[0] || {};
        return {
            total: parseInt(row.total || '0', 10),
            limit_up: parseInt(row.limit_up || '0', 10),
            limit_down: parseInt(row.limit_down || '0', 10),
            rocket: parseInt(row.rocket || '0', 10),
            dive: parseInt(row.dive || '0', 10),
        };
    }

    /**
     * 主动扫描异动（预留）
     * 后续实现：从东方财富批量行情接口拉取全市场数据，计算异动指标
     */
    static async scanAndDispatch(): Promise<void> {
        // TODO: 实现主动异动扫描引擎
        // 1. 调用东方财富 push2 批量行情接口
        // 2. 计算异动指标（涨停/跌停/火箭发射/加速下跌等）
        // 3. 命中规则则生成 MonitorEvent
        // 4. 存库 + 推送微信
        console.log('[StockMonitorService] scanAndDispatch - not implemented yet');
    }
}
