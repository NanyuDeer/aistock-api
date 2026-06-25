import { getStockIdentity } from '../utils/stock';
import { formatToChinaTime } from '../utils/datetime';
import { eastmoneyThrottler } from '../utils/throttlers';
import { sessionFetch } from '../utils/httpAgent';

export type QuoteLevel = 'core' | 'activity' | 'fundamental';

const VOLUME_FIELDS = new Set(['f47', 'f49', 'f161']);

export class EmQuoteService {
    private static readonly BASE_URL = 'https://push2.eastmoney.com/api/qt/stock/get';
    private static readonly CORE_FIELDS = 'f57,f58,f43,f170,f86';
    private static readonly ACTIVITY_FIELDS = 'f57,f58,f43,f71,f170,f169,f47,f48,f168,f50,f44,f45,f46,f60,f51,f52,f49,f161,f86';
    private static readonly FUNDAMENTAL_FIELDS = 'f57,f58,f55,f162,f92,f167,f183,f184,f105,f185,f186,f187,f173,f188,f84,f85,f116,f117,f190,f86';

    private static readonly LEVEL_FIELDS: Record<QuoteLevel, string> = {
        'core': EmQuoteService.CORE_FIELDS,
        'activity': EmQuoteService.ACTIVITY_FIELDS,
        'fundamental': EmQuoteService.FUNDAMENTAL_FIELDS,
    };

    private static readonly CODE_NAME_MAP: Record<string, string> = {
        'f57': '股票代码', 'f58': '股票简称', 'f43': '最新价', 'f86': '更新时间',
        'f44': '最高价', 'f45': '最低价', 'f60': '昨收价', 'f46': '今开价',
        'f51': '涨停价', 'f52': '跌停价', 'f169': '涨跌额', 'f170': '涨跌幅',
        'f71': '均价', 'f50': '量比', 'f47': '成交量', 'f48': '成交额',
        'f168': '换手率', 'f161': '内盘', 'f49': '外盘', 'f167': '市净率',
        'f173': 'ROE', 'f183': '总营收', 'f184': '总营收-同比', 'f185': '净利润-同比',
        'f186': '毛利率', 'f187': '净利率', 'f188': '负债率', 'f190': '每股未分配利润',
        'f162': '动态市盈率', 'f92': '每股净资产', 'f55': '季度收益', 'f105': '净利润',
        'f84': '总股本', 'f85': '流通股', 'f116': '总市值', 'f117': '流通市值',
    };

    static async getQuote(symbol: string, level: QuoteLevel = 'core'): Promise<Record<string, any>> {
        const identity = getStockIdentity(symbol);
        const { eastmoneyId } = identity;
        const fields = this.LEVEL_FIELDS[level];
        const url = `${this.BASE_URL}?invt=2&fltt=2&fields=${fields}&secid=${eastmoneyId}.${symbol}`;

        await eastmoneyThrottler.throttle();

        const response = await sessionFetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Referer': 'https://quote.eastmoney.com/',
            },
        });

        if (!response.ok) throw new Error(`东方财富行情接口请求失败: ${response.status}`);

        const json: any = await response.json();
        const innerData = json.data;
        if (!innerData) throw new Error('东方财富行情接口返回数据格式异常');

        const result: Record<string, any> = {};
        for (const [key, name] of Object.entries(this.CODE_NAME_MAP)) {
            if (key in innerData) {
                let value = innerData[key];
                if (VOLUME_FIELDS.has(key) && typeof value === 'number') value = value * 100;
                else if (key === 'f86' && typeof value === 'number') value = formatToChinaTime(value * 1000);
                result[name] = value;
            }
        }
        return result;
    }

    static async getBatchQuotes(symbols: string[], level: QuoteLevel = 'core'): Promise<Record<string, any>[]> {
        const results = await Promise.allSettled(symbols.map(symbol => this.getQuote(symbol, level)));
        return results.map((result, index) => {
            if (result.status === 'fulfilled') return result.value;
            return { '股票代码': symbols[index], '错误': result.reason?.message || '查询失败' };
        });
    }
}
