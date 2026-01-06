/**
 * Polymarket API Client
 *
 * Client for interacting with Polymarket's Gamma API.
 * The Gamma API is public and requires no authentication.
 *
 * IMPORTANT: We use the /events endpoint as the PRIMARY source because:
 * - Markets from /events have event_slug attached (needed for URLs)
 * - Markets from /markets endpoint do NOT have event data
 *
 * @see https://docs.polymarket.com/
 * @module polymarket
 */

import { POLYMARKET_API_URL, TOP_MARKETS_COUNT, API_DELAYS } from './constants';
import type { PolymarketMarket, PolymarketEvent, Market } from './types';

// ============================================================================
// TYPES
// ============================================================================

export interface SimplifiedMarket {
  polymarket_id: string;
  slug: string | null;
  event_slug: string | null;
  question: string;
  description: string | null;
  category: string | null;
  market_type: 'binary' | 'multi_outcome';
  outcomes: Record<string, unknown> | null;
  close_date: string;
  status: 'active' | 'closed' | 'resolved';
  current_price: number | null;
  current_prices: Record<string, number> | null;
  volume: number | null;
  liquidity: number | null;
}

export interface MarketResolution {
  resolved: boolean;
  winner?: string;
  error?: string;
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Fetch a single market by ID
 * Used for: position markets that fell out of top, resolution checks
 */
export async function fetchMarketById(marketId: string): Promise<PolymarketMarket | null> {
  const url = `${POLYMARKET_API_URL}/markets/${marketId}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
  }

  return await response.json() as PolymarketMarket;
}

/**
 * Fetch events from Polymarket Gamma API
 */
export async function fetchEvents(
  limit: number = 100,
  offset: number = 0
): Promise<PolymarketEvent[]> {
  const url = new URL(`${POLYMARKET_API_URL}/events`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'volume');
  url.searchParams.set('ascending', 'false');
  url.searchParams.set('closed', 'false');

  console.log(`Fetching events from Polymarket: ${url}`);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch markets from events
 * Attaches parent event slug to each market for proper URL linking
 */
export async function fetchMarketsFromEvents(limit: number = 100): Promise<PolymarketMarket[]> {
  const events = await fetchEvents(limit);
  const allMarkets: PolymarketMarket[] = [];

  for (const event of events) {
    if (event.markets && Array.isArray(event.markets)) {
      for (const market of event.markets) {
        const volumeNum = parseFloat(String(market.volumeNum || market.volume || 0));
        if (market.active === true && !market.closed && volumeNum > 0) {
          // Attach parent event slug to market for proper URL generation
          const marketWithEvent = {
            ...market,
            _parentEventSlug: event.slug || null
          };
          allMarkets.push(marketWithEvent as PolymarketMarket);
        }
      }
    }
  }

  console.log(`Extracted ${allMarkets.length} active markets from ${events.length} events`);
  return allMarkets;
}

// ============================================================================
// TRANSFORM FUNCTIONS
// ============================================================================

/**
 * Transform Polymarket market to our simplified format
 */
export function simplifyMarket(market: PolymarketMarket): SimplifiedMarket {
  // Parse outcomes and prices
  let outcomesList: string[] = [];
  let pricesList: string[] = [];

  try {
    if (typeof market.outcomes === 'string') {
      outcomesList = JSON.parse(market.outcomes);
    } else if (Array.isArray(market.outcomes)) {
      outcomesList = market.outcomes;
    }

    if (typeof market.outcomePrices === 'string') {
      pricesList = JSON.parse(market.outcomePrices);
    } else if (Array.isArray(market.outcomePrices)) {
      pricesList = market.outcomePrices.map(String);
    }
  } catch {
    const tokens = market.tokens || [];
    outcomesList = tokens.map(t => t.outcome).filter(Boolean);
    pricesList = tokens.map(t => String(t.price)).filter(Boolean);
  }

  const isBinary = outcomesList.length === 2 &&
    outcomesList.some(o => o?.toLowerCase() === 'yes') &&
    outcomesList.some(o => o?.toLowerCase() === 'no');

  let currentPrice: number | null = null;
  let currentPrices: Record<string, number> | null = null;

  if (outcomesList.length > 0 && pricesList.length > 0) {
    if (isBinary) {
      const yesIndex = outcomesList.findIndex(o => o?.toLowerCase() === 'yes');
      if (yesIndex !== -1 && pricesList[yesIndex]) {
        currentPrice = parseFloat(pricesList[yesIndex]);
        if (isNaN(currentPrice) || currentPrice < 0 || currentPrice > 1) {
          currentPrice = null;
        }
      }
    } else {
      const prices: Record<string, number> = {};
      for (let i = 0; i < outcomesList.length; i++) {
        if (outcomesList[i] && pricesList[i]) {
          const price = parseFloat(pricesList[i]);
          if (!isNaN(price) && price >= 0 && price <= 1) {
            prices[outcomesList[i]] = price;
          }
        }
      }
      if (Object.keys(prices).length > 0) {
        currentPrices = prices;
      }
    }
  }

  let status: 'active' | 'closed' | 'resolved' = 'active';
  if (market.archived) status = 'resolved';
  else if (market.closed) status = 'closed';

  const outcomes = !isBinary && outcomesList.length > 0
    ? outcomesList.reduce((acc, o, i) => ({ ...acc, [o]: pricesList[i] || 0 }), {})
    : null;

  // Handle date field
  let closeDate = (market as any).end_date_iso || (market as any).endDateIso || market.endDate;
  if (!closeDate) {
    console.warn(`[Market ${market.id}] No close date found. Using far-future date.`);
    closeDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  }

  // Get event slug: prefer _parentEventSlug (from fetchMarketsFromEvents), fallback to events array
  const eventSlug = (market as any)._parentEventSlug || market.events?.[0]?.slug || null;

  return {
    polymarket_id: market.id || market.conditionId || '',
    slug: market.slug || null,
    event_slug: eventSlug,
    question: market.question || 'Unknown question',
    description: market.description || null,
    category: market.category || null,
    market_type: isBinary ? 'binary' : 'multi_outcome',
    outcomes,
    close_date: closeDate,
    status,
    current_price: currentPrice,
    current_prices: currentPrices,
    volume: market.volumeNum ?? (market.volume ? parseFloat(String(market.volume)) : null),
    liquidity: market.liquidity ? parseFloat(String(market.liquidity)) : null,
  };
}

/**
 * Check if a market has resolved
 */
export function checkResolution(market: PolymarketMarket): MarketResolution {
  if (!market.archived && !market.closed) return { resolved: false };

  // Method 1: Check tokens array
  if (market.tokens && Array.isArray(market.tokens) && market.tokens.length > 0) {
    const winnerToken = market.tokens.find(t => t.winner === true);
    if (winnerToken && winnerToken.outcome) {
      return { resolved: true, winner: winnerToken.outcome.toUpperCase() };
    }

    const winnerByPrice = market.tokens.find(t => {
      const price = parseFloat(String(t.price || '0'));
      return price === 1 || price >= 0.99;
    });
    if (winnerByPrice && winnerByPrice.outcome) {
      return { resolved: true, winner: winnerByPrice.outcome.toUpperCase() };
    }
  }

  // Method 2: Check outcomePrices
  if (market.outcomePrices) {
    try {
      const outcomes = typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : market.outcomes || [];
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices || [];

      if (Array.isArray(outcomes) && Array.isArray(prices)) {
        for (let i = 0; i < prices.length; i++) {
          const price = parseFloat(prices[i]);
          if (price === 1 || price >= 0.99) {
            const winner = outcomes[i];
            if (winner) {
              return { resolved: true, winner: winner.toUpperCase() };
            }
          }
        }
      }
    } catch (e) {
      console.error('Error parsing outcomePrices for resolution:', e);
    }
  }

  return { resolved: false };
}

// ============================================================================
// MAIN FETCH FUNCTION
// ============================================================================

// Maximum days until market close (filter out long-term markets)
const MAX_DAYS_UNTIL_CLOSE = 60;

/**
 * Fetch and simplify top markets by volume
 *
 * SINGLE SOURCE: Uses /events endpoint only (has event_slug for URLs)
 * Returns binary (YES/NO) markets closing within 60 days
 */
export async function fetchTopMarkets(limit: number = TOP_MARKETS_COUNT): Promise<SimplifiedMarket[]> {
  // Fetch from events only - they have event_slug attached
  const eventMarkets = await fetchMarketsFromEvents(Math.max(200, limit * 3));

  // Sort by volume (already sorted by API, but ensure consistency)
  eventMarkets.sort((a, b) => {
    const volA = a.volumeNum ?? (a.volume ? parseFloat(String(a.volume)) : 0);
    const volB = b.volumeNum ?? (b.volume ? parseFloat(String(b.volume)) : 0);
    return volB - volA;
  });

  // Simplify and filter to binary markets only
  const simplified = eventMarkets.map(simplifyMarket);
  const binaryOnly = simplified.filter(m => m.market_type === 'binary');

  // Filter to markets closing within MAX_DAYS_UNTIL_CLOSE days
  const now = new Date();
  const maxCloseDate = new Date(now.getTime() + MAX_DAYS_UNTIL_CLOSE * 24 * 60 * 60 * 1000);

  const shortTermOnly = binaryOnly.filter(m => {
    const closeDate = new Date(m.close_date);
    return closeDate > now && closeDate <= maxCloseDate;
  });

  console.log(`Filtered to ${binaryOnly.length} binary markets`);
  console.log(`Filtered to ${shortTermOnly.length} markets closing within ${MAX_DAYS_UNTIL_CLOSE} days`);

  return shortTermOnly.slice(0, limit);
}

/**
 * Check resolution for multiple markets
 */
export async function checkMultipleResolutions(
  polymarketIds: string[]
): Promise<Map<string, MarketResolution>> {
  const results = new Map<string, MarketResolution>();
  const batchSize = 10;

  for (let i = 0; i < polymarketIds.length; i += batchSize) {
    const batch = polymarketIds.slice(i, i + batchSize);

    const promises = batch.map(async (id) => {
      try {
        const market = await fetchMarketById(id);
        if (market) results.set(id, checkResolution(market));
      } catch (error) {
        console.error(`Error checking resolution for ${id}:`, error);
      }
    });

    await Promise.all(promises);

    if (i + batchSize < polymarketIds.length) {
      await new Promise(resolve => setTimeout(resolve, API_DELAYS.POLYMARKET_BETWEEN_REQUESTS));
    }
  }

  return results;
}
