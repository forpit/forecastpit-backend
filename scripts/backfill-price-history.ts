/**
 * Backfill Price History Script
 *
 * Fetches historical prices from Polymarket API and stores them.
 * Can be run manually anytime to update price history.
 *
 * Usage:
 *   npx tsx scripts/backfill-price-history.ts              # All markets with positions
 *   npx tsx scripts/backfill-price-history.ts --all        # All active markets
 *   npx tsx scripts/backfill-price-history.ts --days 7     # Last 7 days only
 *
 * @module scripts/backfill-price-history
 */

import 'dotenv/config';
import { getSupabase } from '../lib/supabase';

// ============================================================================
// TYPES
// ============================================================================

interface PricePoint {
  t: number;  // timestamp
  p: string;  // price
}

interface Market {
  id: string;
  polymarket_id: string;
  question: string;
}

interface PolymarketMarketData {
  clobTokenIds?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function parseArgs(): { allMarkets: boolean; days: number } {
  const args = process.argv.slice(2);
  let allMarkets = false;
  let days = 30; // default last 30 days

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--all') {
      allMarkets = true;
    } else if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1], 10) || 30;
      i++;
    }
  }

  return { allMarkets, days };
}

/**
 * Fetch CLOB token ID from Polymarket Gamma API
 */
async function fetchClobTokenId(polymarketId: string): Promise<string | null> {
  try {
    const url = `https://gamma-api.polymarket.com/markets/${polymarketId}`;
    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as PolymarketMarketData;
    if (data.clobTokenIds) {
      const tokenIds = JSON.parse(data.clobTokenIds) as string[];
      return tokenIds[0] || null; // First token is YES outcome
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchPriceHistory(
  tokenId: string,
  interval: string = '1d'
): Promise<PricePoint[]> {
  try {
    const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=${interval}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.log(`    Failed to fetch prices: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.history || [];
  } catch (error) {
    console.error(`    Error fetching price history:`, error);
    return [];
  }
}

async function getMarketsToBackfill(allMarkets: boolean): Promise<Market[]> {
  const supabase = getSupabase();

  if (allMarkets) {
    const { data } = await supabase
      .from('markets')
      .select('id, polymarket_id, question')
      .eq('status', 'active')
      .order('volume', { ascending: false })
      .limit(100);
    return data || [];
  }

  // Only markets where we have positions
  const { data } = await supabase
    .from('positions')
    .select('market:markets(id, polymarket_id, question)')
    .eq('status', 'open');

  const markets = new Map<string, Market>();
  for (const pos of data || []) {
    const m = pos.market as unknown as Market;
    if (m && !markets.has(m.id)) {
      markets.set(m.id, m);
    }
  }

  return Array.from(markets.values());
}

// ============================================================================
// MAIN
// ============================================================================

async function backfillPriceHistory() {
  const { allMarkets, days } = parseArgs();
  const supabase = getSupabase();

  console.log('='.repeat(60));
  console.log('BACKFILL PRICE HISTORY');
  console.log('='.repeat(60));
  console.log(`Mode: ${allMarkets ? 'All active markets' : 'Markets with positions'}`);
  console.log(`Period: Last ${days} days`);

  const markets = await getMarketsToBackfill(allMarkets);
  console.log(`\nFound ${markets.length} markets to backfill\n`);

  let totalPoints = 0;
  let marketsProcessed = 0;
  const errors: string[] = [];

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  for (const market of markets) {
    console.log(`[${marketsProcessed + 1}/${markets.length}] ${market.question.slice(0, 50)}...`);

    // Fetch CLOB token ID from Polymarket API
    const tokenId = await fetchClobTokenId(market.polymarket_id);
    if (!tokenId) {
      console.log(`    Could not get token ID`);
      marketsProcessed++;
      continue;
    }

    // Fetch history
    const history = await fetchPriceHistory(tokenId, days <= 7 ? '1h' : '1d');

    if (history.length === 0) {
      console.log(`    No history found`);
      marketsProcessed++;
      continue;
    }

    // Filter by date and prepare for insert
    const pricePoints = history
      .filter(p => new Date(p.t * 1000) >= cutoffDate)
      .map(p => ({
        market_id: market.id,
        price: parseFloat(p.p),
        recorded_at: new Date(p.t * 1000).toISOString(),
        source: 'backfill'
      }));

    if (pricePoints.length === 0) {
      console.log(`    No points in date range`);
      marketsProcessed++;
      continue;
    }

    // Upsert to avoid duplicates
    const { error } = await supabase
      .from('market_price_history')
      .upsert(pricePoints, {
        onConflict: 'market_id,recorded_at',
        ignoreDuplicates: true
      });

    if (error) {
      errors.push(`${market.question.slice(0, 30)}: ${error.message}`);
      console.log(`    Error: ${error.message}`);
    } else {
      console.log(`    Saved ${pricePoints.length} price points`);
      totalPoints += pricePoints.length;
    }

    marketsProcessed++;

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  console.log('\n' + '='.repeat(60));
  console.log('BACKFILL COMPLETE');
  console.log('='.repeat(60));
  console.log(`Markets processed: ${marketsProcessed}`);
  console.log(`Total price points saved: ${totalPoints}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    errors.slice(0, 5).forEach(e => console.log(`  - ${e}`));
  }
}

backfillPriceHistory()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFailed:', error);
    process.exit(1);
  });
