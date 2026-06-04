import { Request, Response, NextFunction } from 'express';

type PotentialPushRecord = {
    push_id: string;
    push_batch_id: string;
    push_date: string;
    stock_code: string;
    stock_name: string;
    theme: string;
    reason: string;
    strategy_name: string;
    push_price: number;
    latest_price: number;
    latest_trade_date: string;
};

const mockRecords: PotentialPushRecord[] = [
    {
        push_id: 'hotspot_20260603_300750',
        push_batch_id: 'hotspot_20260603',
        push_date: '2026-06-03',
        stock_code: '300750',
        stock_name: '宁德时代',
        theme: '新能源',
        reason: '新能源产业链资金回流，龙头标的关注度提升',
        strategy_name: '风口潜力股',
        push_price: 198.20,
        latest_price: 207.85,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260603_002371',
        push_batch_id: 'hotspot_20260603',
        push_date: '2026-06-03',
        stock_code: '002371',
        stock_name: '北方华创',
        theme: '半导体设备',
        reason: '半导体设备板块放量，国产替代主线活跃',
        strategy_name: '风口潜力股',
        push_price: 318.60,
        latest_price: 334.10,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260603_600406',
        push_batch_id: 'hotspot_20260603',
        push_date: '2026-06-03',
        stock_code: '600406',
        stock_name: '国电南瑞',
        theme: '电力设备',
        reason: '电网投资预期升温，电力设备板块走强',
        strategy_name: '风口潜力股',
        push_price: 27.04,
        latest_price: 27.68,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260603_688041',
        push_batch_id: 'hotspot_20260603',
        push_date: '2026-06-03',
        stock_code: '688041',
        stock_name: '海光信息',
        theme: 'AI算力',
        reason: '算力基础设施需求提升，AI芯片方向热度延续',
        strategy_name: '风口潜力股',
        push_price: 87.50,
        latest_price: 84.12,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260603_600519',
        push_batch_id: 'hotspot_20260603',
        push_date: '2026-06-03',
        stock_code: '600519',
        stock_name: '贵州茅台',
        theme: '消费龙头',
        reason: '消费白马估值修复，机构资金关注度回升',
        strategy_name: '风口潜力股',
        push_price: 1580.00,
        latest_price: 1572.30,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260602_601012',
        push_batch_id: 'hotspot_20260602',
        push_date: '2026-06-02',
        stock_code: '601012',
        stock_name: '隆基绿能',
        theme: '光伏',
        reason: '光伏产业链阶段性反弹，组件龙头弹性较高',
        strategy_name: '风口潜力股',
        push_price: 18.65,
        latest_price: 19.48,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260602_000977',
        push_batch_id: 'hotspot_20260602',
        push_date: '2026-06-02',
        stock_code: '000977',
        stock_name: '浪潮信息',
        theme: 'AI服务器',
        reason: 'AI服务器订单预期增强，算力链条活跃',
        strategy_name: '风口潜力股',
        push_price: 45.20,
        latest_price: 47.86,
        latest_trade_date: '2026-06-03',
    },
    {
        push_id: 'hotspot_20260602_002230',
        push_batch_id: 'hotspot_20260602',
        push_date: '2026-06-02',
        stock_code: '002230',
        stock_name: '科大讯飞',
        theme: 'AI应用',
        reason: '大模型应用落地预期增强，教育与办公方向活跃',
        strategy_name: '风口潜力股',
        push_price: 42.10,
        latest_price: 40.92,
        latest_trade_date: '2026-06-03',
    },
];

function withReturn(record: PotentialPushRecord) {
    const returnPct = record.push_price > 0
        ? ((record.latest_price - record.push_price) / record.push_price) * 100
        : 0;

    return {
        ...record,
        return_pct: Number(returnPct.toFixed(2)),
    };
}

function buildSummary(records: ReturnType<typeof withReturn>[]) {
    const total = records.length;
    const winners = records.filter(item => item.return_pct > 0).length;
    const averageReturn = total
        ? records.reduce((sum, item) => sum + item.return_pct, 0) / total
        : 0;
    const best = records.slice().sort((a, b) => b.return_pct - a.return_pct)[0] || null;
    const worst = records.slice().sort((a, b) => a.return_pct - b.return_pct)[0] || null;

    return {
        total,
        winners,
        win_rate: total ? Number(((winners / total) * 100).toFixed(2)) : 0,
        average_return_pct: Number(averageReturn.toFixed(2)),
        best,
        worst,
    };
}

export class PotentialStockPushController {
    static async getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { date, theme, keyword } = req.query;
            const filtered = mockRecords
                .filter(item => !date || item.push_date === String(date))
                .filter(item => !theme || item.theme === String(theme))
                .filter(item => {
                    if (!keyword) return true;
                    const text = String(keyword).trim();
                    return item.stock_code.includes(text)
                        || item.stock_name.includes(text)
                        || item.theme.includes(text);
                })
                .map(withReturn)
                .sort((a, b) => {
                    if (a.push_date !== b.push_date) return b.push_date.localeCompare(a.push_date);
                    return b.return_pct - a.return_pct;
                });

            res.json({
                code: 200,
                message: 'success',
                data: {
                    items: filtered,
                    summary: buildSummary(filtered),
                },
            });
        } catch (err) {
            next(err);
        }
    }

    static async getRanking(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { date } = req.query;
            const items = mockRecords
                .filter(item => !date || item.push_date === String(date))
                .map(withReturn);

            const topGainers = items.slice().sort((a, b) => b.return_pct - a.return_pct).slice(0, 10);
            const topLosers = items.slice().sort((a, b) => a.return_pct - b.return_pct).slice(0, 10);

            res.json({
                code: 200,
                message: 'success',
                data: {
                    summary: buildSummary(items),
                    top_gainers: topGainers,
                    top_losers: topLosers,
                    batches: Array.from(new Set(mockRecords.map(item => item.push_batch_id))).sort().reverse(),
                },
            });
        } catch (err) {
            next(err);
        }
    }
}
