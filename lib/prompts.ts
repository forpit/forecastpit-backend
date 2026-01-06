/**
 * LLM Prompts for Decision Making
 *
 * System and user prompts that guide LLM agents in making trading decisions.
 * Based on forecasterarena-reference methodology.
 *
 * @module prompts
 */

import { INITIAL_BALANCE, MIN_BET, MAX_BET_PERCENT } from './constants';
import type { Market, Position } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface PortfolioState {
  cashBalance: number;
  totalInvested: number;
  positions: PositionWithMarket[];
}

interface PositionWithMarket extends Position {
  market: Market;
}

interface MarketForPrompt {
  id: string;
  question: string;
  category: string | null;
  current_price: number;
  volume: number | null;
  close_date: string;
}

// ============================================================================
// SYSTEM PROMPT
// ============================================================================

export function buildSystemPrompt(): string {
  return `You are an AI forecaster participating in Prediarena, a benchmark that tests AI prediction capabilities on real-world events using Polymarket prediction markets.

YOUR OBJECTIVE:
Maximize your forecasting accuracy and portfolio returns by making intelligent bets on prediction markets.

UNDERSTANDING MARKET PRICES:
- Price shows market's current probability estimate
- "99% YES" means market believes event is 99% likely to happen
- "0.1% YES" means market believes event is nearly impossible
- If you bet YES at 99%, you pay $0.99 per share and win $1 if YES resolves (tiny profit)
- If you bet NO at 99% YES (= 1% NO), you pay $0.01 per share and win $1 if NO resolves (rare but huge profit)
- HIGH YES price (>95%) = event likely already happened or is certain
- LOW YES price (<5%) = event extremely unlikely

CRITICAL THINKING RULES:
1. BE REALISTIC about time horizons:
   - "2 days left" means the event must happen in 48 hours
   - Extreme price moves (Bitcoin +100%, regime change) do NOT happen in 2 days
   - If market says 0.1% YES for "Bitcoin $200k in 2 days", the market is RIGHT - don't bet YES
   - Markets with very low YES (<1%) that close soon are correctly priced - avoid betting YES on them

2. UNDERSTAND what high prices mean:
   - 97% YES usually means the event ALREADY HAPPENED or is confirmed
   - Don't bet NO on something that's already true
   - Check if the event has already occurred based on the question wording

3. DIVERSIFICATION IS MANDATORY:
   - ONLY ONE bet per topic/asset/company allowed
   - Do NOT bet on multiple correlated markets (e.g., 2x "Lighter" markets, 2x Bitcoin targets)
   - Each bet MUST be on an INDEPENDENT event
   - Good: 1 Bitcoin bet + 1 Ethereum bet + 1 politics bet + 1 sports bet
   - Bad: 2 different Bitcoin price targets (both depend on BTC price)

4. POSITION MANAGEMENT:
   - Maximum bet per market: ${MAX_BET_PERCENT * 100}% of your cash balance
   - You CAN use most/all of your cash if you have high-conviction diversified bets
   - Remember: cash converts to positions, which you can SELL later for cash
   - Next decision day you can sell winning positions to free up capital
   - Think about portfolio balance, not just cash preservation

DECISION FORMAT:
Respond with valid JSON in exactly one of these formats:

FOR PLACING BETS:
{
  "action": "BET",
  "bets": [
    {"market_id": "uuid", "side": "YES", "amount": 500.00, "reasoning": "Why this specific bet..."},
    {"market_id": "uuid", "side": "NO", "amount": 300.00, "reasoning": "Why this specific bet..."}
  ]
}

FOR SELLING POSITIONS:
{
  "action": "SELL",
  "sells": [
    {"position_id": "uuid", "percentage": 100}
  ],
  "reasoning": "Your detailed reasoning"
}

FOR HOLDING:
{
  "action": "HOLD",
  "reasoning": "Your detailed reasoning"
}

RULES SUMMARY:
1. Minimum bet: $${MIN_BET}
2. Maximum bet per market: ${MAX_BET_PERCENT * 100}% of cash balance
3. Diversify: no correlated bets (e.g., don't bet on 3 Bitcoin markets)
4. Be realistic: don't bet YES on near-impossible short-term events (<1% with days left)
5. You can sell positions later to recover cash - betting is not permanent

RESPOND WITH VALID JSON ONLY. No markdown, no explanation outside the JSON.`;
}

// ============================================================================
// USER PROMPT
// ============================================================================

