/**
 * Dry Run Decision Script
 *
 * Tests the decision flow for a single model WITHOUT modifying the database.
 * Useful for testing prompts, parsing, and LLM responses.
 *
 * Usage:
 *   npx tsx scripts/dry-run-decision.ts                    # Test with first model (mock data)
 *   npx tsx scripts/dry-run-decision.ts --real             # Use REAL data from database!
 *   npx tsx scripts/dry-run-decision.ts --real --model claude  # Real data for specific model
 *   npx tsx scripts/dry-run-decision.ts --real --prompt-only   # Show real prompt, no LLM call
 *   npx tsx scripts/dry-run-decision.ts --model claude     # Test specific model (mock data)
 *   npx tsx scripts/dry-run-decision.ts --prompt-only      # Only show prompt, no LLM call
 *   npx tsx scripts/dry-run-decision.ts --mock             # Use mock response instead of LLM
 *   npx tsx scripts/dry-run-decision.ts --with-position    # Simulate having existing positions
 *   npx tsx scripts/dry-run-decision.ts --day 5            # Simulate decision day 5
 *
 * @module scripts/dry-run-decision
 */

import 'dotenv/config';
import { getSupabase } from '../lib/supabase';
import { chatCompletionWithRetry, calculateCostFromUsage } from '../lib/openrouter';
import { buildSystemPrompt, buildUserPrompt, buildRetryPrompt, selectMarketsForPrompt, estimateTokenCount } from '../lib/prompts';
import { parseDecision, validateDecision } from '../lib/parser';
import { MODELS, MIN_BET, MAX_BET_PERCENT, INITIAL_BALANCE } from '../lib/constants';
import type { Market, Position } from '../lib/types';

// ============================================================================
// MOCK DATA
// ============================================================================

const MOCK_LLM_RESPONSE = `\`\`\`json
{
  "action": "BET",
  "bets": [
    {"market_id": "MARKET_ID_1", "side": "YES", "amount": 500, "reasoning": "Market appears underpriced at current levels given recent developments."},
    {"market_id": "MARKET_ID_2", "side": "NO", "amount": 300, "reasoning": "Seems overpriced due to media hype not supported by fundamentals."}
  ]
}
\`\`\``;

// ============================================================================
// HELPERS
// ============================================================================

function parseArgs(): { modelFilter?: string; promptOnly: boolean; mock: boolean; withPosition: boolean; day: number; useReal: boolean } {
  const args = process.argv.slice(2);
  let modelFilter: string | undefined;
  let promptOnly = false;
  let mock = false;
  let withPosition = false;
  let day = 1;
  let useReal = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      modelFilter = args[i + 1].toLowerCase();
      i++;
    } else if (args[i] === '--prompt-only') {
      promptOnly = true;
    } else if (args[i] === '--mock') {
      mock = true;
    } else if (args[i] === '--with-position') {
      withPosition = true;
    } else if (args[i] === '--real') {
      useReal = true;
    } else if (args[i] === '--day' && args[i + 1]) {
      day = parseInt(args[i + 1], 10) || 1;
      i++;
    }
  }

  return { modelFilter, promptOnly, mock, withPosition, day, useReal };
}

