/**
 * Reset Season Script
 *
 * Resets or deletes season data for testing purposes.
 *
 * Usage:
 *   npx tsx scripts/reset-season.ts --soft          # Reset balances to $10k, keep history
 *   npx tsx scripts/reset-season.ts --hard          # Delete all data, start fresh
 *   npx tsx scripts/reset-season.ts --hard --keep-markets  # Delete season data but keep markets
 *
 * @module scripts/reset-season
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import { INITIAL_BALANCE } from '../lib/constants';

// ============================================================================
// TYPES
// ============================================================================

interface ResetOptions {
  mode: 'soft' | 'hard';
  keepMarkets: boolean;
  seasonId?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function parseArgs(): ResetOptions {
  const args = process.argv.slice(2);
  const options: ResetOptions = {
    mode: 'soft',
    keepMarkets: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--soft') {
      options.mode = 'soft';
    } else if (args[i] === '--hard') {
      options.mode = 'hard';
    } else if (args[i] === '--keep-markets') {
      options.keepMarkets = true;
    } else if (args[i] === '--season' && args[i + 1]) {
      options.seasonId = args[i + 1];
      i++;
    }
  }

  return options;
}

async function getActiveSeason(): Promise<{ id: string; season_number: number } | null> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from('seasons')
    .select('id, season_number')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return data;
}

// ============================================================================
// SOFT RESET
// ============================================================================

async function softReset(seasonId: string): Promise<void> {
  const supabase = getSupabase();

  console.log('Performing SOFT RESET...');
  console.log('This will:');
  console.log('  - Reset all agent balances to $10,000');
  console.log('  - Close all open positions');
  console.log('  - Keep all historical data (decisions, trades, etc.)');
  console.log('');

  // Reset agent balances
  console.log('Resetting agent balances...');
  const { error: agentError } = await supabase
    .from('agents')
    .update({
      cash_balance: INITIAL_BALANCE,
      total_invested: 0,
      status: 'active'
    })
    .eq('season_id', seasonId);

  if (agentError) {
    throw new Error(`Failed to reset agents: ${agentError.message}`);
  }

  // Close all open positions
  console.log('Closing open positions...');
  const { data: agents } = await supabase
    .from('agents')
    .select('id')
    .eq('season_id', seasonId);

  if (agents) {
    for (const agent of agents) {
      await supabase
        .from('positions')
        .update({
          status: 'closed',
          closed_at: new Date().toISOString()
        })
        .eq('agent_id', agent.id)
        .eq('status', 'open');
    }
  }

  await logSystemEvent('season_soft_reset', { season_id: seasonId });
  console.log('Soft reset complete!');
}

// ============================================================================
// HARD RESET
// ============================================================================

async function hardReset(keepMarkets: boolean): Promise<void> {
  const supabase = getSupabase();

  console.log('Performing HARD RESET...');
  console.log('This will DELETE:');
  console.log('  - All seasons');
  console.log('  - All agents');
  console.log('  - All decisions');
  console.log('  - All trades');
  console.log('  - All positions');
  console.log('  - All portfolio snapshots');
  console.log('  - All API costs');
  console.log('  - All system logs');
  if (!keepMarkets) {
    console.log('  - All markets');
  }
  console.log('');

  // Delete in order (foreign key constraints)
  console.log('Deleting api_costs...');
  await supabase.from('api_costs').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting portfolio_snapshots...');
  await supabase.from('portfolio_snapshots').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting trades...');
  await supabase.from('trades').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting positions...');
  await supabase.from('positions').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting decisions...');
  await supabase.from('decisions').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting agents...');
  await supabase.from('agents').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting seasons...');
  await supabase.from('seasons').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  console.log('Deleting system_logs...');
  await supabase.from('system_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  if (!keepMarkets) {
    console.log('Deleting markets...');
    await supabase.from('markets').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }

  console.log('Hard reset complete!');
}

// ============================================================================
// SHOW STATUS
// ============================================================================

async function showStatus(): Promise<void> {
  const supabase = getSupabase();

  console.log('\nCurrent Database Status:');
  console.log('-'.repeat(40));

  const tables = ['seasons', 'agents', 'markets', 'decisions', 'trades', 'positions'];

  for (const table of tables) {
    const { count } = await supabase
      .from(table)
      .select('*', { count: 'exact', head: true });

    console.log(`  ${table}: ${count ?? 0} rows`);
  }

  const season = await getActiveSeason();
  if (season) {
    console.log(`\nActive Season: #${season.season_number} (${season.id})`);
  } else {
    console.log('\nNo active season');
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function resetSeason() {
  const options = parseArgs();

  console.log('='.repeat(60));
  console.log('RESET SEASON');
  console.log('='.repeat(60));

  await showStatus();

  if (options.mode === 'hard') {
    console.log('\n⚠️  WARNING: This will DELETE all data!');
    console.log('Press Ctrl+C within 3 seconds to cancel...\n');

    await new Promise(resolve => setTimeout(resolve, 3000));

    await hardReset(options.keepMarkets);
  } else {
    const season = await getActiveSeason();
    if (!season) {
      console.log('\nNo active season to reset. Run start-season first.');
      return;
    }

    await softReset(season.id);
  }

  await showStatus();
}

resetSeason().catch(console.error);
