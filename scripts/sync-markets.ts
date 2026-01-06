/**
 * Sync Markets Script
 *
 * Fetches markets from Polymarket Gamma API and upserts them into Supabase.
 * Runs every 10 minutes via GitHub Actions.
 *
 * Usage: npx tsx scripts/sync-markets.ts
 *
 * @module scripts/sync-markets
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import { fetchTopMarkets, fetchMarketById, simplifyMarket, SimplifiedMarket } from '../lib/polymarket';
import { TOP_MARKETS_COUNT, API_DELAYS } from '../lib/constants';

interface SyncResult {
  total_fetched: number;
  top_markets: number;
  position_markets: number;
  inserted: number;
  updated: number;
  errors: number;
  duration_ms: number;
}

interface PositionMarketInfo {
  polymarket_id: string;
  event_slug: string | null;
}

/**
 * Get polymarket_ids and existing event_slugs for markets with open positions
 * We preserve event_slug from DB since /markets endpoint doesn't have it
 */
async function getPositionMarkets(): Promise<PositionMarketInfo[]> {
  const supabase = getSupabase();

  const { data: positions, error } = await supabase
    .from('positions')
    .select('market_id, markets!inner(polymarket_id, event_slug)')
    .eq('status', 'open');

  if (error) {
    console.error('Error fetching position market IDs:', error.message);
    return [];
  }

  if (!positions || positions.length === 0) {
    return [];
  }

  // Extract unique markets with their event_slugs
  const marketMap = new Map<string, PositionMarketInfo>();
  for (const pos of positions) {
    const market = pos.markets as unknown as { polymarket_id: string; event_slug: string | null } | null;
    if (market?.polymarket_id && !marketMap.has(market.polymarket_id)) {
      marketMap.set(market.polymarket_id, {
        polymarket_id: market.polymarket_id,
        event_slug: market.event_slug
      });
    }
  }

  return Array.from(marketMap.values());
}

/**
 * Fetch markets by their polymarket IDs, preserving event_slugs from our DB
 * Note: /markets endpoint doesn't have event_slug, so we use the one from our DB
 */
async function fetchMarketsByIds(positionMarkets: PositionMarketInfo[]): Promise<SimplifiedMarket[]> {
  const markets: SimplifiedMarket[] = [];

  for (const { polymarket_id, event_slug } of positionMarkets) {
    try {
      const market = await fetchMarketById(polymarket_id);
      if (market) {
        const simplified = simplifyMarket(market);
        // Preserve event_slug from our DB since /markets endpoint doesn't have it
        if (!simplified.event_slug && event_slug) {
          simplified.event_slug = event_slug;
        }
        markets.push(simplified);
      }
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, API_DELAYS.POLYMARKET_BETWEEN_REQUESTS));
    } catch (error) {
      console.error(`Error fetching market ${polymarket_id}:`, error);
    }
  }

  return markets;
}

/**
 * Upsert a single market into the database
 */
async function upsertMarket(market: SimplifiedMarket): Promise<'inserted' | 'updated' | 'error'> {
  const supabase = getSupabase();

  // Check if market exists
  const { data: existing } = await supabase
    .from('markets')
    .select('id')
    .eq('polymarket_id', market.polymarket_id)
    .single();

  const now = new Date().toISOString();

  if (existing) {
    // Update existing market
    const updateData: Record<string, unknown> = {
      question: market.question,
      description: market.description,
      category: market.category,
      current_price: market.current_price,
      current_prices: market.current_prices,
      volume: market.volume,
      liquidity: market.liquidity,
      status: market.status,
      close_date: market.close_date,
      last_updated_at: now,
      last_synced_at: now  // Track when market was last synced
    };

    // Only update event_slug if we have one (don't overwrite with null)
    if (market.event_slug) {
      updateData.event_slug = market.event_slug;
    }

    const { error } = await supabase
      .from('markets')
      .update(updateData)
      .eq('polymarket_id', market.polymarket_id);

    if (error) {
      console.error(`Error updating market ${market.polymarket_id}:`, error.message);
      return 'error';
    }

    // Save price history (ignore errors - non-critical)
    if (market.current_price !== null && market.current_price !== undefined) {
      await supabase.from('market_price_history').upsert({
        market_id: existing.id,
        price: market.current_price,
        volume: market.volume,
        recorded_at: new Date().toISOString(),
        source: 'sync'
      }, {
        onConflict: 'market_id,recorded_at',
        ignoreDuplicates: true
      });
    }

    return 'updated';
  } else {
    // Insert new market
    const { data: inserted, error } = await supabase
      .from('markets')
      .insert({
        polymarket_id: market.polymarket_id,
        slug: market.slug,
        event_slug: market.event_slug,
        question: market.question,
        description: market.description,
        category: market.category,
        market_type: market.market_type,
        outcomes: market.outcomes,
        close_date: market.close_date,
        status: market.status,
        current_price: market.current_price,
        current_prices: market.current_prices,
        volume: market.volume,
        liquidity: market.liquidity
      })
      .select('id')
      .single();

    if (error) {
      console.error(`Error inserting market ${market.polymarket_id}:`, error.message);
      return 'error';
    }

    // Save initial price history
    if (inserted && market.current_price !== null && market.current_price !== undefined) {
      await supabase.from('market_price_history').insert({
        market_id: inserted.id,
        price: market.current_price,
        volume: market.volume,
        recorded_at: new Date().toISOString(),
        source: 'sync'
      });
    }

    return 'inserted';
  }
}

