/**
 * 生成10个指定风口板块的mock数据
 * 运行: node generate-mock-sectors.js
 */

const fs = require('fs');
const path = require('path');

// ==================== 板块定义 ====================
const SECTORS = [
  {
    name: 'CPO',
    frequency: 9, avgChange: 2.85, todayChange: 3.18, amountTrend: 12.5, score: 72,
    driver: 'AI算力需求爆发，800G/1.6T光模块放量，CPO共封装方案加速落地',
    persistence: '中期(1-2周)', persistenceReason: 'AI算力持续扩张，光模块订单能见度高，资金持续流入',
    transferDirection: '中游→下游', transferReason: '光模块需求向下游通信设备和数据中心传导，需求端拉动效应明显',
    riskWarning: '关注海外AI资本开支变化，缩量需警惕',
    relatedIndustries: ['通信设备', '光学光电子', '元件'],
    industryData: [
      { name: '通信设备', change: 2.1, up_count: 8, down_count: 3, leading_stock: '中际旭创' },
      { name: '光学光电子', change: 1.8, up_count: 6, down_count: 4, leading_stock: '华工科技' },
      { name: '元件', change: 1.5, up_count: 5, down_count: 5, leading_stock: '光迅科技' },
    ],
    stocks: [
      { code: '300308', name: '中际旭创', industry: '通信设备', score: 92, reason: '全球800G/1.6T光模块绝对龙头，市占率超30%；CPO共封装方案核心供应商，技术领先同业1-2年', reasonTag: '龙头', inConcept: true, price: 184.62, changePct: 3.18 },
      { code: '002281', name: '光迅科技', industry: '通信设备', score: 78, reason: '国内光通信器件龙头，800G光模块量产交付，硅光技术突破', reasonTag: '概念共振', inConcept: true, price: 68.35, changePct: 2.56 },
      { code: '000988', name: '华工科技', industry: '光学光电子', score: 75, reason: '光通信+激光双主业，800G硅光模块量产，CPO技术布局领先', reasonTag: '概念共振', inConcept: true, price: 42.18, changePct: 2.12 },
      { code: '300620', name: '光库科技', industry: '光学光电子', score: 68, reason: '光纤器件龙头，薄膜铌酸锂调制器量产，CPO光互联核心器件供应商', reasonTag: '量价齐升', inConcept: true, price: 85.60, changePct: 1.89 },
    ],
    upstream: [
      { name: '电子化学品', sourceIndustry: '光学光电子', factor: 0.58 },
      { name: '半导体', sourceIndustry: '通信设备', factor: 0.49 },
    ],
    downstream: [
      { name: '消费电子', sourceIndustry: '通信设备', factor: 0.45 },
      { name: '计算机设备', sourceIndustry: '通信设备', factor: 0.40 },
    ],
    upstreamStocks: [
      { code: '603078', name: '江化微', industry: '电子化学品', score: 55, reason: '湿电子化学品+光刻胶，光模块上游材料供应商', price: 41.56, changePct: 3.21, factor: 0.58, sourceIndustry: '光学光电子' },
      { code: '300346', name: '南大光电', industry: '电子化学品', score: 48, reason: '光刻胶+MO源，光通信上游关键材料', price: 57.03, changePct: 2.15, factor: 0.58, sourceIndustry: '光学光电子' },
    ],
    downstreamStocks: [
      { code: '600050', name: '中国联通', industry: '通信设备', score: 42, reason: '算力网络建设提速，数据中心CPO方案需求增长', price: 6.85, changePct: 1.12, factor: 0.45, sourceIndustry: '通信设备' },
      { code: '000063', name: '中兴通讯', industry: '通信设备', score: 45, reason: '5G+算力基础设施，CPO方案下游应用核心厂商', price: 32.50, changePct: 1.85, factor: 0.45, sourceIndustry: '通信设备' },
    ],
    leadingStock: { name: '中际旭创', code: '300308', industry: '通信设备', price: 184.62, changePct: 3.18, reason: '全球800G/1.6T光模块绝对龙头，市占率超30%；1.6T硅光模块已量产，CPO技术与英伟达深度绑定；CPO共封装光学方案核心供应商，技术领先同业1-2年' },
  },
  {
    name: 'PCB',
    frequency: 8, avgChange: 2.35, todayChange: 3.56, amountTrend: 8.6, score: 68,
    driver: 'AI算力PCB需求爆发，高端HDI产能紧缺，英伟达GB200/GB300放量',
    persistence: '中期(1-2周)', persistenceReason: 'AI服务器PCB需求持续高景气，高端产能释放量价齐升',
    transferDirection: '中游→下游', transferReason: 'PCB需求向下游消费电子和通信设备传导',
    riskWarning: '关注产能释放节奏，竞争加剧风险',
    relatedIndustries: ['元件', '光学光电子', '消费电子'],
    industryData: [
      { name: '元件', change: 2.8, up_count: 7, down_count: 3, leading_stock: '胜宏科技' },
      { name: '光学光电子', change: 1.5, up_count: 5, down_count: 4, leading_stock: '东山精密' },
      { name: '消费电子', change: 1.2, up_count: 4, down_count: 5, leading_stock: '东山精密' },
    ],
    stocks: [
      { code: '300476', name: '胜宏科技', industry: '元件', score: 88, reason: '全球AI算力PCB市场份额第一，英伟达GB200/GB300主力供应商；全球首批6阶24层HDI量产企业', reasonTag: '龙头', inConcept: true, price: 168.50, changePct: 3.56 },
      { code: '002384', name: '东山精密', industry: '元件', score: 80, reason: 'PCB+FPC双龙头，AI服务器高阶HDI产能扩张，深度绑定海外大客户', reasonTag: '概念共振', inConcept: true, price: 35.80, changePct: 2.85 },
      { code: '603256', name: '宏和科技', industry: '元件', score: 62, reason: '电子级玻璃纤维布龙头，PCB上游核心材料供应商，高端产品国产替代', reasonTag: '量价齐升', inConcept: true, price: 18.65, changePct: 2.12 },
      { code: '603259', name: '圣泉集团', industry: '化学制品', score: 58, reason: '酚醛树脂+电子化学品双主业，PCB用树脂材料国产替代先锋', reasonTag: '概念共振', inConcept: true, price: 22.30, changePct: 1.68 },
    ],
    upstream: [
      { name: '电子化学品', sourceIndustry: '元件', factor: 0.55 },
      { name: '金属新材料', sourceIndustry: '元件', factor: 0.40 },
    ],
    downstream: [
      { name: '通信设备', sourceIndustry: '消费电子', factor: 0.42 },
      { name: '计算机设备', sourceIndustry: '消费电子', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '603078', name: '江化微', industry: '电子化学品', score: 52, reason: '湿电子化学品，PCB制造关键材料供应商', price: 41.56, changePct: 2.85, factor: 0.55, sourceIndustry: '元件' },
      { code: '300346', name: '南大光电', industry: '电子化学品', score: 46, reason: '光刻胶+电子特气，PCB光刻工艺核心材料', price: 57.03, changePct: 1.92, factor: 0.55, sourceIndustry: '元件' },
    ],
    downstreamStocks: [
      { code: '000063', name: '中兴通讯', industry: '通信设备', score: 40, reason: '5G基站+算力服务器，PCB下游核心应用', price: 32.50, changePct: 1.35, factor: 0.42, sourceIndustry: '消费电子' },
      { code: '002415', name: '海康威视', industry: '计算机设备', score: 38, reason: 'AI安防+边缘计算，高端PCB需求增长', price: 38.20, changePct: 1.15, factor: 0.38, sourceIndustry: '消费电子' },
    ],
    leadingStock: { name: '胜宏科技', code: '300476', industry: '元件', price: 168.50, changePct: 3.56, reason: '全球AI算力PCB市场份额第一，英伟达GB200/GB300主力供应商；全球首批6阶24层HDI量产企业，良率85%+；AI相关收入占比65%+' },
  },
  {
    name: '玻璃基板',
    frequency: 7, avgChange: 3.12, todayChange: 8.45, amountTrend: 15.2, score: 75,
    driver: 'TGV玻璃通孔技术突破，先进封装玻璃基板国产替代加速',
    persistence: '中期(1-2周)', persistenceReason: '先进封装玻璃基板技术突破，国产替代空间巨大，资金持续关注',
    transferDirection: '上游→中游', transferReason: '上游玻璃材料和设备先行启动，向中游封装传导',
    riskWarning: '技术路线尚在验证期，关注量产进度',
    relatedIndustries: ['光学光电子', '半导体', '元件'],
    industryData: [
      { name: '光学光电子', change: 3.5, up_count: 6, down_count: 3, leading_stock: '沃格光电' },
      { name: '半导体', change: 2.2, up_count: 5, down_count: 4, leading_stock: '凯盛科技' },
      { name: '元件', change: 1.8, up_count: 4, down_count: 5, leading_stock: '帝尔激光' },
    ],
    stocks: [
      { code: '603773', name: '沃格光电', industry: '光学光电子', score: 90, reason: '国内TGV玻璃通孔全制程绝对龙头，唯一实现半导体玻璃基板小批量供货；最小孔径3μm、深径比150:1', reasonTag: '龙头', inConcept: true, price: 106.80, changePct: 8.45 },
      { code: '600707', name: '彩虹股份', industry: '光学光电子', score: 72, reason: '国内液晶玻璃基板龙头，高世代线产能国内第一，玻璃基板技术积累深厚', reasonTag: '概念共振', inConcept: true, price: 12.85, changePct: 5.62 },
      { code: '600552', name: '凯盛科技', industry: '半导体', score: 68, reason: '中国建材旗下，UTG超薄玻璃+显示模组双主业，玻璃基板材料核心标的', reasonTag: '概念共振', inConcept: true, price: 18.92, changePct: 4.35 },
      { code: '300776', name: '帝尔激光', industry: '专用设备', score: 65, reason: '激光加工设备龙头，玻璃基板激光钻孔/切割设备核心供应商', reasonTag: '量价齐升', inConcept: true, price: 65.30, changePct: 3.82 },
    ],
    upstream: [
      { name: '建筑材料', sourceIndustry: '光学光电子', factor: 0.52 },
      { name: '专用设备', sourceIndustry: '半导体', factor: 0.48 },
    ],
    downstream: [
      { name: '通信设备', sourceIndustry: '半导体', factor: 0.42 },
      { name: '消费电子', sourceIndustry: '光学光电子', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '600586', name: '金晶科技', industry: '建筑材料', score: 45, reason: '超白玻璃原片供应商，玻璃基板上游核心材料', price: 8.25, changePct: 2.15, factor: 0.52, sourceIndustry: '光学光电子' },
      { code: '601633', name: '拓荆科技', industry: '专用设备', score: 42, reason: '半导体薄膜沉积设备，玻璃基板工艺设备相关', price: 285.60, changePct: 1.85, factor: 0.48, sourceIndustry: '半导体' },
    ],
    downstreamStocks: [
      { code: '300308', name: '中际旭创', industry: '通信设备', score: 48, reason: '1.6T光模块玻璃载板验证通过，玻璃基板下游应用核心', price: 184.62, changePct: 2.15, factor: 0.42, sourceIndustry: '半导体' },
      { code: '002371', name: '北方华创', industry: '半导体', score: 44, reason: '半导体设备龙头，先进封装设备受益玻璃基板趋势', price: 358.20, changePct: 1.56, factor: 0.38, sourceIndustry: '半导体' },
    ],
    leadingStock: { name: '沃格光电', code: '603773', industry: '光学光电子', price: 106.80, changePct: 8.45, reason: '国内TGV玻璃通孔全制程绝对龙头，唯一实现半导体玻璃基板小批量供货；1.6T光模块玻璃载板通过中际旭创、华为验证' },
  },
  {
    name: '培育钻石',
    frequency: 6, avgChange: 1.85, todayChange: 5.62, amountTrend: 6.8, score: 55,
    driver: 'CVD金刚石散热片量产卡位AI芯片散热刚需，培育钻石消费升级',
    persistence: '短期(1-3天)', persistenceReason: '培育钻石消费端需求波动，CVD散热片量产进度待验证',
    transferDirection: '上游→中游', transferReason: '上游原材料端先行启动，向中游加工传导',
    riskWarning: '消费端需求不确定性，关注CVD散热片订单落地',
    relatedIndustries: ['贵金属', '小金属', '化学制品'],
    industryData: [
      { name: '贵金属', change: 2.5, up_count: 4, down_count: 2, leading_stock: '黄河旋风' },
      { name: '小金属', change: 1.8, up_count: 3, down_count: 3, leading_stock: '力量钻石' },
      { name: '化学制品', change: 0.8, up_count: 2, down_count: 4, leading_stock: '--' },
    ],
    stocks: [
      { code: '600172', name: '黄河旋风', industry: '贵金属', score: 82, reason: '国内唯一HPHT+CVD双工艺金刚石企业；国内首条8英寸CVD金刚石热沉片2026年量产，热导率2000W+/m·K', reasonTag: '龙头', inConcept: true, price: 13.30, changePct: 5.62 },
      { code: '301071', name: '力量钻石', industry: '小金属', score: 75, reason: 'CVD培育钻石龙头，大尺寸金刚石技术突破，散热用金刚石片量产在即', reasonTag: '概念共振', inConcept: true, price: 42.50, changePct: 4.18 },
    ],
    upstream: [
      { name: '工业金属', sourceIndustry: '小金属', factor: 0.42 },
      { name: '金属新材料', sourceIndustry: '贵金属', factor: 0.38 },
    ],
    downstream: [
      { name: '珠宝首饰', sourceIndustry: '贵金属', factor: 0.35 },
      { name: '半导体', sourceIndustry: '贵金属', factor: 0.28 },
    ],
    upstreamStocks: [
      { code: '601600', name: '中国铝业', industry: '工业金属', score: 38, reason: '工业金属原材料，培育钻石设备上游', price: 8.65, changePct: 1.25, factor: 0.42, sourceIndustry: '小金属' },
      { code: '600362', name: '江西铜业', industry: '工业金属', score: 35, reason: '有色金属龙头，培育钻石压机设备上游材料', price: 28.30, changePct: 0.95, factor: 0.38, sourceIndustry: '贵金属' },
    ],
    downstreamStocks: [
      { code: '002867', name: '周大生', industry: '珠宝首饰', score: 32, reason: '珠宝零售龙头，培育钻石消费端核心渠道', price: 15.80, changePct: 1.52, factor: 0.35, sourceIndustry: '贵金属' },
      { code: '600916', name: '中国黄金', industry: '珠宝首饰', score: 30, reason: '黄金珠宝零售，培育钻石终端销售渠道', price: 12.35, changePct: 0.85, factor: 0.32, sourceIndustry: '贵金属' },
    ],
    leadingStock: { name: '黄河旋风', code: '600172', industry: '贵金属', price: 13.30, changePct: 5.62, reason: '国内唯一HPHT+CVD双工艺金刚石企业；全球培育钻石高温高压法龙头，中高端毛坯市占50%+；国内首条8英寸CVD金刚石热沉片2026年量产，适配AI芯片散热' },
  },
  {
    name: '存储芯片',
    frequency: 8, avgChange: 2.68, todayChange: 6.38, amountTrend: 10.5, score: 70,
    driver: '存储涨价周期+AI端侧+车规三重红利共振，HBM需求爆发',
    persistence: '中期(1-2周)', persistenceReason: '存储涨价周期持续，AI端侧需求爆发，资金持续流入',
    transferDirection: '中游→下游', transferReason: '存储芯片需求向下游消费电子和计算机设备传导',
    riskWarning: '关注存储价格走势，涨价周期拐点风险',
    relatedIndustries: ['半导体', '计算机设备', '消费电子'],
    industryData: [
      { name: '半导体', change: 3.2, up_count: 7, down_count: 3, leading_stock: '兆易创新' },
      { name: '计算机设备', change: 1.8, up_count: 4, down_count: 4, leading_stock: '通富微电' },
      { name: '消费电子', change: 1.5, up_count: 5, down_count: 5, leading_stock: '德明利' },
    ],
    stocks: [
      { code: '603986', name: '兆易创新', industry: '半导体', score: 88, reason: 'A股唯一全品类存储设计龙头，NOR Flash全球第二、国内第一；利基DRAM深度绑定长鑫存储', reasonTag: '龙头', inConcept: true, price: 428.50, changePct: 6.38 },
      { code: '002156', name: '通富微电', industry: '半导体', score: 80, reason: '国内封测前三，HBM封装国内唯一量产；深度绑定AMD+华为海思，先进封装核心标的', reasonTag: '概念共振', inConcept: true, price: 44.56, changePct: 4.85 },
      { code: '001309', name: '德明利', industry: '半导体', score: 62, reason: 'NAND Flash主控芯片+存储模组，存储国产替代先锋', reasonTag: '量价齐升', inConcept: true, price: 68.20, changePct: 3.56 },
      { code: '603929', name: '百威存储', industry: '半导体', score: 55, reason: '企业级SSD+存储控制器芯片，数据中心存储核心标的', reasonTag: '概念共振', inConcept: true, price: 35.80, changePct: 2.85 },
    ],
    upstream: [
      { name: '电子化学品', sourceIndustry: '半导体', factor: 0.58 },
      { name: '小金属', sourceIndustry: '半导体', factor: 0.42 },
    ],
    downstream: [
      { name: '通信设备', sourceIndustry: '半导体', factor: 0.48 },
      { name: '汽车零部件', sourceIndustry: '半导体', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '603078', name: '江化微', industry: '电子化学品', score: 52, reason: '湿电子化学品+光刻胶，存储芯片制造上游关键材料', price: 41.56, changePct: 2.85, factor: 0.58, sourceIndustry: '半导体' },
      { code: '688025', name: '杰普特', industry: '专用设备', score: 42, reason: '激光加工设备，存储芯片封装工艺设备', price: 52.30, changePct: 1.65, factor: 0.45, sourceIndustry: '半导体' },
    ],
    downstreamStocks: [
      { code: '000977', name: '浪潮信息', industry: '计算机设备', score: 45, reason: 'AI服务器龙头，存储芯片下游核心需求方', price: 42.80, changePct: 2.15, factor: 0.48, sourceIndustry: '计算机设备' },
      { code: '002415', name: '海康威视', industry: '计算机设备', score: 40, reason: 'AI安防+边缘计算，存储芯片下游应用', price: 38.20, changePct: 1.35, factor: 0.42, sourceIndustry: '消费电子' },
    ],
    leadingStock: { name: '兆易创新', code: '603986', industry: '半导体', price: 428.50, changePct: 6.38, reason: 'A股唯一全品类存储设计龙头，NOR Flash全球第二、国内第一；利基DRAM深度绑定长鑫存储，独享代工+代销权限；车规NOR供货特斯拉、比亚迪，AI端侧存储深度卡位' },
  },
  {
    name: '光纤',
    frequency: 7, avgChange: 2.15, todayChange: 5.62, amountTrend: 8.2, score: 62,
    driver: '光纤涨价周期弹性最大，空芯光纤卡位下一代标准，AI算力网络建设加速',
    persistence: '中期(1-2周)', persistenceReason: '光纤涨价周期持续，AI算力网络建设拉动需求，海外收入增长',
    transferDirection: '中游→下游', transferReason: '光纤需求向下游通信设备和数据中心传导',
    riskWarning: '关注运营商集采价格，涨价持续性待验证',
    relatedIndustries: ['通信设备', '光学光电子', '电力设备'],
    industryData: [
      { name: '通信设备', change: 2.8, up_count: 6, down_count: 3, leading_stock: '长飞光纤' },
      { name: '光学光电子', change: 2.1, up_count: 5, down_count: 4, leading_stock: '亨通光电' },
      { name: '电力设备', change: 1.2, up_count: 3, down_count: 5, leading_stock: '中天科技' },
    ],
    stocks: [
      { code: '601869', name: '长飞光纤', industry: '通信设备', score: 90, reason: '全球光纤预制棒、光纤、光缆销量连续10年第一，国内唯一同时掌握PCVD/VAD/OVD三大光棒工艺；空芯光纤衰减0.04dB/km创世界纪录', reasonTag: '龙头', inConcept: true, price: 275.80, changePct: 5.62 },
      { code: '600487', name: '亨通光电', industry: '通信设备', score: 78, reason: '光纤光缆+海洋通信双龙头，400G/800G光模块量产，海外布局领先', reasonTag: '概念共振', inConcept: true, price: 22.50, changePct: 3.85 },
      { code: '600522', name: '中天科技', industry: '电力设备', score: 72, reason: '光纤+海缆+储能三主业，光纤涨价弹性大，新能源业务高增长', reasonTag: '概念共振', inConcept: true, price: 16.85, changePct: 3.12 },
    ],
    upstream: [
      { name: '建筑材料', sourceIndustry: '光学光电子', factor: 0.45 },
      { name: '半导体', sourceIndustry: '通信设备', factor: 0.48 },
    ],
    downstream: [
      { name: '计算机设备', sourceIndustry: '通信设备', factor: 0.48 },
      { name: '传媒', sourceIndustry: '通信设备', factor: 0.32 },
    ],
    upstreamStocks: [
      { code: '600586', name: '金晶科技', industry: '建筑材料', score: 38, reason: '超白玻璃原片，光纤预制棒上游石英材料', price: 8.25, changePct: 1.52, factor: 0.45, sourceIndustry: '光学光电子' },
      { code: '603629', name: '利通电子', industry: '消费电子', score: 35, reason: '精密结构件，光纤连接器上游组件', price: 97.00, changePct: 1.25, factor: 0.38, sourceIndustry: '通信设备' },
    ],
    downstreamStocks: [
      { code: '600050', name: '中国联通', industry: '通信设备', score: 42, reason: '算力网络建设，光纤光缆下游核心需求方', price: 6.85, changePct: 1.35, factor: 0.48, sourceIndustry: '通信设备' },
      { code: '000063', name: '中兴通讯', industry: '通信设备', score: 40, reason: '5G基站+算力网络，光纤下游核心应用', price: 32.50, changePct: 1.15, factor: 0.42, sourceIndustry: '通信设备' },
    ],
    leadingStock: { name: '长飞光纤', code: '601869', industry: '通信设备', price: 275.80, changePct: 5.62, reason: '全球光纤预制棒、光纤、光缆销量连续10年第一，国内唯一同时掌握PCVD/VAD/OVD三大光棒工艺；空芯光纤衰减0.04dB/km创世界纪录；海外收入占比超40%，全球8国9基地布局' },
  },
  {
    name: 'MLCC',
    frequency: 6, avgChange: 1.95, todayChange: 4.86, amountTrend: 7.5, score: 58,
    driver: 'AI服务器+车规+存储三景气共振，MLCC涨价周期量价齐升',
    persistence: '中期(1-2周)', persistenceReason: 'MLCC涨价周期持续，AI服务器和车规需求高景气',
    transferDirection: '上游→中游', transferReason: '上游陶瓷材料先行涨价，向中游MLCC制造传导',
    riskWarning: '关注涨价持续性，竞争格局变化',
    relatedIndustries: ['元件', '半导体', '消费电子'],
    industryData: [
      { name: '元件', change: 2.5, up_count: 5, down_count: 3, leading_stock: '风华高科' },
      { name: '半导体', change: 1.8, up_count: 4, down_count: 4, leading_stock: '国瓷材料' },
      { name: '消费电子', change: 1.2, up_count: 3, down_count: 5, leading_stock: '红星发展' },
    ],
    stocks: [
      { code: '000636', name: '风华高科', industry: '元件', score: 85, reason: '国内MLCC产能与市占率双第一，月产能超500亿只；唯一实现阻容感全品类+材料-元件-模组全产业链自主布局', reasonTag: '龙头', inConcept: true, price: 21.25, changePct: 4.86 },
      { code: '300285', name: '国瓷材料', industry: '半导体', score: 75, reason: 'MLCC陶瓷材料龙头，钛酸钡粉体国内市占率第一，MLCC上游核心材料国产替代', reasonTag: '概念共振', inConcept: true, price: 18.65, changePct: 3.52 },
      { code: '600367', name: '红星发展', industry: '化学制品', score: 58, reason: '碳酸钡/碳酸锶全球龙头，MLCC上游无机盐材料核心供应商', reasonTag: '量价齐升', inConcept: true, price: 15.80, changePct: 2.85 },
    ],
    upstream: [
      { name: '电子化学品', sourceIndustry: '元件', factor: 0.55 },
      { name: '工业金属', sourceIndustry: '元件', factor: 0.42 },
    ],
    downstream: [
      { name: '计算机设备', sourceIndustry: '消费电子', factor: 0.45 },
      { name: '通信设备', sourceIndustry: '消费电子', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '601600', name: '中国铝业', industry: '工业金属', score: 35, reason: '工业金属原材料，MLCC电极材料上游', price: 8.65, changePct: 1.15, factor: 0.42, sourceIndustry: '元件' },
      { code: '600362', name: '江西铜业', industry: '工业金属', score: 32, reason: '有色金属龙头，MLCC镍电极上游材料', price: 28.30, changePct: 0.95, factor: 0.38, sourceIndustry: '元件' },
    ],
    downstreamStocks: [
      { code: '000977', name: '浪潮信息', industry: '计算机设备', score: 40, reason: 'AI服务器龙头，MLCC下游核心需求方', price: 42.80, changePct: 1.85, factor: 0.45, sourceIndustry: '消费电子' },
      { code: '002415', name: '海康威视', industry: '计算机设备', score: 38, reason: '安防+AI设备，MLCC下游应用', price: 38.20, changePct: 1.25, factor: 0.38, sourceIndustry: '消费电子' },
    ],
    leadingStock: { name: '风华高科', code: '000636', industry: '元件', price: 21.25, changePct: 4.86, reason: '国内MLCC产能与市占率双第一，月产能超500亿只；唯一实现阻容感全品类+材料-元件-模组全产业链自主布局；车规MLCC通过AEC-Q200认证，AI服务器高容MLCC量产突破' },
  },
  {
    name: '半导体材料',
    frequency: 7, avgChange: 2.42, todayChange: 4.25, amountTrend: 9.8, score: 65,
    driver: '半导体国产替代加速，材料端自主可控需求迫切，AI芯片材料需求爆发',
    persistence: '中期(1-2周)', persistenceReason: '半导体国产替代长期逻辑，材料端自主可控需求迫切',
    transferDirection: '上游→中游', transferReason: '上游材料端先行启动，向中游半导体制造传导',
    riskWarning: '关注国产替代进度，技术突破节奏',
    relatedIndustries: ['电子化学品', '半导体', '小金属'],
    industryData: [
      { name: '电子化学品', change: 2.8, up_count: 5, down_count: 3, leading_stock: '江化微' },
      { name: '半导体', change: 2.2, up_count: 6, down_count: 4, leading_stock: '江丰电子' },
      { name: '小金属', change: 1.5, up_count: 3, down_count: 4, leading_stock: '云南锗业' },
    ],
    stocks: [
      { code: '300666', name: '江丰电子', industry: '半导体', score: 82, reason: '国内高纯溅射靶材龙头，7nm+制程靶材量产，半导体材料国产替代核心标的', reasonTag: '龙头', inConcept: true, price: 85.60, changePct: 4.25 },
      { code: '603078', name: '江化微', industry: '电子化学品', score: 78, reason: '湿电子化学品龙头，G5等级产品量产，光刻胶配套试剂国产替代先锋', reasonTag: '概念共振', inConcept: true, price: 41.56, changePct: 3.85 },
      { code: '002428', name: '云南锗业', industry: '小金属', score: 65, reason: '国内锗产业链龙头，红外光学+光纤用锗+半导体衬底锗片', reasonTag: '量价齐升', inConcept: true, price: 22.80, changePct: 3.12 },
      { code: '688268', name: '华特气体', industry: '电子化学品', score: 68, reason: '国内电子特气龙头，高纯六氟化钨等20+种特气量产，半导体工艺气体国产替代核心', reasonTag: '概念共振', inConcept: true, price: 62.30, changePct: 3.56 },
    ],
    upstream: [
      { name: '化学制品', sourceIndustry: '电子化学品', factor: 0.52 },
      { name: '工业金属', sourceIndustry: '小金属', factor: 0.45 },
    ],
    downstream: [
      { name: '消费电子', sourceIndustry: '半导体', factor: 0.48 },
      { name: '汽车零部件', sourceIndustry: '半导体', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '601600', name: '中国铝业', industry: '工业金属', score: 35, reason: '工业金属原材料，半导体材料上游金属', price: 8.65, changePct: 1.15, factor: 0.45, sourceIndustry: '小金属' },
      { code: '600362', name: '江西铜业', industry: '工业金属', score: 32, reason: '有色金属龙头，半导体靶材上游材料', price: 28.30, changePct: 0.95, factor: 0.42, sourceIndustry: '小金属' },
    ],
    downstreamStocks: [
      { code: '000977', name: '浪潮信息', industry: '计算机设备', score: 42, reason: 'AI服务器龙头，半导体材料下游核心需求方', price: 42.80, changePct: 1.85, factor: 0.48, sourceIndustry: '半导体' },
      { code: '002415', name: '海康威视', industry: '计算机设备', score: 38, reason: 'AI安防+边缘计算，半导体材料下游应用', price: 38.20, changePct: 1.25, factor: 0.38, sourceIndustry: '半导体' },
    ],
    leadingStock: { name: '江丰电子', code: '300666', industry: '半导体', price: 85.60, changePct: 4.25, reason: '国内高纯溅射靶材龙头，7nm+制程靶材量产；全球前五大靶材制造商，台积电/中芯国际/长江存储核心供应商；半导体材料国产替代核心标的' },
  },
  {
    name: '物理AI',
    frequency: 8, avgChange: 3.85, todayChange: 7.25, amountTrend: 18.5, score: 78,
    driver: '物理AI成为AI下一波浪潮，仿真+机器人+具身智能融合加速',
    persistence: '中期(1-2周)', persistenceReason: '物理AI是AI下一波浪潮，仿真+机器人+具身智能融合加速，资金持续关注',
    transferDirection: '中游→下游', transferReason: '物理AI平台向下游机器人、工业自动化应用传导',
    riskWarning: '技术路线尚在早期，商业化进度待验证',
    relatedIndustries: ['软件开发', '自动化设备', '计算机设备'],
    industryData: [
      { name: '软件开发', change: 3.5, up_count: 6, down_count: 3, leading_stock: '索辰科技' },
      { name: '自动化设备', change: 2.8, up_count: 5, down_count: 4, leading_stock: '工业富联' },
      { name: '计算机设备', change: 2.2, up_count: 4, down_count: 5, leading_stock: '奥比中光' },
    ],
    stocks: [
      { code: '688507', name: '索辰科技', industry: '软件开发', score: 90, reason: '国内唯一全学科自主CAE求解器+物理AI平台企业，军工CAE市占率超70%；自研"天工·开物"可微分物理仿真平台', reasonTag: '龙头', inConcept: true, price: 162.91, changePct: 7.25 },
      { code: '301316', name: '凡拓数创', industry: '软件开发', score: 72, reason: '数字孪生+3D可视化龙头，物理AI仿真可视化核心标的', reasonTag: '概念共振', inConcept: true, price: 28.50, changePct: 5.85 },
      { code: '688322', name: '奥比中光', industry: '计算机设备', score: 68, reason: '国内3D视觉感知龙头，机器人视觉+具身智能核心传感器供应商', reasonTag: '概念共振', inConcept: true, price: 42.80, changePct: 4.56 },
      { code: '601138', name: '工业富联', industry: '自动化设备', score: 75, reason: '全球最大电子制造服务商，AI服务器+工业互联网+机器人三重受益物理AI', reasonTag: '概念共振', inConcept: true, price: 28.65, changePct: 3.85 },
    ],
    upstream: [
      { name: '半导体', sourceIndustry: '计算机设备', factor: 0.52 },
      { name: '元件', sourceIndustry: '自动化设备', factor: 0.45 },
    ],
    downstream: [
      { name: '汽车零部件', sourceIndustry: '自动化设备', factor: 0.48 },
      { name: '电力设备', sourceIndustry: '自动化设备', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '603986', name: '兆易创新', industry: '半导体', score: 48, reason: '存储+MCU双龙头，物理AI端侧芯片核心供应商', price: 428.50, changePct: 2.15, factor: 0.52, sourceIndustry: '计算机设备' },
      { code: '000636', name: '风华高科', industry: '元件', score: 42, reason: 'MLCC龙头，物理AI硬件上游被动元件供应商', price: 21.25, changePct: 1.85, factor: 0.45, sourceIndustry: '自动化设备' },
    ],
    downstreamStocks: [
      { code: '002594', name: '比亚迪', industry: '汽车整车', score: 45, reason: '新能源汽车+智能驾驶，物理AI下游核心应用', price: 325.80, changePct: 1.52, factor: 0.48, sourceIndustry: '自动化设备' },
      { code: '300124', name: '汇川技术', industry: '自动化设备', score: 42, reason: '工业自动化龙头，物理AI+机器人运动控制核心', price: 58.30, changePct: 1.35, factor: 0.38, sourceIndustry: '自动化设备' },
    ],
    leadingStock: { name: '索辰科技', code: '688507', industry: '软件开发', price: 162.91, changePct: 7.25, reason: '国内唯一全学科自主CAE求解器+物理AI平台企业，军工CAE市占率超70%；自研"天工·开物"可微分物理仿真平台，仿真速度比传统工具快100倍+；A股唯一全链路自主可控物理AI底座标的' },
  },
  {
    name: '半导体设备',
    frequency: 7, avgChange: 2.55, todayChange: 3.92, amountTrend: 11.2, score: 66,
    driver: '半导体设备国产替代加速，先进制程设备突破，AI芯片产能扩张',
    persistence: '中期(1-2周)', persistenceReason: '半导体设备国产替代长期逻辑，先进制程设备持续突破',
    transferDirection: '上游→中游', transferReason: '上游零部件和材料先行启动，向中游设备制造传导',
    riskWarning: '关注国产替代进度，地缘政治风险',
    relatedIndustries: ['专用设备', '半导体', '自动化设备'],
    industryData: [
      { name: '专用设备', change: 2.8, up_count: 5, down_count: 3, leading_stock: '大族激光' },
      { name: '半导体', change: 2.2, up_count: 6, down_count: 4, leading_stock: '华虹公司' },
      { name: '自动化设备', change: 1.8, up_count: 4, down_count: 5, leading_stock: '仕佳光子' },
    ],
    stocks: [
      { code: '002008', name: '大族激光', industry: '专用设备', score: 85, reason: '全球激光加工设备龙头，半导体激光切割/封装设备核心供应商，先进封装设备国产替代先锋', reasonTag: '龙头', inConcept: true, price: 32.50, changePct: 3.92 },
      { code: '688347', name: '华虹公司', industry: '半导体', score: 78, reason: '国内特色工艺晶圆代工龙头，功率器件+MCU+RF芯片代工，半导体设备下游核心验证平台', reasonTag: '概念共振', inConcept: true, price: 45.80, changePct: 3.15 },
      { code: '688313', name: '仕佳光子', industry: '自动化设备', score: 65, reason: '光通信芯片+PLC光分路器龙头，半导体光芯片设备相关', reasonTag: '量价齐升', inConcept: true, price: 25.60, changePct: 2.85 },
    ],
    upstream: [
      { name: '通用设备', sourceIndustry: '专用设备', factor: 0.52 },
      { name: '金属新材料', sourceIndustry: '自动化设备', factor: 0.42 },
    ],
    downstream: [
      { name: '消费电子', sourceIndustry: '半导体', factor: 0.48 },
      { name: '电力设备', sourceIndustry: '自动化设备', factor: 0.38 },
    ],
    upstreamStocks: [
      { code: '601600', name: '中国铝业', industry: '工业金属', score: 35, reason: '工业金属原材料，半导体设备零部件上游', price: 8.65, changePct: 1.15, factor: 0.45, sourceIndustry: '专用设备' },
      { code: '600362', name: '江西铜业', industry: '工业金属', score: 32, reason: '有色金属龙头，半导体设备精密零部件上游', price: 28.30, changePct: 0.95, factor: 0.42, sourceIndustry: '专用设备' },
    ],
    downstreamStocks: [
      { code: '000977', name: '浪潮信息', industry: '计算机设备', score: 42, reason: 'AI服务器龙头，半导体设备下游核心需求方', price: 42.80, changePct: 1.85, factor: 0.48, sourceIndustry: '半导体' },
      { code: '002415', name: '海康威视', industry: '计算机设备', score: 38, reason: 'AI安防+边缘计算，半导体设备下游应用', price: 38.20, changePct: 1.25, factor: 0.38, sourceIndustry: '自动化设备' },
    ],
    leadingStock: { name: '大族激光', code: '002008', industry: '专用设备', price: 32.50, changePct: 3.92, reason: '全球激光加工设备龙头，半导体激光切割/封装设备核心供应商；先进封装设备国产替代先锋，Mini LED+Micro LED设备布局领先；深度绑定台积电/中芯国际/长电科技' },
  },
];

