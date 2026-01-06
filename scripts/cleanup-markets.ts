/**
 * Cleanup Markets Script
 *
 * Removes stale markets that:
 * - Have no activity (no trades or positions)
 * - Haven't been synced in 30+ days
 * - Are not active (closed/resolved)
 *
 * Markets with any activity are NEVER deleted.
 *
 * Usage: npx tsx scripts/cleanup-markets.ts [--dry-run]
 *
 * @module scripts/cleanup-markets
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';

interface CleanupResult {
  total_candidates: number;
  deleted: number;
  price_history_deleted: number;
  skipped_with_activity: number;
  duration_ms: number;
}

const DAYS_THRESHOLD = 30;

/**
 * Main cleanup function
 */
async function cleanupMarkets(dryRun: boolean = false): Promise<CleanupResult> {
  const startTime = Date.now();
  const supabase = getSupabase();

  console.log('='.repeat(60));
  console.log(`CLEANUP MARKETS - ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('='.repeat(60));

  const result: CleanupResult = {
    total_candidates: 0,
    deleted: 0,
    price_history_deleted: 0,
    skipped_with_activity: 0,
    duration_ms: 0
  };

  try {
    // Calculate threshold date
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - DAYS_THRESHOLD);
    const thresholdIso = thresholdDate.toISOString();

    console.log(`\nThreshold: Markets not synced since ${thresholdDate.toDateString()}`);

    // Find stale markets without activity
    // Criteria: has_activity = false, last_synced_at < 30 days ago, status != 'active'
    const { data: candidates, error: fetchError } = await supabase
      .from('markets')
      .select('id, polymarket_id, question, status, last_synced_at, has_activity')
      .eq('has_activity', false)
      .neq('status', 'active')
      .lt('last_synced_at', thresholdIso);

    if (fetchError) {
      throw new Error(`Failed to fetch cleanup candidates: ${fetchError.message}`);
    }

    result.total_candidates = candidates?.length || 0;
    console.log(`Found ${result.total_candidates} cleanup candidates\n`);

    if (result.total_candidates === 0) {
      console.log('No markets to clean up.');
      result.duration_ms = Date.now() - startTime;
      return result;
    }

    // Double-check each market for activity (safety check)
    for (const market of candidates || []) {
      // Verify no trades exist
      const { count: tradeCount } = await supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('market_id', market.id);

      // Verify no positions exist
      const { count: positionCount } = await supabase
        .from('positions')
        .select('id', { count: 'exact', head: true })
        .eq('market_id', market.id);

      if ((tradeCount || 0) > 0 || (positionCount || 0) > 0) {
        // This shouldn't happen if has_activity flag is correct, but safety first
        console.log(`SKIP: ${market.polymarket_id} - has ${tradeCount} trades, ${positionCount} positions`);
        result.skipped_with_activity++;

        // Fix the has_activity flag
        if (!dryRun) {
          await supabase
            .from('markets')
            .update({ has_activity: true })
            .eq('id', market.id);
        }
        continue;
      }

      console.log(`${dryRun ? '[DRY RUN] Would delete' : 'Deleting'}: ${market.status} - "${market.question?.slice(0, 50)}..."`);

      if (!dryRun) {
        // Delete price history first (FK constraint)
        const { count: priceHistoryCount } = await supabase
          .from('market_price_history')
          .select('id', { count: 'exact', head: true })
          .eq('market_id', market.id);

        if (priceHistoryCount && priceHistoryCount > 0) {
          await supabase
            .from('market_price_history')
            .delete()
            .eq('market_id', market.id);
          result.price_history_deleted += priceHistoryCount;
        }

        // Delete the market
        const { error: deleteError } = await supabase
          .from('markets')
          .delete()
          .eq('id', market.id);

        if (deleteError) {
          console.error(`  Failed: ${deleteError.message}`);
        } else {
          result.deleted++;
        }
      } else {
        result.deleted++; // Count as "would delete" in dry run
      }
    }

    result.duration_ms = Date.now() - startTime;

    // Log summary
    console.log('\n' + '='.repeat(60));
    console.log(`CLEANUP MARKETS - ${dryRun ? 'DRY RUN' : 'Complete'}`);
    console.log('='.repeat(60));
    console.log(`Candidates:           ${result.total_candidates}`);
    console.log(`${dryRun ? 'Would delete' : 'Deleted'}:        ${result.deleted}`);
    console.log(`Price history:        ${result.price_history_deleted}`);
    console.log(`Skipped (has activity): ${result.skipped_with_activity}`);
    console.log(`Duration:             ${(result.duration_ms / 1000).toFixed(2)}s`);

    // Log to system_logs (only for actual runs)
    if (!dryRun) {
      await logSystemEvent('cleanup_markets_complete', result);
    }

  } catch (error) {
    result.duration_ms = Date.now() - startTime;

    console.error('Fatal error:', error);

    await logSystemEvent('cleanup_markets_error', {
      error: error instanceof Error ? error.message : String(error),
      ...result
    }, 'error');

    throw error;
  }

  return result;
}

// Parse arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// Run
cleanupMarkets(dryRun)
  .then((result) => {
    console.log('\nCleanup completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nCleanup failed:', error);
    process.exit(1);
  });
