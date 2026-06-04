/**
 * 风口爆发股 API 控制器
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import { HotSectorService } from '../services/HotSectorService';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'crawler-int-2026-token';

function verifyInternalToken(req: Request): boolean {
    const token = req.headers['x-internal-token'];
    return token === INTERNAL_TOKEN;
}

export class HotSectorController {
    /**
     * GET /api/cn/hot-sectors
     * 获取风口爆发股分析结果
     *
     * Query params:
     *   - limit: 返回的风口板块数量，默认8
     */
    static async getHotSectors(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '8'), 10), 1), 20);
            const data = HotSectorService.getAnalysis(limit);

            if (!data) {
                createResponse(res, 404, '暂无风口爆发股数据，请先执行分析');
                return;
            }

            createResponse(res, 200, 'success', data);
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[HotSectorController] getHotSectors error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/internal/hot-sectors
     * 内部接口：接收外部 Python 分析引擎推送的风口爆发股数据
     *
     * Headers:
     *   - x-internal-token: 内部认证令牌
     *
     * Body: 完整的风口爆发股分析数据 JSON
     */
    static async pushHotSectors(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!verifyInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const data = req.body;
            if (!data || !data.hot_sectors || !Array.isArray(data.hot_sectors)) {
                createResponse(res, 400, '数据格式错误，需要包含 hot_sectors 数组');
                return;
            }

            HotSectorService.saveData(data);
            console.log(`[HotSectorController] 收到风口爆发股数据推送，共 ${data.hot_sectors.length} 个板块，更新时间: ${data.update_time || '未知'}`);
            createResponse(res, 200, 'success', { count: data.hot_sectors.length, update_time: data.update_time });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[HotSectorController] pushHotSectors error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * POST /api/cn/hot-sectors/refresh
     * 触发 Python 分析引擎重新执行风口爆发股分析
     */
    static async refreshAnalysis(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            console.log('[HotSectorController] 触发 Python 引擎重新分析...');
            const http = await import('http');
            const pythonPort = process.env.HOT_SECTOR_ENGINE_PORT || '5001';

            const refreshPython = (): Promise<any> => {
                return new Promise((resolve, reject) => {
                    const req = http.request({
                        hostname: 'localhost',
                        port: parseInt(pythonPort),
                        path: '/api/refresh',
                        method: 'POST',
                        timeout: 300000, // 分析可能需要几分钟
                    }, (resp) => {
                        let body = '';
                        resp.on('data', (chunk: Buffer) => body += chunk.toString());
                        resp.on('end', () => {
                            try { resolve(JSON.parse(body)); }
                            catch { resolve({ raw: body }); }
                        });
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                    req.end();
                });
            };

            const result = await refreshPython();
            createResponse(res, 200, 'success', {
                count: result.hot_sectors?.length || 0,
                update_time: result.update_time || '',
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[HotSectorController] refreshAnalysis error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
