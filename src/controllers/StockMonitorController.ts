/**
 * 个股异动监测 API 控制器
 *
 * 提供前端页面所需的异动数据查询接口
 * 数据来源：StockMonitorService（当前从数据库查询，后续接入主动监测引擎）
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import { StockMonitorService } from '../services/StockMonitorService';

export class StockMonitorController {
    /**
     * GET /api/cn/monitor/events
     * 查询异动事件列表
     *
     * Query params:
     *   - cycle: 周期筛选 (all/short/mid/long)，默认 all
     *   - change_type: 异动类型代码筛选，如 4=涨停
     *   - stock_code: 指定股票代码
     *   - limit: 每页条数，默认 20
     *   - offset: 偏移量，默认 0
     */
    static async getEvents(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const cycle = String(req.query.cycle || 'all');
            const change_type = req.query.change_type ? String(req.query.change_type) : undefined;
            const stock_code = req.query.stock_code ? String(req.query.stock_code) : undefined;
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 100);
            const offset = Math.max(parseInt(String(req.query.offset || '0'), 10), 0);

            const result = await StockMonitorService.getEvents({
                cycle,
                change_type,
                stock_code,
                limit,
                offset,
            });

            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[StockMonitorController] getEvents error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/monitor/events/:stockCode
     * 查询指定股票的异动事件
     */
    static async getEventsByStock(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const stockCode = String(req.params.stockCode || '');
            if (!stockCode) {
                createResponse(res, 400, 'Missing stockCode');
                return;
            }

            const cycle = String(req.query.cycle || 'all');
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10), 1), 100);

            const events = await StockMonitorService.getEventsByStockCode(stockCode, { cycle, limit });

            createResponse(res, 200, 'success', { events });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[StockMonitorController] getEventsByStock error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/cn/monitor/stats
     * 获取异动统计概览
     */
    static async getStats(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const stats = await StockMonitorService.getStats();
            createResponse(res, 200, 'success', stats);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[StockMonitorController] getStats error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