async function getRealAgentData(modelFilter?: string): Promise<{
  agent: { id: string; season_id: string; total_invested: number };
  model: typeof MODELS[number];
  cashBalance: number;
  positions: (Position & { market: Market })[];
  decisionDay: number;
} | null> {
  const supabase = getSupabase();

  // Get active season
  const { data: season } = await supabase
    .from('seasons')
    .select('id')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!season) {
    console.log('No active season found');
    return null;
  }

  // Find model
  let selectedModel = MODELS[0];
  if (modelFilter) {
    const found = MODELS.find(m =>
      m.displayName.toLowerCase().includes(modelFilter) ||
      m.provider.toLowerCase().includes(modelFilter) ||
      m.id.toLowerCase().includes(modelFilter)
    );
    if (found) selectedModel = found;
  }

  // Get agent for this model in current season
  const { data: agent } = await supabase
    .from('agents')
    .select('id, season_id, total_invested, cash_balance')
    .eq('season_id', season.id)
    .eq('model_id', selectedModel.id)
    .single();

  if (!agent) {
    console.log(`No agent found for ${selectedModel.displayName} in current season`);
    return null;
  }

  // Get positions with market data
  const { data: positions } = await supabase
    .from('positions')
    .select('*, markets(*)')
    .eq('agent_id', agent.id)
    .eq('status', 'open');

  // Get decision day
  const { data: lastDecision } = await supabase
    .from('decisions')
    .select('decision_day')
    .eq('season_id', season.id)
    .order('decision_day', { ascending: false })
    .limit(1)
    .single();

  const decisionDay = (lastDecision?.decision_day ?? 0) + 1;

  return {
    agent: { id: agent.id, season_id: agent.season_id, total_invested: agent.total_invested },
    model: selectedModel,
    cashBalance: parseFloat(agent.cash_balance),
    positions: (positions || []).map((p: any) => ({
      ...p,
      market: p.markets
    })),
    decisionDay
  };
}

async function getMarketsForTest(): Promise<Market[]> {
  const supabase = getSupabase();

  // Calculate date 60 days from now
  const maxCloseDate = new Date();
  maxCloseDate.setDate(maxCloseDate.getDate() + 60);

  const { data, error } = await supabase
    .from('markets')
    .select('*')
    .eq('status', 'active')
    .eq('market_type', 'binary')
    .gt('close_date', new Date().toISOString())
    .lte('close_date', maxCloseDate.toISOString())
    .order('volume', { ascending: false })
    .limit(300);

  if (error) throw new Error(`Failed to get markets: ${error.message}`);
  return (data || []) as Market[];
}

// ============================================================================
// MAIN
// ============================================================================

