/**
 * Trade Execution Engine
 *
 * Executes trades (buys and sells) and updates portfolio state.
 * Paper trading only - no real money involved.
 *
 * @module execution
 */

import { getSupabase } from './supabase';
import { validateBetAmount, MIN_BET, MAX_BET_PERCENT } from './constants';
import type {
  BetInstruction,
  SellInstruction,
  TradeResult,
  SellResult,
  Position,
  Market
} from './types';

// ============================================================================
// BUY EXECUTION
// ============================================================================

/**
 * Execute a buy trade (place a bet)
 */
export async function executeBuy(
  agentId: string,
  instruction: BetInstruction,
  cashBalance: number,
  decisionId?: string
): Promise<TradeResult> {
  const supabase = getSupabase();

  // Validate bet amount
  const validation = validateBetAmount(instruction.amount, cashBalance);
  if (!validation.valid && !validation.adjustedAmount) {
    return { success: false, error: validation.error };
  }

  const betAmount = validation.adjustedAmount ?? instruction.amount;

  // Get market info
  const { data: market, error: marketError } = await supabase
    .from('markets')
    .select('*')
    .eq('id', instruction.market_id)
    .single();

  if (marketError || !market) {
    return { success: false, error: `Market not found: ${instruction.market_id}` };
  }

  if (market.status !== 'active') {
    return { success: false, error: `Market is not active: ${market.status}` };
  }

  // Get current price for the side
  let price: number;
  if (market.market_type === 'binary') {
    const yesPrice = market.current_price ?? 0.5;
    price = instruction.side === 'YES' ? yesPrice : (1 - yesPrice);
  } else {
    price = market.current_prices?.[instruction.side] ?? 0.5;
  }

  if (price <= 0 || price >= 1) {
    return { success: false, error: `Invalid price for side ${instruction.side}: ${price}` };
  }

  // Calculate shares
  const shares = betAmount / price;

  // Check for existing position in same market/side
  const { data: existingPosition } = await supabase
    .from('positions')
    .select('*')
    .eq('agent_id', agentId)
    .eq('market_id', instruction.market_id)
    .eq('side', instruction.side)
    .eq('status', 'open')
    .single();

  let positionId: string;

  if (existingPosition) {
    // Update existing position (average in)
    const newShares = existingPosition.shares + shares;
    const newTotalCost = existingPosition.total_cost + betAmount;
    const newAvgPrice = newTotalCost / newShares;

    const { error: updateError } = await supabase
      .from('positions')
      .update({
        shares: newShares,
        total_cost: newTotalCost,
        avg_entry_price: newAvgPrice
      })
      .eq('id', existingPosition.id);

    if (updateError) {
      return { success: false, error: `Failed to update position: ${updateError.message}` };
    }

    positionId = existingPosition.id;
  } else {
    // Create new position
    const { data: newPosition, error: positionError } = await supabase
      .from('positions')
      .insert({
        agent_id: agentId,
        market_id: instruction.market_id,
        side: instruction.side,
        shares,
        avg_entry_price: price,
        total_cost: betAmount,
        status: 'open'
      })
      .select()
      .single();

    if (positionError || !newPosition) {
      return { success: false, error: `Failed to create position: ${positionError?.message}` };
    }

    positionId = newPosition.id;
  }

  // Record trade
  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .insert({
      agent_id: agentId,
      market_id: instruction.market_id,
      position_id: positionId,
      decision_id: decisionId || null,
      trade_type: 'BUY',
      side: instruction.side,
      shares,
      price,
      total_amount: betAmount,
      implied_confidence: price
    })
    .select()
    .single();

  if (tradeError) {
    return { success: false, error: `Failed to record trade: ${tradeError.message}` };
  }

  // Update agent balance (use RPC for atomic relative update to prevent race conditions)
  const { error: agentError } = await supabase.rpc('update_agent_balance', {
    p_agent_id: agentId,
    p_amount: -betAmount
  });

  if (agentError) {
    console.error('Failed to update agent balance:', agentError);
  }

  // Update total_invested separately
  await supabase.rpc('update_agent_invested', { agent_id: agentId });

  return {
    success: true,
    trade_id: trade.id,
    position_id: positionId,
    shares
  };
}

// ============================================================================
// SELL EXECUTION
// ============================================================================

/**
 * Execute a sell trade
 */
