/**
 * Fix Missing Event Slugs Script (ONE-TIME MIGRATION)
 *
 * Fetches all events from Polymarket, builds a lookup map,
 * and fixes markets with missing event_slug.
 *
 * Usage: npx tsx scripts/fix-event-slugs.ts
 *
 * @module scripts/fix-event-slugs
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import { fetchEvents } from '../lib/polymarket';
import { API_DELAYS } from '../lib/constants';

interface FixResult {
  total_broken: number;
  fixed: number;
  unfixable_with_activity: number;
  deleted_without_activity: number;
  duration_ms: number;
}

/**
 * Fetch many events to build comprehensive lookup map
 */
async function buildEventSlugMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  console.log('Building event slug lookup map...');

  // Fetch events in batches
  const batchSize = 100;
  let offset = 0;
  let totalEvents = 0;

  while (true) {
    try {
      const events = await fetchEvents(batchSize, offset);

      if (events.length === 0) break;

      for (const event of events) {
        if (!event.slug) continue;

        // Map each market in the event to the event's slug
        for (const market of event.markets || []) {
          const marketId = market.id || market.conditionId;
          if (marketId) {
            map.set(marketId, event.slug);
          }
        }
      }

      totalEvents += events.length;
      offset += batchSize;

      console.log(`Fetched ${totalEvents} events, map has ${map.size} markets`);

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, API_DELAYS.POLYMARKET_BETWEEN_REQUESTS));

      // Stop after reasonable number of events
      if (totalEvents >= 1000) {
        console.log('Reached 1000 events limit');
        break;
      }
    } catch (error) {
      console.error(`Error fetching events at offset ${offset}:`, error);
      break;
    }
  }

  console.log(`Final map: ${map.size} markets from ${totalEvents} events`);
  return map;
}

/**
 * Main fix function
 */
async function fixEventSlugs(): Promise<FixResult> {
  const startTime = Date.now();
  const supabase = getSupabase();

  console.log('='.repeat(60));
  console.log('FIX EVENT SLUGS - Starting');
  console.log('='.repeat(60));

  const result: FixResult = {
    total_broken: 0,
    fixed: 0,
    unfixable_with_activity: 0,
    deleted_without_activity: 0,
    duration_ms: 0
  };

  try {
    // Step 1: Build lookup map from Polymarket events
    const eventSlugMap = await buildEventSlugMap();

    // Step 2: Get all markets without event_slug
    const { data: brokenMarkets, error: fetchError } = await supabase
      .from('markets')
      .select('id, polymarket_id, question, has_activity')
      .is('event_slug', null);

    if (fetchError) {
      throw new Error(`Failed to fetch broken markets: ${fetchError.message}`);
    }

    result.total_broken = brokenMarkets?.length || 0;
    console.log(`\nFound ${result.total_broken} markets without event_slug`);

    // Step 3: Process each broken market
    for (const market of brokenMarkets || []) {
      const eventSlug = eventSlugMap.get(market.polymarket_id);

      if (eventSlug) {
        // Found in map - fix it!
        const { error: updateError } = await supabase
          .from('markets')
          .update({ event_slug: eventSlug })
          .eq('id', market.id);

        if (updateError) {
          console.error(`Failed to update market ${market.polymarket_id}:`, updateError.message);
        } else {
          result.fixed++;
          if (result.fixed % 50 === 0) {
            console.log(`Fixed ${result.fixed} markets so far...`);
          }
        }
      } else if (market.has_activity) {
        // Not found but has activity - can't delete, log warning
        result.unfixable_with_activity++;
        console.warn(`UNFIXABLE: ${market.polymarket_id} - "${market.question?.slice(0, 50)}..." (has activity)`);
      } else {
        // Not found and no activity - safe to delete
        // First delete price history
        await supabase
          .from('market_price_history')
          .delete()
          .eq('market_id', market.id);

        // Then delete market
        const { error: deleteError } = await supabase
          .from('markets')
          .delete()
          .eq('id', market.id);

        if (deleteError) {
          console.error(`Failed to delete market ${market.polymarket_id}:`, deleteError.message);
        } else {
          result.deleted_without_activity++;
        }
      }
    }

    result.duration_ms = Date.now() - startTime;

    // Log summary
    console.log('\n' + '='.repeat(60));
    console.log('FIX EVENT SLUGS - Complete');
    console.log('='.repeat(60));
    console.log(`Total broken:              ${result.total_broken}`);
    console.log(`Fixed:                     ${result.fixed}`);
    console.log(`Unfixable (with activity): ${result.unfixable_with_activity}`);
    console.log(`Deleted (no activity):     ${result.deleted_without_activity}`);
    console.log(`Duration:                  ${(result.duration_ms / 1000).toFixed(2)}s`);

    // Log to system_logs
    await logSystemEvent('fix_event_slugs_complete', result);

  } catch (error) {
    result.duration_ms = Date.now() - startTime;

    console.error('Fatal error:', error);

    await logSystemEvent('fix_event_slugs_error', {
      error: error instanceof Error ? error.message : String(error),
      ...result
    }, 'error');

    throw error;
  }

  return result;
}

// Run if called directly
fixEventSlugs()
  .then((result) => {
    console.log('\nFix completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFix failed:', error);
    process.exit(1);
  });