export function buildUserPrompt(
  portfolio: PortfolioState,
  markets: MarketForPrompt[],
  decisionDay: number
): string {
  const maxBet = portfolio.cashBalance * MAX_BET_PERCENT;
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // Calculate portfolio totals
  const positionsValue = portfolio.positions.reduce((sum, p) => {
    const currentPrice = p.market.current_price ?? 0;
    const value = p.side === 'YES'
      ? p.shares * currentPrice
      : p.shares * (1 - currentPrice);
    return sum + value;
  }, 0);
  const totalValue = portfolio.cashBalance + positionsValue;
  const pnl = totalValue - INITIAL_BALANCE;
  const pnlPercent = ((pnl / INITIAL_BALANCE) * 100).toFixed(2);

  let prompt = `CURRENT DATE: ${todayStr}
DECISION DAY: ${decisionDay}

YOUR PORTFOLIO:
- Cash Balance: $${portfolio.cashBalance.toFixed(2)}
- Maximum Bet Size: $${maxBet.toFixed(2)} (${MAX_BET_PERCENT * 100}% of cash)
- Positions Value: $${positionsValue.toFixed(2)}
- Total Portfolio: $${totalValue.toFixed(2)}
- P/L: $${pnl.toFixed(2)} (${pnl >= 0 ? '+' : ''}${pnlPercent}%)

`;

  // Add existing positions if any
  if (portfolio.positions.length > 0) {
    prompt += `YOUR CURRENT POSITIONS:\n`;
    for (const pos of portfolio.positions) {
      const currentPrice = pos.market.current_price ?? 0;
      const posValue = pos.side === 'YES'
        ? pos.shares * currentPrice
        : pos.shares * (1 - currentPrice);
      const pnlPos = posValue - pos.total_cost;

      prompt += `- ID: ${pos.id}
  Market: "${pos.market.question}"
  Side: ${pos.side} | Shares: ${pos.shares.toFixed(2)}
  Entry: ${(pos.avg_entry_price * 100).toFixed(1)}% | Current: ${(currentPrice * 100).toFixed(1)}%
  Value: $${posValue.toFixed(2)} | P/L: $${pnlPos.toFixed(2)}

`;
    }
  } else {
    prompt += `YOUR CURRENT POSITIONS: None

`;
  }

  // Add available markets
  prompt += `AVAILABLE MARKETS (Top ${markets.length} by volume):\n`;

  for (const market of markets) {
    const noPrice = 1 - market.current_price;
    const closeDate = new Date(market.close_date);
    const daysUntilClose = Math.ceil((closeDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    const timeLabel = daysUntilClose <= 0 ? 'EXPIRED' :
                      daysUntilClose === 1 ? '1 day left' :
                      `${daysUntilClose} days left`;

    prompt += `- ID: ${market.id}
  Question: "${market.question}"
  Category: ${market.category || 'General'}
  Price: ${(market.current_price * 100).toFixed(1)}% YES / ${(noPrice * 100).toFixed(1)}% NO
  Volume: $${(market.volume ?? 0).toLocaleString()}
  Closes: ${market.close_date.split('T')[0]} (${timeLabel})

`;
  }

  prompt += `What is your decision? Respond with valid JSON only.`;

  return prompt;
}

// ============================================================================
// RETRY PROMPT
// ============================================================================

/**
 * Build retry prompt when previous response was invalid
 */
export function buildRetryPrompt(
  originalPrompt: string,
  previousResponse: string,
  errors: string[]
): string {
  return `${originalPrompt}

---
PREVIOUS RESPONSE WAS INVALID:
${errors.map(e => `- ${e}`).join('\n')}

Your response (truncated): ${previousResponse.slice(0, 500)}${previousResponse.length > 500 ? '...' : ''}

Please respond with VALID JSON only. Make sure all market_id and position_id values exactly match the IDs provided above.`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Maximum days until market close (filter out long-term markets)
const MAX_DAYS_UNTIL_CLOSE = 60;

/**
 * Prepare markets for the prompt (binary markets only, closing within 60 days)
 */
export function selectMarketsForPrompt(
  markets: Market[],
  maxMarkets: number = 300
): MarketForPrompt[] {
  const now = new Date();
  const maxCloseDate = new Date(now.getTime() + MAX_DAYS_UNTIL_CLOSE * 24 * 60 * 60 * 1000);

  // Filter to active binary markets with valid prices, closing within 60 days
  const validMarkets = markets.filter((m): m is Market & { current_price: number } => {
    const closeDate = new Date(m.close_date);
    return (
      m.status === 'active' &&
      m.market_type === 'binary' &&
      typeof m.current_price === 'number' &&
      m.current_price > 0 &&
      m.current_price < 1 &&
      closeDate <= maxCloseDate &&
      closeDate > now
    );
  });

  // Sort by volume descending
  validMarkets.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  // Take top markets
  return validMarkets.slice(0, maxMarkets).map(m => ({
    id: m.id,
    question: m.question,
    category: m.category ?? null,
    current_price: m.current_price!,
    volume: m.volume ?? null,
    close_date: m.close_date
  }));
}

/**
 * Estimate token count for a prompt (rough approximation)
 */
export function estimateTokenCount(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}
