const cheerio = require('cheerio');

async function testFetch() {
    const url = 'https://basic.10jqka.com.cn/48/886009/';
    
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
        
        // 策略1：查找 input.topStock
        const topStockAttr = $('input.topStock').attr('topStock') || '';
        console.log('\n策略1 - input.topStock:', topStockAttr);
        
        // 策略2：查找 span.hltip
        console.log('\n策略2 - span.hltip:');
        $('span.hltip').each((i, el) => {
            const text = $(el).text().trim();
            if (text.includes('龙头股')) {
                console.log('找到龙头股标签:', text);
                const parent = $(el).closest('td');
                parent.find('a.jumpto').each((j, a) => {
                    const code = $(a).attr('code') || '';
                    const name = $(a).text().trim();
                    console.log(`  - 龙头股: ${name} (${code})`);
                });
            }
        });
        
        // 策略3：查找表格中的"龙头股"行
        console.log('\n策略3 - 表格中的龙头股:');
        $('table.m_table, table.boardinfotable, div.boardinfo table').find('tr, th, td').each((i, el) => {
            const text = $(el).text().trim();
            if (text.includes('龙头股')) {
                console.log('找到龙头股行:', text);
                const row = $(el).closest('tr');
                row.find('a').each((j, a) => {
                    const href = $(a).attr('href') || '';
                    const name = $(a).text().trim();
                    const codeMatch = href.match(/(\d{6})/);
                    const code = codeMatch ? codeMatch[1] : '';
                    console.log(`  - 龙头股链接: ${name} (${code}) - href: ${href}`);
                });
            }
        });
        
        // 策略4：查找所有包含股票代码的链接
        console.log('\n策略4 - 所有股票链接（前10个）:');
        let count = 0;
        $('a').each((i, a) => {
            const href = $(a).attr('href') || '';
            const name = $(a).text().trim();
            const codeMatch = href.match(/(\d{6})/);
            if (codeMatch && count < 10) {
                console.log(`  - ${name} (${codeMatch[1]}) - ${href}`);
                count++;
            }
        });
        
        // 查找所有input元素
        console.log('\n所有input元素:');
        $('input').each((i, el) => {
            const attrs = $(el).attr();
            console.log(`  - input: ${JSON.stringify(attrs)}`);
        });
        
    } catch (err) {
        console.error('爬取失败:', err);
    }
}

testFetch();