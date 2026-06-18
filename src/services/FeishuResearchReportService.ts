import pool from '../db';
import { extractStockCodes } from './HotKeywordDetectorService';

export interface ResearchReportStock {
  symbol: string;
  stockName: string;
  messageId: string;
  chatName: string;
  text: string;
  receivedAt: string;
}

const REPORT_KEYWORDS = ['研报', 'VIP', '风口研报', '个股推荐', '推荐', '目标价', '评级', '买入', '增持'];

export function isResearchReportMessage(text: string, chatName: string = ''): boolean {
  const combined = `${text} ${chatName}`;
  return REPORT_KEYWORDS.some(kw => combined.includes(kw));
}

export function extractReportRecommendedStocks(text: string): { symbol: string; stockName: string }[] {
  const codes = extractStockCodes(text);
  return Array.from(codes.entries()).map(([symbol, stockName]) => ({ symbol, stockName }));
}

export async function findResearchReportMessagesForStock(
  symbol: string,
  hours: number = 24,
): Promise<ResearchReportStock[]> {
  const result = await pool.query(
    `SELECT id, chat_name, message_id, text, stock_codes, received_at
     FROM feishu_messages
     WHERE received_at > NOW() - INTERVAL '${hours} hours'
       AND $1 = ANY(stock_codes)
     ORDER BY received_at DESC
     LIMIT 100`,
    [symbol],
  );

  const matched: ResearchReportStock[] = [];

  for (const row of result.rows) {
    const text = String(row.text || '');
    const chatName = String(row.chat_name || '');
    if (!isResearchReportMessage(text, chatName)) continue;

    const stocks = extractReportRecommendedStocks(text);
    const stock = stocks.find(s => s.symbol === symbol);
    if (!stock) continue;

    matched.push({
      symbol: stock.symbol,
      stockName: stock.stockName,
      messageId: row.message_id,
      chatName,
      text: text.slice(0, 200),
      receivedAt: row.received_at,
    });
  }

  return matched;
}
