/**
 * Check Resolutions Script
 *
 * Checks for resolved markets and settles positions:
 * 1. Fetches latest market data from Polymarket
 * 2. Identifies markets that have resolved
 * 3. Settles all positions on resolved markets
 * 4. Updates agent balances
 *
 * Run daily after decisions to process any resolved markets.
 *
 * Usage: npx tsx scripts/check-resolutions.ts
 *
 * @module scripts/check-resolutions
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import type { Market, Position } from '../lib/types';

// ============================================================================
// TYPES
// ============================================================================

interface PositionWithMarket extends Position {
  market: Market;
  agent: {
    id: string;
    model_id: string;
    models: {
      display_name: string;
    };
  };
}

interface ResolutionResult {
  market_id: string;
  question: string;
  outcome: string;
  outcome_price: number;
  positions_settled: number;
  total_payout: number;
}

interface SettlementResult {
  position_id: string;
  agent_id: string;
  model_name: string;
  side: string;
  shares: number;
  cost_basis: number;
  payout: number;
  pnl: number;
  pnl_percent: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get all open positions with their markets and agents
 */
async function getOpenPositions(): Promise<PositionWithMarket[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('positions')
    .select(`
      *,
      market:markets(*),
      agent:agents(
        id,
        model_id,
        models(display_name)
      )
    `)
    .eq('status', 'open');

  if (error) throw new Error(`Failed to get positions: ${error.message}`);
  return (data || []) as PositionWithMarket[];
}

/**
 * Get markets that need resolution check
 */
async function getMarketsToCheck(): Promise<Market[]> {
  const supabase = getSupabase();

  // Get active markets that have passed their close date
  const { data, error } = await supabase
    .from('markets')
    .select('*')
    .eq('status', 'active')
    .lt('close_date', new Date().toISOString());

  if (error) throw new Error(`Failed to get markets: ${error.message}`);
  return (data || []) as Market[];
}

/**
 * Check if a market has resolved by fetching fresh data from Polymarket
 */
async function checkMarketResolution(market: Market): Promise<{
  resolved: boolean;
  outcome?: 'YES' | 'NO' | string;
  outcomePrice?: number;
}> {
  try {
    // Fetch latest market data from Polymarket API
    const response = await fetch(
      `https://gamma-api.polymarket.com/markets/${market.polymarket_id}`
    );

    if (!response.ok) {
      console.log(`  Could not fetch market ${market.polymarket_id}: ${response.status}`);
      return { resolved: false };
    }

    const data = await response.json() as {
      closed?: boolean;
      resolved?: boolean;
      outcome?: string;
      outcomePrices?: string[];
    };

    // Check if market has resolved
    if (data.resolved && data.outcome) {
      // For binary markets, outcome is typically YES or NO
      const outcome = data.outcome.toUpperCase();
      const outcomePrice = outcome === 'YES' ? 1 : (outcome === 'NO' ? 0 : undefined);

      return {
        resolved: true,
        outcome,
        outcomePrice: outcomePrice ?? (data.outcomePrices ? parseFloat(data.outcomePrices[0]) : undefined)
      };
    }

    return { resolved: false };
  } catch (error) {
    console.error(`  Error checking market ${market.id}:`, error);
    return { resolved: false };
  }
}

/**
 * Settle a position based on market resolution
 */
async function settlePosition(
  position: PositionWithMarket,
  outcome: string,
  outcomePrice: number
): Promise<SettlementResult> {
  const supabase = getSupabase();

  // Calculate payout
  // If position.side matches outcome, shares pay out at $1 each
  // Otherwise shares are worthless
  const won = position.side === outcome;
  const payout = won ? position.shares : 0;
  const pnl = payout - position.total_cost;
  const pnlPercent = position.total_cost > 0 ? (pnl / position.total_cost) * 100 : 0;

  // Update position to closed
  const { error: positionError } = await supabase
    .from('positions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      close_price: outcomePrice,
      realized_pnl: pnl
    })
    .eq('id', position.id);

  if (positionError) {
    throw new Error(`Failed to close position: ${positionError.message}`);
  }

  // Add payout to agent's cash balance
  const { error: balanceError } = await supabase.rpc('update_agent_balance', {
    p_agent_id: position.agent_id,
    p_amount: payout
  });

  if (balanceError) {
    console.error(`  Warning: Failed to update balance for agent ${position.agent_id}: ${balanceError.message}`);
    // Fallback: direct update
    const { data: agent } = await supabase
      .from('agents')
      .select('cash_balance')
      .eq('id', position.agent_id)
      .single();

    if (agent) {
      await supabase
        .from('agents')
        .update({ cash_balance: agent.cash_balance + payout })
        .eq('id', position.agent_id);
    }
  }

  // Record the settlement trade
  await supabase.from('trades').insert({
    agent_id: position.agent_id,
    position_id: position.id,
    market_id: position.market_id,
    trade_type: 'settlement',
    side: position.side,
    shares: position.shares,
    price: outcomePrice,
    total_amount: payout,
    cost_basis: position.total_cost,
    realized_pnl: pnl,
    executed_at: new Date().toISOString()
  });

  // Update total_invested (recalculate from open positions)
  await supabase.rpc('update_agent_invested', { agent_id: position.agent_id });

  return {
    position_id: position.id,
    agent_id: position.agent_id,
    model_name: position.agent.models.display_name,
    side: position.side,
    shares: position.shares,
    cost_basis: position.total_cost,
    payout,
    pnl,
    pnl_percent: pnlPercent
  };
}

/**
 * Update market status to resolved
 */
