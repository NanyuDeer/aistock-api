const cheerio = require('cheerio');

async function testFindNames() {
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
        
        // 测试策略1：从 topstock 提取代码，然后从页面中查找名称
        const topstock = $('input.topStock').attr('topstock') || $('input.topStock').attr('topStock');
        if (topstock) {
            console.log('\n策略1: topstock字段:', topstock);
            const codes = topstock.split(',').filter(c => c);
            
            for (const code of codes) {
                console.log(`\n查找股票 ${code} 的名称:`);
                
                // 方法1: a[code="${code}"]
                const nameEl1 = $(`a[code="${code}"]`).first();
                const name1 = nameEl1.text().trim();
                console.log(`  方法1 (a[code="${code}"]): ${name1 || '未找到'}`);
                
                // 方法2: a[href*="${code}"]
                const nameEl2 = $(`a[href*="${code}"]`).first();
                const name2 = nameEl2.text().trim();
                const href2 = nameEl2.attr('href') || '';
                console.log(`  方法2 (a[href*="${code}"]): ${name2 || '未找到'} - href: ${href2}`);
                
                // 方法3: 从表格中查找
                $('table').find('a').each((i, a) => {
                    const href = $(a).attr('href') || '';
                    const name = $(a).text().trim();
                    if (href.includes(code) && name.length > 0 && name.length < 20) {
                        console.log(`  方法3 (表格): ${name} - href: ${href}`);
                    }
                });
                
                // 方法4: 从整个页面查找
                $('a').each((i, a) => {
                    const href = $(a).attr('href') || '';
                    const name = $(a).text().trim();
                    if (href.includes(code) && name.length > 0 && name.length < 20 && !href.includes('news')) {
                        console.log(`  方法4 (全页面): ${name} - href: ${href}`);
                        return false; // 只显示第一个
                    }
                });
            }
        }
        
    } catch (err) {
        console.error('爬取失败:', err);
    }
}

testFindNames();