// ==================== 生成函数 ====================

function generateFlowData(sector) {
  const nodes = [
    { id: sector.name, type: 'main', label: sector.name },
  ];
  const links = [];

  // 概念 → 强关联行业
  for (const ind of sector.relatedIndustries) {
    nodes.push({ id: ind, type: 'related', label: ind });
    const factor = Math.round((0.3 + Math.random() * 0.4) * 1000) / 1000;
    links.push({ source: sector.name, target: ind, factor, direction: 'related' });
  }

  // 上游行业
  for (const up of sector.upstream) {
    if (!nodes.some(n => n.id === up.name)) {
      nodes.push({ id: up.name, type: 'upstream', label: up.name });
    }
    links.push({ source: up.name, target: up.sourceIndustry, factor: up.factor, direction: 'upstream' });
  }

  // 下游行业
  for (const down of sector.downstream) {
    if (!nodes.some(n => n.id === down.name)) {
      nodes.push({ id: down.name, type: 'downstream', label: down.name });
    }
    links.push({ source: down.sourceIndustry, target: down.name, factor: down.factor, direction: 'downstream' });
  }

  return { nodes, links, transfer_direction: sector.transferDirection };
}

function generateSector(sector) {
  const flowData = generateFlowData(sector);

  return {
    name: sector.name,
    type: 'concept',
    frequency: sector.frequency,
    avg_change: sector.avgChange,
    today_change: sector.todayChange,
    amount_trend: sector.amountTrend,
    leading_stock: sector.leadingStock.name,
    leading_change: sector.leadingStock.changePct,
    up_count: sector.industryData.reduce((s, i) => s + i.up_count, 0) > 0 ? Math.ceil(sector.stocks.length * 0.7) : 0,
    down_count: sector.industryData.reduce((s, i) => s + i.down_count, 0) > 0 ? Math.floor(sector.stocks.length * 0.3) : 0,
    driver: sector.driver,
    score: sector.score,
    related_industries: sector.relatedIndustries,
    industry_data: sector.industryData,
    ai_analysis: {
      persistence: sector.persistence,
      persistence_reason: sector.persistenceReason,
      heat_transfer: true,
      transfer_direction: sector.transferDirection,
      transfer_reason: sector.transferReason,
      risk_warning: sector.riskWarning,
    },
    main_stocks: sector.stocks.map(s => ({
      code: s.code,
      name: s.name,
      industry: s.industry,
      score: s.score,
      reason: s.reason,
      reason_tag: s.reasonTag,
      reason_tag_class: s.reasonTag === '龙头' ? 'tag-bullish' : s.reasonTag === '量价齐升' ? 'tag-trend' : 'tag-bullish',
      source: sector.name,
      in_concept: s.inConcept,
      limit_tags: [],
      price: s.price,
      change_pct: s.changePct,
      chain_position: '核心',
      related_industry: s.industry,
      overlap_ratio: Math.round((0.3 + Math.random() * 0.35) * 1000) / 1000,
    })),
    upstream_stocks: sector.upstreamStocks.map(s => ({
      code: s.code,
      name: s.name,
      industry: s.industry,
      score: s.score,
      reason: s.reason,
      reason_tag: s.reason.includes('量价') ? '量价齐升' : '概念共振',
      reason_tag_class: s.reason.includes('量价') ? 'tag-trend' : 'tag-bullish',
      source: s.reason.includes('量价') ? '量价齐升' : sector.name,
      in_concept: false,
      limit_tags: [],
      price: s.price,
      change_pct: s.changePct,
      chain_position: '上游',
      transmission_factor: s.factor,
      source_industry: s.sourceIndustry,
    })),
    downstream_stocks: sector.downstreamStocks.map(s => ({
      code: s.code,
      name: s.name,
      industry: s.industry,
      score: s.score,
      reason: s.reason,
      reason_tag: s.reason.includes('量价') ? '量价齐升' : '概念共振',
      reason_tag_class: s.reason.includes('量价') ? 'tag-trend' : 'tag-bullish',
      source: s.reason.includes('量价') ? '量价齐升' : sector.name,
      in_concept: false,
      limit_tags: [],
      price: s.price,
      change_pct: s.changePct,
      chain_position: '下游',
      transmission_factor: s.factor,
      source_industry: s.sourceIndustry,
    })),
    flow_data: flowData,
    leading_stock_info: {
      name: sector.leadingStock.name,
      code: sector.leadingStock.code,
      industry: sector.leadingStock.industry,
      price: sector.leadingStock.price,
      change_pct: sector.leadingStock.changePct,
      reason: sector.leadingStock.reason,
      in_concept: true,
      limit_tags: [],
    },
  };
}

// ==================== 主流程 ====================
const result = {
  update_time: new Date().toLocaleString('zh-CN', { hour12: false }),
  hot_sectors: SECTORS.map(generateSector),
};

const outputPath = path.resolve(__dirname, 'hot-sectors.json');
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
console.log(`Mock数据生成完成，共 ${result.hot_sectors.length} 个板块，保存到 ${outputPath}`);
