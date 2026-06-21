import assert from 'node:assert/strict';
import { extractStockCodes, loadStockNameMap } from '../src/services/HotKeywordDetectorService';
// enrichFeishuStockCodes import will be added in Task 5

function runTest(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

async function runAsyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}`);
        throw err;
    }
}

async function main(): Promise<void> {
    // ===== extractStockCodes 测试 =====

    // 正则匹配（不依赖 name map）
    runTest('extracts stock codes from "名称(代码)" pattern', () => {
        const stocks = extractStockCodes('中际旭创(300308)发布新品');
        assert.ok(stocks.has('300308'), '应提取到 300308');
        assert.equal(stocks.get('300308'), '中际旭创');
    });

    runTest('extracts bare stock codes', () => {
        const stocks = extractStockCodes('关注 300308 和 600519 的走势');
        assert.ok(stocks.has('300308'));
        assert.ok(stocks.has('600519'));
    });

    // 名称匹配（依赖 loadStockNameMap，需要 Tushare token）
    await runAsyncTest('extracts stock codes from company name only (requires Tushare)', async () => {
        await loadStockNameMap();
        const stocks = extractStockCodes('宁德时代发布新产品，产能扩张');
        assert.ok(stocks.has('300750'), '应通过公司名称匹配到 300750');
    });

    console.log('\n所有测试通过');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
