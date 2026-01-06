/**
 * Take Snapshots Script
 *
 * Takes portfolio snapshots for all agents - calculates current value
 * of all positions based on latest market prices and saves to
 * portfolio_snapshots table for historical charts.
 *
 * Usage: npx tsx scripts/take-snapshots.ts
 *
 * Should run every 10 minutes (after sync-markets updates prices).
 *
 * @module scripts/take-snapshots
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import { INITIAL_BALANCE } from '../lib/constants';

// ============================================================================
// TYPES
// ============================================================================

interface Agent {
  id: string;
  model_id: string;
  cash_balance: number;
  status: string;
}

interface Position {
  id: string;
  agent_id: string;
  market_id: string;
  side: string;
  shares: number;
  avg_entry_price: number;
  total_cost: number;
  current_value: number | null;
}

interface Market {
  id: string;
  current_price: number | null;
  status: string;
}

interface SnapshotResult {
  snapshots_taken: number;
  positions_updated: number;
  errors: string[];
  duration_ms: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get active season
 */
async function getActiveSeason(): Promise<{ id: string } | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('seasons')
    .select('id')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Get all agents in season
 */
async function getAgentsBySeason(seasonId: string): Promise<Agent[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('agents')
    .select('id, model_id, cash_balance, status')
    .eq('season_id', seasonId);

  if (error) throw new Error(`Failed to get agents: ${error.message}`);
  return (data || []) as Agent[];
}

/**
 * Get all open positions for an agent
 */
async function getOpenPositions(agentId: string): Promise<Position[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('positions')
    .select('id, agent_id, market_id, side, shares, avg_entry_price, total_cost, current_value')
    .eq('agent_id', agentId)
    .eq('status', 'open');

  if (error) throw new Error(`Failed to get positions: ${error.message}`);
  return (data || []) as Position[];
}

/**
 * Get market by ID
 */
async function getMarketById(marketId: string): Promise<Market | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('markets')
    .select('id, current_price, status')
    .eq('id', marketId)
    .single();

  if (error) return null;
  return data as Market;
}

/**
 * Calculate position value based on current market price
 */
function calculatePositionValue(
  shares: number,
  side: string,
  currentPrice: number
): number {
  // For YES positions: value = shares * price
  // For NO positions: value = shares * (1 - price)
  const effectivePrice = side.toUpperCase() === 'YES' ? currentPrice : (1 - currentPrice);
  return shares * effectivePrice;
}

/**
 * Update position MTM (mark-to-market)
 */
async function updatePositionMTM(
  positionId: string,
  currentValue: number,
  unrealizedPnl: number
): Promise<void> {
  const supabase = getSupabase();

  await supabase
    .from('positions')
    .update({
      current_value: currentValue,
      unrealized_pnl: unrealizedPnl
    })
    .eq('id', positionId);
}

/**
 * Create portfolio snapshot
 */
async function createSnapshot(snapshot: {
  agent_id: string;
  snapshot_timestamp: string;
  cash_balance: number;
  positions_value: number;
  total_value: number;
  total_pnl: number;
  total_pnl_percent: number;
}): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('portfolio_snapshots')
    .insert(snapshot);

  if (error) {
    throw new Error(`Failed to create snapshot: ${error.message}`);
  }
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function takeSnapshots(): Promise<SnapshotResult> {
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('TAKE SNAPSHOTS');
  console.log('='.repeat(60));

  const result: SnapshotResult = {
    snapshots_taken: 0,
    positions_updated: 0,
    errors: [],
    duration_ms: 0
  };

  try {
    // Get active season
    const season = await getActiveSeason();
    if (!season) {
      console.log('No active season found. Nothing to snapshot.');
      result.duration_ms = Date.now() - startTime;
      return result;
    }

    console.log(`Season: ${season.id}`);

    const snapshotTimestamp = new Date().toISOString();
    const agents = await getAgentsBySeason(season.id);

    console.log(`Processing ${agents.length} agents...`);

    for (const agent of agents) {
      try {
        // Get open positions
        const positions = await getOpenPositions(agent.id);
        let positionsValue = 0;

        // Calculate value for each position
        for (const position of positions) {
          const market = await getMarketById(position.market_id);
          if (!market) continue;

          // Get current price (fallback to entry price if not available)
          let currentPrice = market.current_price;

          if (currentPrice === null || currentPrice === undefined) {
            // Fallback: derive from prior value or use entry price
            if (position.current_value !== null && position.shares > 0) {
              const valuePerShare = position.current_value / position.shares;
              currentPrice = position.side.toUpperCase() === 'YES'
                ? valuePerShare
                : (1 - valuePerShare);
            } else {
              currentPrice = position.avg_entry_price;
            }
            console.warn(`  Using fallback price ${currentPrice.toFixed(4)} for position ${position.id}`);
          }

          // Ensure price is valid
          currentPrice = Math.max(0, Math.min(1, currentPrice));

          // Calculate current value
          const value = calculatePositionValue(
            position.shares,
            position.side,
            currentPrice
          );
          const unrealizedPnl = value - position.total_cost;

          // Update position MTM
          await updatePositionMTM(position.id, value, unrealizedPnl);
          positionsValue += value;
          result.positions_updated++;
        }

        // Calculate totals
        const cashBalance = Number(agent.cash_balance);
        const totalValue = cashBalance + positionsValue;
        const totalPnl = totalValue - INITIAL_BALANCE;
        const totalPnlPercent = (totalPnl / INITIAL_BALANCE) * 100;

        // Create snapshot
        await createSnapshot({
          agent_id: agent.id,
          snapshot_timestamp: snapshotTimestamp,
          cash_balance: cashBalance,
          positions_value: positionsValue,
          total_value: totalValue,
          total_pnl: totalPnl,
          total_pnl_percent: totalPnlPercent
        });

        result.snapshots_taken++;

        console.log(`  ${agent.model_id}: $${totalValue.toFixed(2)} (${totalPnl >= 0 ? '+' : ''}${totalPnlPercent.toFixed(1)}%)`);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Agent ${agent.id}: ${message}`);
        console.error(`  Error for agent ${agent.id}: ${message}`);
      }
    }

    result.duration_ms = Date.now() - startTime;

    // Log system event
    await logSystemEvent('snapshots_taken', {
      snapshots: result.snapshots_taken,
      positions_updated: result.positions_updated,
      errors: result.errors.length,
      duration_ms: result.duration_ms
    });

  } catch (error) {
    result.duration_ms = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMsg);
    console.error('Fatal error:', errorMsg);

    await logSystemEvent('take_snapshots_error', { error: errorMsg }, 'error');
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SNAPSHOTS COMPLETE');
  console.log('='.repeat(60));
  console.log(`Snapshots taken: ${result.snapshots_taken}`);
  console.log(`Positions updated: ${result.positions_updated}`);
  console.log(`Duration: ${result.duration_ms}ms`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    result.errors.forEach(e => console.log(`  - ${e}`));
  }

  return result;
}

// Run if called directly
takeSnapshots()
  .then((result) => {
    if (result.errors.length === 0) {
      console.log('\nSnapshots completed successfully!');
      process.exit(0);
    } else {
      console.log('\nSnapshots completed with errors');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('\nFailed to take snapshots:', error);
    process.exit(1);
  });