async function dryRunDecision() {
  const { modelFilter, promptOnly, mock, withPosition, day, useReal } = parseArgs();

  console.log('='.repeat(70));
  console.log('DRY RUN DECISION');
  console.log('='.repeat(70));
  console.log(`Mode: ${promptOnly ? 'PROMPT ONLY' : mock ? 'MOCK RESPONSE' : 'LIVE LLM CALL'}`);
  console.log(`Data: ${useReal ? 'REAL DATABASE' : 'MOCK'}`);
  console.log(`Day: ${day}${withPosition ? ' (with simulated positions)' : ''}`);

  // If using real data, fetch from database
  if (useReal) {
    const realData = await getRealAgentData(modelFilter);
    if (!realData) {
      console.log('\nFailed to get real agent data');
      process.exit(1);
    }

    console.log(`\nModel: ${realData.model.displayName} (${realData.model.provider})`);
    console.log(`OpenRouter ID: ${realData.model.openrouterId}`);
    console.log(`Agent ID: ${realData.agent.id}`);
    console.log(`\n📊 REAL PORTFOLIO:`);
    console.log(`  Cash Balance: $${realData.cashBalance.toFixed(2)}`);
    console.log(`  Total Invested: $${realData.agent.total_invested.toFixed(2)}`);
    console.log(`  Open Positions: ${realData.positions.length}`);
    console.log(`  Decision Day: ${realData.decisionDay}`);

    if (realData.positions.length > 0) {
      console.log(`\n📈 CURRENT POSITIONS:`);
      for (const pos of realData.positions) {
        const currentPrice = pos.side === 'YES' ? pos.market.current_price : (1 - pos.market.current_price);
        const currentValue = pos.shares * currentPrice;
        const pnl = currentValue - pos.total_cost;
        const pnlPercent = (pnl / pos.total_cost) * 100;
        console.log(`  - ${pos.side} on "${pos.market.question.slice(0, 50)}..."`);
        console.log(`    Shares: ${parseFloat(pos.shares).toFixed(1)} @ ${(parseFloat(pos.avg_entry_price) * 100).toFixed(1)}%`);
        console.log(`    Cost: $${parseFloat(pos.total_cost).toFixed(2)} | Value: $${currentValue.toFixed(2)} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
      }
    }

    // Continue with real data...
    const markets = await getMarketsForTest();
    console.log(`\nFetching markets...`);
    console.log(`Found ${markets.length} active markets`);

    // Build prompts with real portfolio
    console.log('\n' + '='.repeat(70));
    console.log('SYSTEM PROMPT');
    console.log('='.repeat(70));
    const systemPrompt = buildSystemPrompt();
    console.log(systemPrompt);

    console.log('\n' + '='.repeat(70));
    console.log('USER PROMPT');
    console.log('='.repeat(70));
    const marketsForPrompt = selectMarketsForPrompt(markets);
    const userPrompt = buildUserPrompt(
      {
        cashBalance: realData.cashBalance,
        totalInvested: realData.agent.total_invested,
        positions: realData.positions
      },
      marketsForPrompt,
      realData.decisionDay
    );
    console.log(userPrompt);

    if (promptOnly) {
      console.log('\n--prompt-only flag set, skipping LLM call');
      return;
    }

    // Call LLM with real data
    if (!mock && process.env.OPENROUTER_API_KEY) {
      console.log('\n' + '='.repeat(70));
      console.log('CALLING LLM...');
      console.log('='.repeat(70));

      const validMarketIds = new Set(markets.map(m => m.id));
      const validPositionIds = new Set(realData.positions.map(p => p.id));
      const marketQuestions = new Map(markets.map(m => [m.id, m.question]));

      const response = await chatCompletionWithRetry(
        realData.model.openrouterId,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        1
      );

      console.log('\nRAW RESPONSE:');
      console.log(response.content);
      console.log(`\nResponse time: ${response.response_time_ms}ms`);
      console.log(`Estimated cost: $${calculateCostFromUsage(response.usage, realData.model.openrouterId).toFixed(4)}`);
      console.log(`Tokens: ${response.usage.prompt_tokens} in / ${response.usage.completion_tokens} out`);

      const parsed = parseDecision(response.content);
      const validation = validateDecision(
        parsed,
        realData.cashBalance,
        MAX_BET_PERCENT,
        MIN_BET,
        validMarketIds,
        validPositionIds,
        marketQuestions
      );

      console.log('\n' + '='.repeat(70));
      console.log('PARSED DECISION');
      console.log('='.repeat(70));
      console.log(JSON.stringify(parsed, null, 2));

      console.log('\n' + '='.repeat(70));
      console.log('VALIDATION');
      console.log('='.repeat(70));
      console.log(`Valid: ${validation.valid}`);
      if (validation.errors.length > 0) {
        console.log('Errors:');
        validation.errors.forEach(e => console.log(`  - ${e}`));
      }

      // Show what would happen
      if (parsed.action === 'BET' && parsed.bets) {
        console.log('\n' + '='.repeat(70));
        console.log('TRADES THAT WOULD BE EXECUTED');
        console.log('='.repeat(70));

        for (const bet of parsed.bets) {
          const market = markets.find(m => m.id === bet.market_id);
          if (market) {
            const yesPrice = market.current_price || 0.5;
            const effectivePrice = bet.side === 'YES' ? yesPrice : (1 - yesPrice);
            const shares = bet.amount / effectivePrice;
            console.log(`\n  Market: ${market.question.slice(0, 60)}...`);
            console.log(`  Side: ${bet.side}`);
            console.log(`  Amount: $${bet.amount}`);
            console.log(`  Buying at: ${(effectivePrice * 100).toFixed(1)}%`);
            console.log(`  Shares: ${shares.toFixed(2)}`);
            if (bet.reasoning) console.log(`  Reasoning: ${bet.reasoning}`);
          }
        }
      } else if (parsed.action === 'SELL' && parsed.sells) {
        console.log('\n' + '='.repeat(70));
        console.log('SELLS THAT WOULD BE EXECUTED');
        console.log('='.repeat(70));

        for (const sell of parsed.sells) {
          const position = realData.positions.find(p => p.id === sell.position_id);
          if (position) {
            console.log(`\n  Position: ${position.side} on "${position.market.question.slice(0, 50)}..."`);
            console.log(`  Selling: ${sell.percentage}%`);
          }
        }
      } else if (parsed.action === 'HOLD') {
        console.log('\n' + '='.repeat(70));
        console.log('DECISION: HOLD');
        console.log('='.repeat(70));
        console.log(`Reasoning: ${parsed.reasoning}`);
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('DRY RUN COMPLETE - NO DATABASE CHANGES MADE');
    console.log('='.repeat(70));
    return;
  }

  // Original mock flow below...
  // Select model
  let selectedModel: typeof MODELS[number] = MODELS[0];
  if (modelFilter) {
    const found = MODELS.find(m =>
      m.displayName.toLowerCase().includes(modelFilter) ||
      m.provider.toLowerCase().includes(modelFilter) ||
      m.id.toLowerCase().includes(modelFilter)
    );
    if (found) {
      selectedModel = found;
    } else {
      console.log(`\nModel "${modelFilter}" not found. Available models:`);
      MODELS.forEach(m => console.log(`  - ${m.displayName} (${m.provider})`));
      process.exit(1);
    }
  }

  console.log(`\nModel: ${selectedModel.displayName} (${selectedModel.provider})`);
  console.log(`OpenRouter ID: ${selectedModel.openrouterId}`);

  // Get markets
  console.log('\nFetching markets...');
  const markets = await getMarketsForTest();
  console.log(`Found ${markets.length} active markets`);

  // Build mock portfolio
  let mockPortfolio: {
    cashBalance: number;
    totalInvested: number;
    positions: (Position & { market: Market })[];
  };

  if (withPosition && markets.length >= 2) {
    // Simulate having bought 2 positions with price changes
    const market1 = markets[0];
    const market2 = markets[1];

    // Position 1: Bought YES at 50%, now market is at current price (profit or loss)
    const entryPrice1 = 0.50;
    const shares1 = 1000 / entryPrice1; // $1000 bet = 2000 shares

    // Position 2: Bought NO at 40% (meaning YES was 60%), now market moved
    const entryPrice2 = 0.40;
    const shares2 = 500 / entryPrice2; // $500 bet = 1250 shares

    const position1: Position & { market: Market } = {
      id: 'pos-simulation-1',
      agent_id: 'agent-sim',
      market_id: market1.id,
      side: 'YES',
      shares: shares1,
      avg_entry_price: entryPrice1,
      total_cost: 1000,
      status: 'open',
      opened_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
      market: market1
    };

    const position2: Position & { market: Market } = {
      id: 'pos-simulation-2',
      agent_id: 'agent-sim',
      market_id: market2.id,
      side: 'NO',
      shares: shares2,
      avg_entry_price: entryPrice2,
      total_cost: 500,
      status: 'open',
      opened_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      market: market2
    };

    mockPortfolio = {
      cashBalance: INITIAL_BALANCE - 1500, // Spent $1500 on positions
      totalInvested: 1500,
      positions: [position1, position2]
    };

    console.log('\n📊 SIMULATED POSITIONS:');
    console.log(`  Position 1: ${shares1.toFixed(0)} YES shares @ ${(entryPrice1*100).toFixed(0)}% on "${market1.question.slice(0,50)}..."`);
    console.log(`  Position 2: ${shares2.toFixed(0)} NO shares @ ${(entryPrice2*100).toFixed(0)}% on "${market2.question.slice(0,50)}..."`);
  } else {
    mockPortfolio = {
      cashBalance: INITIAL_BALANCE,
      totalInvested: 0,
      positions: []
    };
  }

  // Build prompts
  console.log('\n' + '='.repeat(70));
  console.log('SYSTEM PROMPT');
  console.log('='.repeat(70));
  const systemPrompt = buildSystemPrompt();
  console.log(systemPrompt);

  console.log('\n' + '='.repeat(70));
  console.log('USER PROMPT');
  console.log('='.repeat(70));
  const marketsForPrompt = selectMarketsForPrompt(markets);
  const userPrompt = buildUserPrompt(mockPortfolio, marketsForPrompt, day);
  console.log(userPrompt);

  // Token estimates
  const systemTokens = estimateTokenCount(systemPrompt);
  const userTokens = estimateTokenCount(userPrompt);
  console.log('\n' + '='.repeat(70));
  console.log('TOKEN ESTIMATES');
  console.log('='.repeat(70));
  console.log(`System prompt: ~${systemTokens} tokens`);
  console.log(`User prompt: ~${userTokens} tokens`);
  console.log(`Total input: ~${systemTokens + userTokens} tokens`);

  if (promptOnly) {
    console.log('\n--prompt-only flag set, skipping LLM call');
    return;
  }

  // Get LLM response (or mock)
  let llmContent: string;
  let responseTimeMs = 0;
  let costUsd = 0;

  const validMarketIds = new Set(markets.map(m => m.id));
  const validPositionIds = new Set(mockPortfolio.positions.map(p => p.id));
  const marketQuestions = new Map(markets.map(m => [m.id, m.question]));

  if (mock) {
    console.log('\n' + '='.repeat(70));
    console.log('MOCK LLM RESPONSE');
    console.log('='.repeat(70));

    // Replace placeholder market IDs with real ones
    llmContent = MOCK_LLM_RESPONSE
      .replace('MARKET_ID_1', markets[0]?.id || 'invalid-id')
      .replace('MARKET_ID_2', markets[1]?.id || 'invalid-id');

    console.log(llmContent);

    // Parse and validate mock response
    const parsed = parseDecision(llmContent);
    const validation = validateDecision(
      parsed,
      mockPortfolio.cashBalance,
      MAX_BET_PERCENT,
      MIN_BET,
      validMarketIds,
      validPositionIds,
      marketQuestions
    );

    console.log('\n' + '='.repeat(70));
    console.log('PARSED DECISION');
    console.log('='.repeat(70));
    console.log(JSON.stringify(parsed, null, 2));

    console.log('\n' + '='.repeat(70));
    console.log('VALIDATION');
    console.log('='.repeat(70));
    console.log(`Valid: ${validation.valid}`);
    if (validation.errors.length > 0) {
      console.log('Errors:');
      validation.errors.forEach(e => console.log(`  - ${e}`));
    }

    // Show what would happen
    if (parsed.action === 'BET' && parsed.bets) {
      console.log('\n' + '='.repeat(70));
      console.log('TRADES THAT WOULD BE EXECUTED');
      console.log('='.repeat(70));

      for (const bet of parsed.bets) {
        const market = markets.find(m => m.id === bet.market_id);
        if (market) {
          const yesPrice = market.current_price || 0.5;
          const effectivePrice = bet.side === 'YES' ? yesPrice : (1 - yesPrice);
          const shares = bet.amount / effectivePrice;
          console.log(`\n  Market: ${market.question.slice(0, 60)}...`);
          console.log(`  Side: ${bet.side}`);
          console.log(`  Amount: $${bet.amount}`);
          console.log(`  Market: YES ${(yesPrice * 100).toFixed(1)}% / NO ${((1 - yesPrice) * 100).toFixed(1)}%`);
          console.log(`  Buying at: ${(effectivePrice * 100).toFixed(1)}%`);
          console.log(`  Shares: ${shares.toFixed(2)}`);
          if (bet.reasoning) {
            console.log(`  Reasoning: ${bet.reasoning}`);
          }
        } else {
          console.log(`\n  Invalid market ID: ${bet.market_id}`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('DRY RUN COMPLETE - NO DATABASE CHANGES MADE');
    console.log('='.repeat(70));
  } else {
    console.log('\n' + '='.repeat(70));
    console.log('CALLING LLM...');
    console.log('='.repeat(70));

    if (!process.env.OPENROUTER_API_KEY) {
      console.log('\nERROR: OPENROUTER_API_KEY not set in .env');
      console.log('Add it to .env or use --mock flag for testing');
      process.exit(1);
    }

    const maxValidationRetries = 2;
    let retryCount = 0;
    let currentUserPrompt = userPrompt;
    let parsed = parseDecision('');
    let validation = { valid: false, errors: ['No response'] };

    try {
      while (retryCount <= maxValidationRetries) {
        const response = await chatCompletionWithRetry(
          selectedModel.openrouterId,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: currentUserPrompt }
          ],
          1
        );

        llmContent = response.content;
        responseTimeMs += response.response_time_ms;
        costUsd += calculateCostFromUsage(response.usage, selectedModel.openrouterId);

        console.log('\nRAW RESPONSE:');
        console.log(llmContent);
        console.log(`\nResponse time: ${response.response_time_ms}ms`);
        console.log(`Estimated cost: $${calculateCostFromUsage(response.usage, selectedModel.openrouterId).toFixed(4)}`);
        console.log(`Tokens: ${response.usage.prompt_tokens} in / ${response.usage.completion_tokens} out`);

        // Parse and validate
        parsed = parseDecision(llmContent);
        validation = validateDecision(
          parsed,
          mockPortfolio.cashBalance,
          MAX_BET_PERCENT,
          MIN_BET,
          validMarketIds,
          validPositionIds,
          marketQuestions
        );

        if (validation.valid || parsed.action === 'HOLD') {
          break;
        }

        retryCount++;
        if (retryCount <= maxValidationRetries) {
          console.log(`\n⚠️  Validation failed, retry ${retryCount}/${maxValidationRetries}...`);
          console.log('Errors:', validation.errors);
          currentUserPrompt = buildRetryPrompt(userPrompt, llmContent, validation.errors);
        }
      }
    } catch (error) {
      console.error('\nLLM call failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    }

    // Show final parsed result
    console.log('\n' + '='.repeat(70));
    console.log('PARSED DECISION');
    console.log('='.repeat(70));
    console.log(JSON.stringify(parsed, null, 2));

    // Show final validation
    console.log('\n' + '='.repeat(70));
    console.log('VALIDATION');
    console.log('='.repeat(70));
    console.log(`Valid: ${validation.valid}`);
    if (validation.errors.length > 0) {
      console.log('Errors:');
      validation.errors.forEach(e => console.log(`  - ${e}`));
    }
    if (retryCount > 0) {
      console.log(`Retries used: ${retryCount}`);
    }

    // Show what would happen
    if (parsed.action === 'BET' && parsed.bets) {
      console.log('\n' + '='.repeat(70));
      console.log('TRADES THAT WOULD BE EXECUTED');
      console.log('='.repeat(70));

      for (const bet of parsed.bets) {
        const market = markets.find(m => m.id === bet.market_id);
        if (market) {
          const yesPrice = market.current_price || 0.5;
          const effectivePrice = bet.side === 'YES' ? yesPrice : (1 - yesPrice);
          const shares = bet.amount / effectivePrice;
          console.log(`\n  Market: ${market.question.slice(0, 60)}...`);
          console.log(`  Side: ${bet.side}`);
          console.log(`  Amount: $${bet.amount}`);
          console.log(`  Market: YES ${(yesPrice * 100).toFixed(1)}% / NO ${((1 - yesPrice) * 100).toFixed(1)}%`);
          console.log(`  Buying at: ${(effectivePrice * 100).toFixed(1)}%`);
          console.log(`  Shares: ${shares.toFixed(2)}`);
          if (bet.reasoning) {
            console.log(`  Reasoning: ${bet.reasoning}`);
          }
        } else {
          console.log(`\n  Invalid market ID: ${bet.market_id}`);
        }
      }
    }

    console.log('\n' + '='.repeat(70));
    console.log('DRY RUN COMPLETE - NO DATABASE CHANGES MADE');
    console.log('='.repeat(70));
  }
}

dryRunDecision().catch(console.error);
