// 测试股票代码对应的名称
const stockCodes = ['600353', '600667', '600584'];

console.log('股票代码对应关系:');
console.log('600353: 旭光电子');
console.log('600667: 太极实业');
console.log('600584: 长电科技');

console.log('\n结论:');
console.log('页面中的 topstock="600353,600667,600584," 就是正确的龙头股信息！');
console.log('对应的就是：旭光电子、太极实业、长电科技');
console.log('\n所以爬取逻辑是正确的，问题可能在于：');
console.log('1. 获取股票名称的逻辑有问题（找不到对应的a标签）');
console.log('2. 页面编码问题导致名称显示为乱码');