async function resolveMarket(
  marketId: string,
  outcome: string,
  outcomePrice: number
): Promise<void> {
  const supabase = getSupabase();

  await supabase
    .from('markets')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_outcome: outcome,
      current_price: outcomePrice  // Final price (1 for YES win, 0 for NO win)
    })
    .eq('id', marketId);
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function checkResolutions() {
  console.log('='.repeat(60));
  console.log('CHECK RESOLUTIONS');
  console.log('='.repeat(60));

  const startTime = Date.now();
  const results: ResolutionResult[] = [];
  const settlements: SettlementResult[] = [];
  let marketsChecked = 0;
  let marketsResolved = 0;
  let positionsSettled = 0;
  let totalPayout = 0;
  const errors: string[] = [];

  try {
    // Get all open positions grouped by market
    console.log('\nFetching open positions...');
    const openPositions = await getOpenPositions();
    console.log(`Found ${openPositions.length} open positions`);

    // Get unique markets from positions
    const marketIds = [...new Set(openPositions.map(p => p.market_id))];
    console.log(`Across ${marketIds.length} markets with positions`);

    // Also check markets past close date
    console.log('\nChecking for markets past close date...');
    const expiredMarkets = await getMarketsToCheck();
    console.log(`Found ${expiredMarkets.length} markets past close date`);

    // Combine market IDs to check
    const allMarketIds = [...new Set([
      ...marketIds,
      ...expiredMarkets.map(m => m.id)
    ])];

    console.log(`\nTotal markets to check: ${allMarketIds.length}\n`);

    // Process each market
    for (const marketId of allMarketIds) {
      // Get market data
      const position = openPositions.find(p => p.market_id === marketId);
      const market = position?.market || expiredMarkets.find(m => m.id === marketId);

      if (!market) continue;

      console.log(`Checking: ${market.question.slice(0, 50)}...`);
      marketsChecked++;

      // Check resolution status
      const resolution = await checkMarketResolution(market);

      if (resolution.resolved && resolution.outcome && resolution.outcomePrice !== undefined) {
        console.log(`  ✓ RESOLVED: ${resolution.outcome}`);
        marketsResolved++;

        // Update market status
        await resolveMarket(marketId, resolution.outcome, resolution.outcomePrice);

        // Get all positions on this market
        const marketPositions = openPositions.filter(p => p.market_id === marketId);

        const resolutionResult: ResolutionResult = {
          market_id: marketId,
          question: market.question,
          outcome: resolution.outcome,
          outcome_price: resolution.outcomePrice,
          positions_settled: 0,
          total_payout: 0
        };

        // Settle each position
        for (const pos of marketPositions) {
          try {
            // Settle position
            const settlement = await settlePosition(pos, resolution.outcome, resolution.outcomePrice);
            settlements.push(settlement);

            resolutionResult.positions_settled++;
            resolutionResult.total_payout += settlement.payout;
            positionsSettled++;
            totalPayout += settlement.payout;

            console.log(`    ${settlement.model_name}: ${settlement.side} ${settlement.shares.toFixed(2)} shares → $${settlement.payout.toFixed(2)} (${settlement.pnl >= 0 ? '+' : ''}$${settlement.pnl.toFixed(2)})`);
          } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            errors.push(`Position ${pos.id}: ${errMsg}`);
            console.error(`    Error settling position: ${errMsg}`);
          }
        }

        results.push(resolutionResult);
      } else {
        console.log(`  - Not resolved yet`);
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Log results
    await logSystemEvent('resolutions_check', {
      markets_checked: marketsChecked,
      markets_resolved: marketsResolved,
      positions_settled: positionsSettled,
      total_payout: totalPayout,
      duration_ms: Date.now() - startTime,
      errors_count: errors.length
    });

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    errors.push(errMsg);
    console.error('\nFatal error:', errMsg);

    await logSystemEvent('resolutions_error', {
      error: errMsg
    }, 'error');
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('RESOLUTION CHECK COMPLETE');
  console.log('='.repeat(60));
  console.log(`Markets Checked: ${marketsChecked}`);
  console.log(`Markets Resolved: ${marketsResolved}`);
  console.log(`Positions Settled: ${positionsSettled}`);
  console.log(`Total Payout: $${totalPayout.toFixed(2)}`);
  console.log(`Duration: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);

  if (settlements.length > 0) {
    console.log('\nSettlement Summary by Model:');
    const byModel = settlements.reduce((acc, s) => {
      if (!acc[s.model_name]) {
        acc[s.model_name] = { payout: 0, pnl: 0, count: 0 };
      }
      acc[s.model_name].payout += s.payout;
      acc[s.model_name].pnl += s.pnl;
      acc[s.model_name].count++;
      return acc;
    }, {} as Record<string, { payout: number; pnl: number; count: number }>);

    for (const [model, stats] of Object.entries(byModel)) {
      const pnlSign = stats.pnl >= 0 ? '+' : '';
      console.log(`  ${model}: ${stats.count} positions, $${stats.payout.toFixed(2)} payout (${pnlSign}$${stats.pnl.toFixed(2)} P&L)`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    errors.forEach(e => console.log(`  - ${e}`));
  }

  return {
    markets_checked: marketsChecked,
    markets_resolved: marketsResolved,
    positions_settled: positionsSettled,
    total_payout: totalPayout,
    errors
  };
}

// Run if called directly
checkResolutions()
  .then((result) => {
    if (result.errors.length === 0) {
      console.log('\nResolution check completed successfully!');
      process.exit(0);
    } else {
      console.log('\nResolution check completed with errors');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('\nFailed to check resolutions:', error);
    process.exit(1);
  });
