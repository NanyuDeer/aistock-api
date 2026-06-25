const cheerio = require('cheerio');

async function testFetch() {
    const url = 'https://basic.10jqka.com.cn/48/886009/?code=886009&marketid=48';
    
    try {
        console.log('开始爬取页面:', url);
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            }
        });
        
        const html = await response.text();
        console.log('页面长度:', html.length);
        
        const $ = cheerio.load(html);
        
        // 查找所有包含"龙头股"的文本
        console.log('\n查找所有包含"龙头股"的文本:');
        $('*').each((i, el) => {
            const text = $(el).text().trim();
            if (text.includes('龙头股') && text.length < 100) {
                console.log(`  - ${text}`);
            }
        });
        
        // 查找所有input.topStock元素
        console.log('\n查找所有input.topStock元素:');
        $('input.topStock').each((i, el) => {
            const attrs = $(el).attr();
            console.log(`  - input.topStock #${i}:`, JSON.stringify(attrs));
            const topstock = $(el).attr('topstock') || $(el).attr('topStock');
            if (topstock) {
                console.log(`    龙头股代码: ${topstock}`);
                const codes = topstock.split(',').filter(c => c);
                console.log(`    解析后的代码:`, codes);
                
                // 查找对应的股票名称
                for (const code of codes) {
                    const nameEl = $(`a[code="${code}"]`).first();
                    const name = nameEl.text().trim();
                    console.log(`    - ${code}: ${name || '未找到名称'}`);
                    
                    // 也尝试从href中查找
                    const hrefEl = $(`a[href*="${code}"]`).first();
                    const hrefName = hrefEl.text().trim();
                    console.log(`    - ${code} (href): ${hrefName || '未找到名称'}`);
                }
            }
        });
        
        // 查找表格中的"龙头股"行
        console.log('\n查找表格中的"龙头股"行:');
        $('table').each((i, table) => {
            $(table).find('tr').each((j, row) => {
                const rowText = $(row).text().trim();
                if (rowText.includes('龙头股')) {
                    console.log(`  - 表格${i}, 行${j}:`, rowText);
                    $(row).find('a').each((k, a) => {
                        const href = $(a).attr('href') || '';
                        const name = $(a).text().trim();
                        const codeMatch = href.match(/(\d{6})/);
                        if (codeMatch) {
                            console.log(`    - ${name} (${codeMatch[1]})`);
                        }
                    });
                }
            });
        });
        
        // 查找所有包含股票代码的链接（前20个）
        console.log('\n查找所有包含股票代码的链接（前20个）:');
        let count = 0;
        $('a').each((i, a) => {
            const href = $(a).attr('href') || '';
            const name = $(a).text().trim();
            const codeMatch = href.match(/(\d{6})/);
            if (codeMatch && count < 20 && name.length > 0 && name.length < 20) {
                console.log(`  - ${name} (${codeMatch[1]}) - ${href}`);
                count++;
            }
        });
        
        // 查找"旭光电子"、"太极实业"、"长电科技"的位置
        console.log('\n查找"旭光电子"、"太极实业"、"长电科技"的位置:');
        const targetStocks = ['旭光电子', '太极实业', '长电科技'];
        for (const stockName of targetStocks) {
            $('a').each((i, a) => {
                const name = $(a).text().trim();
                if (name === stockName) {
                    const href = $(a).attr('href') || '';
                    const codeMatch = href.match(/(\d{6})/);
                    const code = $(a).attr('code') || '';
                    console.log(`  - ${stockName}: href=${href}, code=${codeMatch ? codeMatch[1] : code}`);
                }
            });
        }
        
    } catch (err) {
        console.error('爬取失败:', err);
    }
}

testFetch();