/**
 * Main sync function
 */
async function syncMarkets(): Promise<SyncResult> {
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('SYNC MARKETS - Starting');
  console.log('='.repeat(60));

  const result: SyncResult = {
    total_fetched: 0,
    top_markets: 0,
    position_markets: 0,
    inserted: 0,
    updated: 0,
    errors: 0,
    duration_ms: 0
  };

  try {
    // Step 1: Fetch top markets from Polymarket
    console.log(`\nStep 1: Fetching top ${TOP_MARKETS_COUNT} markets from Polymarket...`);
    const topMarkets = await fetchTopMarkets(TOP_MARKETS_COUNT);
    result.top_markets = topMarkets.length;
    console.log(`Fetched ${topMarkets.length} top markets`);

    // Step 2: Get markets from open positions (with their existing event_slugs)
    console.log(`\nStep 2: Fetching markets from open positions...`);
    const positionMarketInfos = await getPositionMarkets();
    console.log(`Found ${positionMarketInfos.length} markets with open positions`);

    // Filter out position markets that are already in top markets
    const topMarketIds = new Set(topMarkets.map(m => m.polymarket_id));
    const missingPositions = positionMarketInfos.filter(p => !topMarketIds.has(p.polymarket_id));
    console.log(`${missingPositions.length} position markets not in top ${TOP_MARKETS_COUNT}`);

    // Fetch missing position markets (preserving event_slug from our DB)
    let positionMarkets: SimplifiedMarket[] = [];
    if (missingPositions.length > 0) {
      console.log(`Fetching ${missingPositions.length} missing position markets...`);
      positionMarkets = await fetchMarketsByIds(missingPositions);
      result.position_markets = positionMarkets.length;
    }

    // Merge all markets
    const markets = [...topMarkets, ...positionMarkets];
    result.total_fetched = markets.length;
    console.log(`\nTotal markets to sync: ${markets.length}`);

    // Upsert each market
    for (let i = 0; i < markets.length; i++) {
      const market = markets[i];

      try {
        const status = await upsertMarket(market);

        if (status === 'inserted') {
          result.inserted++;
          console.log(`[${i + 1}/${markets.length}] INSERTED: ${market.question.slice(0, 50)}...`);
        } else if (status === 'updated') {
          result.updated++;
          // Only log every 50 updates to reduce noise
          if (result.updated % 50 === 0) {
            console.log(`[${i + 1}/${markets.length}] Updated ${result.updated} markets so far...`);
          }
        } else {
          result.errors++;
        }
      } catch (error) {
        result.errors++;
        console.error(`Error processing market ${market.polymarket_id}:`, error);
      }
    }

    result.duration_ms = Date.now() - startTime;

    // Log summary
    console.log('\n' + '='.repeat(60));
    console.log('SYNC MARKETS - Complete');
    console.log('='.repeat(60));
    console.log(`Top markets:      ${result.top_markets}`);
    console.log(`Position markets: ${result.position_markets}`);
    console.log(`Total fetched:    ${result.total_fetched}`);
    console.log(`Inserted:         ${result.inserted}`);
    console.log(`Updated:          ${result.updated}`);
    console.log(`Errors:           ${result.errors}`);
    console.log(`Duration:         ${(result.duration_ms / 1000).toFixed(2)}s`);

    // Log to system_logs
    await logSystemEvent('sync_markets_complete', {
      ...result
    });

  } catch (error) {
    result.duration_ms = Date.now() - startTime;

    console.error('Fatal error in sync-markets:', error);

    await logSystemEvent('sync_markets_error', {
      error: error instanceof Error ? error.message : String(error),
      ...result
    }, 'error');

    throw error;
  }

  return result;
}

// Run if called directly
syncMarkets()
  .then((result) => {
    console.log('\nSync completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nSync failed:', error);
    process.exit(1);
  });
