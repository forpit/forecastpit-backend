/**
 * LLM Response Parser
 *
 * Parses and validates JSON responses from LLM agents.
 * Handles malformed responses and extracts trading instructions.
 *
 * @module parser
 */

import type { ParsedDecision, BetInstruction, SellInstruction } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface RawBetInstruction {
  market_id?: string;
  marketId?: string;
  side?: string;
  amount?: number;
  reasoning?: string;
}

interface RawSellInstruction {
  position_id?: string;
  positionId?: string;
  percentage?: number;
  percent?: number;
}

interface RawDecision {
  action?: string;
  bets?: RawBetInstruction[];
  sells?: RawSellInstruction[];
  reasoning?: string;
  reason?: string;
  explanation?: string;
}

// ============================================================================
// PARSER FUNCTIONS
// ============================================================================

/**
 * Repair common JSON typos from LLMs
 */
function repairJsonTypos(jsonStr: string): string {
  let repaired = jsonStr;

  // Fix double colons: "key":": "value" -> "key": "value"
  repaired = repaired.replace(/":"\s*:/g, '":');

  // Fix extra colon: "key":: "value" -> "key": "value"
  repaired = repaired.replace(/":\s*:/g, '":');

  // Fix missing comma before property (newline + quotes + colon pattern)
  // "value"\n"key": -> "value",\n"key":
  repaired = repaired.replace(/"\s*\n\s*"/g, '",\n"');

  return repaired;
}

/**
 * Sanitize JSON string by escaping newlines inside string values
 * LLMs often return JSON with raw newlines in strings which is invalid JSON
 */
function sanitizeJsonString(jsonStr: string): string {
  // Replace unescaped newlines inside JSON string values
  // This regex finds content between quotes and escapes newlines/tabs
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];

    if (escape) {
      result += char;
      escape = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (inString) {
      // Escape control characters inside strings
      if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Extract JSON from LLM response (handles markdown code blocks)
 */
function extractJson(text: string): string {
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return repairJsonTypos(sanitizeJsonString(codeBlockMatch[1].trim()));
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return repairJsonTypos(sanitizeJsonString(jsonMatch[0]));
  }

  return repairJsonTypos(sanitizeJsonString(text.trim()));
}

/**
 * Parse LLM response into structured decision
 */
export function parseDecision(rawResponse: string): ParsedDecision {
  // Handle empty responses
  if (!rawResponse || rawResponse.trim() === '') {
    return {
      action: 'ERROR',
      reasoning: 'Empty response from LLM',
      error: 'Empty response'
    };
  }

  try {
    const jsonStr = extractJson(rawResponse);
    const parsed: RawDecision = JSON.parse(jsonStr);

    // Normalize action
    const action = (parsed.action || '').toUpperCase().trim();

    // Extract reasoning
    const reasoning = parsed.reasoning || parsed.reason || parsed.explanation || 'No reasoning provided';

    // Handle HOLD action
    if (action === 'HOLD') {
      return {
        action: 'HOLD',
        reasoning
      };
    }

    // Handle BET action
    if (action === 'BET') {
      if (!parsed.bets || !Array.isArray(parsed.bets) || parsed.bets.length === 0) {
        return {
          action: 'ERROR',
          reasoning,
          error: 'BET action requires non-empty bets array'
        };
      }

      const bets: BetInstruction[] = [];
      for (const bet of parsed.bets) {
        const marketId = bet.market_id || bet.marketId;
        const side = (bet.side || '').toUpperCase();
        const amount = bet.amount;

        if (!marketId) {
          return {
            action: 'ERROR',
            reasoning,
            error: 'Bet missing market_id'
          };
        }

        if (!['YES', 'NO'].includes(side) && !side) {
          return {
            action: 'ERROR',
            reasoning,
            error: `Invalid bet side: ${bet.side}`
          };
        }

        if (typeof amount !== 'number' || amount <= 0) {
          return {
            action: 'ERROR',
            reasoning,
            error: `Invalid bet amount: ${amount}`
          };
        }

        bets.push({
          market_id: marketId,
          side: side || 'YES',
          amount,
          reasoning: bet.reasoning
        });
      }

      return {
        action: 'BET',
        bets,
        reasoning
      };
    }

    // Handle SELL action
    if (action === 'SELL') {
      if (!parsed.sells || !Array.isArray(parsed.sells) || parsed.sells.length === 0) {
        return {
          action: 'ERROR',
          reasoning,
          error: 'SELL action requires non-empty sells array'
        };
      }

      const sells: SellInstruction[] = [];
      for (const sell of parsed.sells) {
        const positionId = sell.position_id || sell.positionId;
        const percentage = sell.percentage ?? sell.percent ?? 100;

        if (!positionId) {
          return {
            action: 'ERROR',
            reasoning,
            error: 'Sell missing position_id'
          };
        }

        if (typeof percentage !== 'number' || percentage <= 0 || percentage > 100) {
          return {
            action: 'ERROR',
            reasoning,
            error: `Invalid sell percentage: ${percentage}`
          };
        }

        sells.push({
          position_id: positionId,
          percentage
        });
      }

      return {
        action: 'SELL',
        sells,
        reasoning
      };
    }

    // Unknown action
    return {
      action: 'ERROR',
      reasoning,
      error: `Unknown action: ${action}`
    };

  } catch (error) {
    // JSON parse failed - try to extract action from text
    const upperText = rawResponse.toUpperCase();

    if (upperText.includes('HOLD') && !upperText.includes('BET') && !upperText.includes('SELL')) {
      return {
        action: 'HOLD',
        reasoning: 'Parsed HOLD from non-JSON response',
        error: 'Response was not valid JSON'
      };
    }

    return {
      action: 'ERROR',
      reasoning: rawResponse.slice(0, 500),
      error: error instanceof Error ? error.message : 'Failed to parse JSON'
    };
  }
}

// Correlation detection - only 1 bet per topic allowed
const MAX_SAME_TOPIC_BETS = 1; // Only 1 bet per topic, error on 2+

/**
 * Extract keywords from market question for correlation detection
 */
function extractMarketKeywords(question: string): string[] {
  const lowerQ = question.toLowerCase();
  const keywords: string[] = [];

  // Crypto keywords
  if (lowerQ.includes('bitcoin') || lowerQ.includes('btc')) keywords.push('bitcoin');
  if (lowerQ.includes('ethereum') || lowerQ.includes('eth')) keywords.push('ethereum');
  if (lowerQ.includes('solana') || lowerQ.includes('sol')) keywords.push('solana');
  if (lowerQ.includes('crypto')) keywords.push('crypto');

  // Company/brand keywords
  if (lowerQ.includes('lighter')) keywords.push('lighter');
  if (lowerQ.includes('nvidia')) keywords.push('nvidia');
  if (lowerQ.includes('tesla')) keywords.push('tesla');
  if (lowerQ.includes('apple')) keywords.push('apple');
  if (lowerQ.includes('google')) keywords.push('google');
  if (lowerQ.includes('microsoft')) keywords.push('microsoft');
  if (lowerQ.includes('amazon')) keywords.push('amazon');

  // Geopolitical keywords
  if (lowerQ.includes('russia') || lowerQ.includes('ukraine')) keywords.push('russia-ukraine');
  if (lowerQ.includes('venezuela')) keywords.push('venezuela');
  if (lowerQ.includes('china') || lowerQ.includes('taiwan')) keywords.push('china');
  if (lowerQ.includes('iran')) keywords.push('iran');

  // Sports keywords
  if (lowerQ.includes('super bowl')) keywords.push('superbowl');

  // Commodities keywords
  if (lowerQ.includes('gold')) keywords.push('gold');
  if (lowerQ.includes('oil') || lowerQ.includes('crude')) keywords.push('oil');
  if (lowerQ.includes('silver')) keywords.push('silver');

  // Election keywords
  if (lowerQ.includes('portugal') && lowerQ.includes('election')) keywords.push('portugal-election');

  // Fed keywords
  if (lowerQ.includes('fed') || lowerQ.includes('interest rate')) keywords.push('fed');

  return keywords;
}

/**
 * Validate a parsed decision against constraints
 */
export function validateDecision(
  decision: ParsedDecision,
  cashBalance: number,
  maxBetPercent: number,
  minBet: number,
  validMarketIds: Set<string>,
  validPositionIds: Set<string>,
  marketQuestions?: Map<string, string> // market_id -> question text
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (decision.action === 'ERROR') {
    errors.push(decision.error || 'Unknown error');
    return { valid: false, errors };
  }

  if (decision.action === 'HOLD') {
    return { valid: true, errors: [] };
  }

  const maxBet = cashBalance * maxBetPercent;

  if (decision.action === 'BET' && decision.bets) {
    let totalBetAmount = 0;

    // Track keywords for correlation detection (keyword -> count)
    const keywordCounts = new Map<string, number>();

    for (const bet of decision.bets) {
      // Validate market exists
      if (!validMarketIds.has(bet.market_id)) {
        errors.push(`Invalid market_id: ${bet.market_id}`);
        continue;
      }

      // Validate amount
      if (bet.amount < minBet) {
        errors.push(`Bet amount $${bet.amount} is below minimum $${minBet}`);
      }

      if (bet.amount > maxBet) {
        errors.push(`Bet amount $${bet.amount} exceeds per-market maximum $${maxBet.toFixed(2)} (${maxBetPercent * 100}% of balance)`);
      }

      totalBetAmount += bet.amount;

      // Check for correlated markets (allow up to MAX_SAME_TOPIC_BETS per topic)
      if (marketQuestions) {
        const question = marketQuestions.get(bet.market_id);
        if (question) {
          const keywords = extractMarketKeywords(question);
          for (const kw of keywords) {
            const count = (keywordCounts.get(kw) || 0) + 1;
            keywordCounts.set(kw, count);
            if (count > MAX_SAME_TOPIC_BETS) {
              errors.push(`Too many correlated bets: ${count} bets on "${kw}" markets (max ${MAX_SAME_TOPIC_BETS}). Diversify into independent topics.`);
            }
          }
        }
      }
    }

    // Only check that total doesn't exceed available cash
    if (totalBetAmount > cashBalance) {
      errors.push(`Total bets $${totalBetAmount.toFixed(2)} exceed cash balance $${cashBalance.toFixed(2)}`);
    }
  }

  if (decision.action === 'SELL' && decision.sells) {
    for (const sell of decision.sells) {
      if (!validPositionIds.has(sell.position_id)) {
        errors.push(`Invalid position_id: ${sell.position_id}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Filter bets to only include valid ones (removes correlated, invalid markets, etc.)
 * Returns filtered bets that can be executed even if some are invalid.
 */
export function filterValidBets(
  bets: BetInstruction[],
  cashBalance: number,
  maxBetPercent: number,
  minBet: number,
  validMarketIds: Set<string>,
  marketQuestions: Map<string, string>
): { validBets: BetInstruction[]; removedCount: number; reasons: string[] } {
  const maxBet = cashBalance * maxBetPercent;
  const validBets: BetInstruction[] = [];
  const reasons: string[] = [];

  // Track keywords for correlation - first bet per topic wins
  const usedKeywords = new Set<string>();

  for (const bet of bets) {
    // Skip invalid market
    if (!validMarketIds.has(bet.market_id)) {
      reasons.push(`Skipped bet: invalid market_id ${bet.market_id}`);
      continue;
    }

    // Skip if amount too low
    if (bet.amount < minBet) {
      reasons.push(`Skipped bet: amount $${bet.amount} below minimum $${minBet}`);
      continue;
    }

    // Cap amount at max (don't skip, just reduce)
    const cappedAmount = Math.min(bet.amount, maxBet);

    // Check correlation - skip if topic already used
    const question = marketQuestions.get(bet.market_id) || '';
    const keywords = extractMarketKeywords(question);
    const hasUsedKeyword = keywords.some(kw => usedKeywords.has(kw));

    if (hasUsedKeyword) {
      const conflictingKw = keywords.find(kw => usedKeywords.has(kw));
      reasons.push(`Skipped correlated bet on "${conflictingKw}" topic (already have one)`);
      continue;
    }

    // Mark keywords as used
    keywords.forEach(kw => usedKeywords.add(kw));

    // Add valid bet (with potentially capped amount)
    validBets.push({
      ...bet,
      amount: cappedAmount
    });
  }

  // Check total doesn't exceed cash - if so, scale down proportionally
  const totalAmount = validBets.reduce((sum, b) => sum + b.amount, 0);
  if (totalAmount > cashBalance && validBets.length > 0) {
    const scale = cashBalance / totalAmount;
    for (const bet of validBets) {
      bet.amount = Math.floor(bet.amount * scale);
    }
    reasons.push(`Scaled down all bets to fit cash balance`);
  }

  // Remove bets that became too small after scaling
  const finalBets = validBets.filter(b => b.amount >= minBet);

  return {
    validBets: finalBets,
    removedCount: bets.length - finalBets.length,
    reasons
  };
}