export async function executeSell(
  agentId: string,
  instruction: SellInstruction,
  decisionId?: string
): Promise<SellResult> {
  const supabase = getSupabase();

  // Get position
  const { data: position, error: posError } = await supabase
    .from('positions')
    .select('*, markets(*)')
    .eq('id', instruction.position_id)
    .eq('agent_id', agentId)
    .eq('status', 'open')
    .single();

  if (posError || !position) {
    return { success: false, error: `Position not found: ${instruction.position_id}` };
  }

  const market = position.markets as Market;

  // Calculate shares to sell
  const sharesToSell = position.shares * (instruction.percentage / 100);

  // Get current price
  let currentPrice: number;
  if (market.market_type === 'binary') {
    const yesPrice = market.current_price ?? 0.5;
    currentPrice = position.side === 'YES' ? yesPrice : (1 - yesPrice);
  } else {
    currentPrice = market.current_prices?.[position.side] ?? 0.5;
  }

  // Calculate proceeds and P&L
  const proceeds = sharesToSell * currentPrice;
  const costBasis = (position.total_cost / position.shares) * sharesToSell;
  const realizedPnl = proceeds - costBasis;

  // Update or close position
  const remainingShares = position.shares - sharesToSell;

  if (remainingShares < 0.001) {
    // Close position fully
    const { error: closeError } = await supabase
      .from('positions')
      .update({
        status: 'closed',
        shares: 0,
        closed_at: new Date().toISOString()
      })
      .eq('id', position.id);

    if (closeError) {
      return { success: false, error: `Failed to close position: ${closeError.message}` };
    }
  } else {
    // Partial sell
    const remainingCost = position.total_cost - costBasis;

    const { error: updateError } = await supabase
      .from('positions')
      .update({
        shares: remainingShares,
        total_cost: remainingCost
      })
      .eq('id', position.id);

    if (updateError) {
      return { success: false, error: `Failed to update position: ${updateError.message}` };
    }
  }

  // Record trade
  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .insert({
      agent_id: agentId,
      market_id: market.id,
      position_id: position.id,
      decision_id: decisionId || null,
      trade_type: 'SELL',
      side: position.side,
      shares: sharesToSell,
      price: currentPrice,
      total_amount: proceeds,
      cost_basis: costBasis,
      realized_pnl: realizedPnl
    })
    .select()
    .single();

  if (tradeError) {
    return { success: false, error: `Failed to record trade: ${tradeError.message}` };
  }

  // Get current agent balance
  const { data: agent } = await supabase
    .from('agents')
    .select('cash_balance')
    .eq('id', agentId)
    .single();

  // Update agent balance
  const { error: agentError } = await supabase
    .from('agents')
    .update({
      cash_balance: (agent?.cash_balance ?? 0) + proceeds
    })
    .eq('id', agentId);

  if (agentError) {
    console.error('Failed to update agent balance:', agentError);
  }

  // Update total_invested
  await supabase.rpc('update_agent_invested', { agent_id: agentId });

  return {
    success: true,
    trade_id: trade.id,
    proceeds,
    shares_sold: sharesToSell
  };
}

// ============================================================================
// BATCH EXECUTION
// ============================================================================

/**
 * Execute multiple buy orders
 */
export async function executeBuys(
  agentId: string,
  bets: BetInstruction[],
  initialCashBalance: number,
  decisionId?: string
): Promise<{ results: TradeResult[]; totalSpent: number }> {
  const results: TradeResult[] = [];
  let cashBalance = initialCashBalance;

  for (const bet of bets) {
    const result = await executeBuy(agentId, bet, cashBalance, decisionId);
    results.push(result);

    if (result.success && result.shares) {
      // Deduct from available balance for next bet
      const spent = bet.amount;
      cashBalance -= spent;
    }
  }

  const totalSpent = initialCashBalance - cashBalance;
  return { results, totalSpent };
}

/**
 * Execute multiple sell orders
 */
export async function executeSells(
  agentId: string,
  sells: SellInstruction[],
  decisionId?: string
): Promise<{ results: SellResult[]; totalProceeds: number }> {
  const results: SellResult[] = [];
  let totalProceeds = 0;

  for (const sell of sells) {
    const result = await executeSell(agentId, sell, decisionId);
    results.push(result);

    if (result.success && result.proceeds) {
      totalProceeds += result.proceeds;
    }
  }

  return { results, totalProceeds };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get agent's current cash balance
 */
export async function getAgentBalance(agentId: string): Promise<number> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('agents')
    .select('cash_balance')
    .eq('id', agentId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to get agent balance: ${error?.message}`);
  }

  return data.cash_balance;
}

/**
 * Get agent's open positions with market info
 */
export async function getAgentPositions(agentId: string): Promise<(Position & { market: Market })[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('positions')
    .select('*, markets(*)')
    .eq('agent_id', agentId)
    .eq('status', 'open');

  if (error) {
    throw new Error(`Failed to get agent positions: ${error.message}`);
  }

  return (data || []).map(p => ({
    ...p,
    market: p.markets as Market
  }));
}
