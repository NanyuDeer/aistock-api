import { StockInfoService, StockInfoType, type StockInfoPushWindow } from './StockInfoService';
import { WechatPushService } from './WechatPushService';

export interface StockInfoPushRequest {
    window?: string;
    info_type?: string;
    from?: string;
    to?: string;
}

export interface StockInfoPushResult {
    candidates: number;
    matched_users: number;
    sent: number;
    skipped: number;
    failed: number;
    results: any[];
}

function parseDate(value: unknown, field: string): Date {
    const raw = String(value || '').trim();
    const date = new Date(raw);
    if (!raw || Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid datetime`);
    return date;
}

function getDefaultWindowRange(windowName: string): { from: Date; to: Date } {
    const now = new Date();
    if (windowName === 'morning') {
        const to = now;
        const from = new Date(to.getTime() - 18 * 60 * 60 * 1000);
        return { from, to };
    }
    if (windowName === 'closing') {
        const to = now;
        const from = new Date(to);
        from.setHours(9, 30, 0, 0);
        return { from, to };
    }
    throw new Error('window must be morning or closing');
}

export class StockInfoPushService {
    static resolveWindows(body: StockInfoPushRequest): StockInfoPushWindow[] {
        const defaults = getDefaultWindowRange(String(body.window || 'morning').trim());
        const from = body.from ? parseDate(body.from, 'from') : defaults.from;
        const to = body.to ? parseDate(body.to, 'to') : defaults.to;
        const types: StockInfoType[] = ['announcement', 'news'];
        return types.map(info_type => ({ info_type, from, to }));
    }

    static async push(body: StockInfoPushRequest): Promise<StockInfoPushResult> {
        const windows = StockInfoPushService.resolveWindows(body);
        const summary: StockInfoPushResult = {
            candidates: 0,
            matched_users: 0,
            sent: 0,
            skipped: 0,
            failed: 0,
            results: [],
        };

        for (const window of windows) {
            const candidates = await StockInfoService.getPushCandidates(window);
            summary.candidates += candidates.length;

            for (const judgement of candidates) {
                const result = await WechatPushService.dispatchStockInfoJudgement({
                    id: judgement.id,
                    symbol: judgement.symbol,
                    stock_name: judgement.stock_name,
                    info_type: judgement.info_type,
                    title: judgement.title,
                    url: judgement.url,
                    published_at: judgement.published_at,
                    ai_impact: judgement.ai_impact,
                    ai_horizon: judgement.ai_horizon,
                    ai_keywords: judgement.ai_keywords,
                    ai_summary: judgement.ai_summary,
                });
                summary.matched_users += result.matched_users;
                summary.sent += result.sent;
                summary.skipped += result.skipped;
                summary.failed += result.failed;
                summary.results.push({ id: judgement.id, symbol: judgement.symbol, ...result });
            }
        }

        return summary;
    }
}
