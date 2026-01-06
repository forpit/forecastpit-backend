/**
 * Run Decisions Script
 *
 * Runs daily to have each LLM agent make trading decisions.
 * Processes all active agents in the current season.
 *
 * Usage: npx tsx scripts/run-decisions.ts
 *
 * @module scripts/run-decisions
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import { chatCompletionWithRetry, calculateCostFromUsage } from '../lib/openrouter';
import { buildSystemPrompt, buildUserPrompt, buildRetryPrompt, selectMarketsForPrompt } from '../lib/prompts';
import { parseDecision, validateDecision, filterValidBets } from '../lib/parser';
import { executeBuys, executeSells, getAgentBalance, getAgentPositions } from '../lib/execution';
import { MIN_BET, MAX_BET_PERCENT, LLM_MAX_RETRIES, API_DELAYS } from '../lib/constants';
import type { Agent, Model, Market, Position, ParsedDecision } from '../lib/types';

// ============================================================================
// TYPES
// ============================================================================

interface AgentWithModel extends Agent {
  models: Model;
}

interface DecisionResult {
  agent_id: string;
  model_name: string;
  action: string;
  success: boolean;
  trades_executed: number;
  error?: string;
  cost_usd: number;
  response_time_ms: number;
}

interface RunResult {
  season_id: string;
  decision_day: number;
  agents_processed: number;
  total_decisions: number;
  total_trades: number;
  total_cost_usd: number;
  errors: string[];
  duration_ms: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the active season
 */
async function getActiveSeason(): Promise<{ id: string; season_number: number } | null> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('seasons')
    .select('id, season_number')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Get decision day for season
 */
async function getDecisionDay(seasonId: string): Promise<number> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from('decisions')
    .select('decision_day')
    .eq('season_id', seasonId)
    .order('decision_day', { ascending: false })
    .limit(1)
    .single();

  return (data?.decision_day ?? 0) + 1;
}

/**
 * Get all active agents in season
 */
async function getActiveAgents(seasonId: string): Promise<AgentWithModel[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('agents')
    .select('*, models(*)')
    .eq('season_id', seasonId)
    .eq('status', 'active');

  if (error) throw new Error(`Failed to get agents: ${error.message}`);
  return (data || []) as AgentWithModel[];
}

/**
 * Get active markets (binary, closing within 60 days, synced within last 6 hours)
 *
 * IMPORTANT: Only returns markets that were synced recently to ensure AI sees fresh data.
 * This prevents betting on markets with stale prices or incorrect status.
 */
async function getActiveMarkets(): Promise<Market[]> {
  const supabase = getSupabase();

  // Calculate date 60 days from now
  const maxCloseDate = new Date();
  maxCloseDate.setDate(maxCloseDate.getDate() + 60);

  // Only use markets synced in the last 6 hours to ensure fresh data
  const minSyncTime = new Date();
  minSyncTime.setHours(minSyncTime.getHours() - 6);

  const { data, error } = await supabase
    .from('markets')
    .select('*')
    .eq('status', 'active')
    .eq('market_type', 'binary')
    .gt('close_date', new Date().toISOString())
    .lte('close_date', maxCloseDate.toISOString())
    .gte('last_updated_at', minSyncTime.toISOString()) // CRITICAL: Only recently synced markets
    .order('volume', { ascending: false })
    .limit(300);

  if (error) throw new Error(`Failed to get markets: ${error.message}`);

  if ((data || []).length === 0) {
    console.warn('WARNING: No recently synced markets found! Run sync-markets first.');
  }

  return (data || []) as Market[];
}

/**
 * Process a single agent's decision
 */
async function processAgentDecision(
  agent: AgentWithModel,
  markets: Market[],
  decisionDay: number
): Promise<DecisionResult> {
  const supabase = getSupabase();
  const model = agent.models;

  const result: DecisionResult = {
    agent_id: agent.id,
    model_name: model.display_name,
    action: 'ERROR',
    success: false,
    trades_executed: 0,
    cost_usd: 0,
    response_time_ms: 0
  };

  try {
    // Get agent's current state
    const cashBalance = await getAgentBalance(agent.id);
    const positions = await getAgentPositions(agent.id);

    // Check if agent is bankrupt
    if (cashBalance < MIN_BET && positions.length === 0) {
      console.log(`  Agent ${model.display_name} is bankrupt, skipping...`);

      await supabase
        .from('agents')
        .update({ status: 'bankrupt' })
        .eq('id', agent.id);

      result.action = 'BANKRUPT';
      result.error = 'Agent has insufficient funds';
      return result;
    }

    // Prepare prompts
    const systemPrompt = buildSystemPrompt();
    const marketsForPrompt = selectMarketsForPrompt(markets);
    const userPrompt = buildUserPrompt(
      {
        cashBalance,
        totalInvested: agent.total_invested,
        positions: positions.map(p => ({ ...p, market: p.market }))
      },
      marketsForPrompt,
      decisionDay
    );

    // Call LLM with validation retry loop
    console.log(`  Calling ${model.display_name}...`);

    const validMarketIds = new Set(markets.map(m => m.id));
    const validPositionIds = new Set(positions.map(p => p.id));
    const marketQuestions = new Map(markets.map(m => [m.id, m.question]));

    let currentUserPrompt = userPrompt;
    let parsed: ParsedDecision = { action: 'ERROR', reasoning: '' };
    let validation = { valid: false, errors: ['No response'] };
    let retryCount = 0;
    const maxValidationRetries = 2;

    let totalResponseTime = 0;
    let totalCost = 0;
    let lastRawResponse = '';
    let lastUsage = { prompt_tokens: 0, completion_tokens: 0 };

    while (retryCount <= maxValidationRetries) {
      const llmResponse = await chatCompletionWithRetry(
        model.openrouter_id,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: currentUserPrompt }
        ],
        LLM_MAX_RETRIES
      );

      totalResponseTime += llmResponse.response_time_ms;
      totalCost += calculateCostFromUsage(llmResponse.usage, model.openrouter_id);
      lastRawResponse = llmResponse.content;
      lastUsage = llmResponse.usage;

      // Parse response
      parsed = parseDecision(llmResponse.content);

      // Validate decision
      validation = validateDecision(
        parsed,
        cashBalance,
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
        console.log(`  Validation failed, retry ${retryCount}/${maxValidationRetries}...`);
        currentUserPrompt = buildRetryPrompt(userPrompt, llmResponse.content, validation.errors);
      }
    }

    result.response_time_ms = totalResponseTime;
    result.cost_usd = totalCost;
    result.action = parsed.action;

    // Record decision
    const { data: decision, error: decisionError } = await supabase
      .from('decisions')
      .insert({
        agent_id: agent.id,
        season_id: agent.season_id,
        decision_day: decisionDay,
        decision_timestamp: new Date().toISOString(),
        prompt_system: systemPrompt,
        prompt_user: userPrompt,
        raw_response: lastRawResponse,
        parsed_response: parsed,
        retry_count: retryCount,
        action: parsed.action,
        reasoning: parsed.reasoning,
        tokens_input: lastUsage.prompt_tokens,
        tokens_output: lastUsage.completion_tokens,
        api_cost_usd: result.cost_usd,
        response_time_ms: result.response_time_ms,
        error_message: validation.valid ? null : validation.errors.join('; ')
      })
      .select()
      .single();

    if (decisionError) {
      console.error(`  Failed to record decision: ${decisionError.message}`);
    }

    // Execute trades
    if (parsed.action === 'BET' && parsed.bets && parsed.bets.length > 0) {
      let betsToExecute = parsed.bets;

      // If validation failed, filter to only valid bets (partial execution)
      if (!validation.valid) {
        const filtered = filterValidBets(
          parsed.bets,
          cashBalance,
          MAX_BET_PERCENT,
          MIN_BET,
          validMarketIds,
          marketQuestions
        );

        if (filtered.validBets.length > 0) {
          console.log(`  Filtered: ${filtered.removedCount} invalid bets removed, ${filtered.validBets.length} valid`);
          if (filtered.reasons.length > 0) {
            console.log(`  Reasons: ${filtered.reasons.slice(0, 3).join('; ')}`);
          }
          betsToExecute = filtered.validBets;
        } else {
          // No valid bets at all
          result.error = validation.errors.join('; ');
          console.log(`  All bets invalid: ${result.error}`);
          betsToExecute = [];
        }
      }

      if (betsToExecute.length > 0) {
        console.log(`  Executing ${betsToExecute.length} bets...`);
        const { results } = await executeBuys(agent.id, betsToExecute, cashBalance, decision?.id);
        result.trades_executed = results.filter(r => r.success).length;
        result.success = result.trades_executed > 0;
      }
    } else if (parsed.action === 'SELL' && parsed.sells && parsed.sells.length > 0) {
      if (validation.valid) {
        console.log(`  Executing ${parsed.sells.length} sells...`);
        const { results } = await executeSells(agent.id, parsed.sells, decision?.id);
        result.trades_executed = results.filter(r => r.success).length;
        result.success = result.trades_executed > 0;
      } else {
        result.error = validation.errors.join('; ');
        console.log(`  Validation failed: ${result.error}`);
      }
    } else if (parsed.action === 'HOLD') {
      result.success = true;
    } else if (parsed.action === 'ERROR') {
      result.error = parsed.error || 'Unknown error';
    }

    // Record API cost
    await supabase.from('api_costs').insert({
      model_id: model.id,
      decision_id: decision?.id,
      tokens_input: lastUsage.prompt_tokens,
      tokens_output: lastUsage.completion_tokens,
      cost_usd: result.cost_usd
    });

  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`  Error: ${result.error}`);

    // Record failed decision
    await supabase.from('decisions').insert({
      agent_id: agent.id,
      season_id: agent.season_id,
      decision_day: decisionDay,
      decision_timestamp: new Date().toISOString(),
      prompt_system: '',
      prompt_user: '',
      action: 'ERROR',
      error_message: result.error,
      retry_count: 0
    });
  }

  return result;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

async function runDecisions(): Promise<RunResult> {
  const startTime = Date.now();

  console.log('='.repeat(60));
  console.log('RUN DECISIONS');
  console.log('='.repeat(60));

  const result: RunResult = {
    season_id: '',
    decision_day: 0,
    agents_processed: 0,
    total_decisions: 0,
    total_trades: 0,
    total_cost_usd: 0,
    errors: [],
    duration_ms: 0
  };

  try {
    // Get active season
    const season = await getActiveSeason();
    if (!season) {
      throw new Error('No active season found. Run start-season first.');
    }

    result.season_id = season.id;
    console.log(`\nSeason: #${season.season_number} (${season.id})`);

    // Get decision day
    const decisionDay = await getDecisionDay(season.id);
    result.decision_day = decisionDay;
    console.log(`Decision Day: ${decisionDay}`);

    // Get agents and markets
    const agents = await getActiveAgents(season.id);
    const markets = await getActiveMarkets();

    console.log(`Active Agents: ${agents.length}`);
    console.log(`Active Markets: ${markets.length}`);

    if (agents.length === 0) {
      throw new Error('No active agents in season');
    }

    if (markets.length === 0) {
      throw new Error('No active markets available');
    }

    // Process each agent
    console.log('\nProcessing agents...\n');

    for (const agent of agents) {
      console.log(`[${result.agents_processed + 1}/${agents.length}] ${agent.models.display_name}`);

      const decisionResult = await processAgentDecision(agent, markets, decisionDay);

      result.agents_processed++;
      result.total_decisions++;
      result.total_trades += decisionResult.trades_executed;
      result.total_cost_usd += decisionResult.cost_usd;

      if (decisionResult.error && decisionResult.action === 'ERROR') {
        result.errors.push(`${agent.models.display_name}: ${decisionResult.error}`);
      }

      console.log(`  Action: ${decisionResult.action}`);
      console.log(`  Trades: ${decisionResult.trades_executed}`);
      console.log(`  Cost: $${decisionResult.cost_usd.toFixed(4)}`);
      console.log(`  Time: ${decisionResult.response_time_ms}ms\n`);

      // Rate limiting between agents
      if (result.agents_processed < agents.length) {
        await new Promise(resolve => setTimeout(resolve, API_DELAYS.OPENROUTER_BETWEEN_REQUESTS));
      }
    }

    result.duration_ms = Date.now() - startTime;

    // Log summary
    await logSystemEvent('decisions_complete', {
      season_id: result.season_id,
      decision_day: result.decision_day,
      agents_processed: result.agents_processed,
      total_decisions: result.total_decisions,
      total_trades: result.total_trades,
      total_cost_usd: result.total_cost_usd,
      duration_ms: result.duration_ms,
      errors_count: result.errors.length
    });

  } catch (error) {
    result.duration_ms = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMsg);
    console.error('\nFatal error:', errorMsg);

    await logSystemEvent('decisions_error', {
      error: errorMsg,
      ...result
    }, 'error');
  }

  // Print summary
  console.log('='.repeat(60));
  console.log('DECISIONS COMPLETE');
  console.log('='.repeat(60));
  console.log(`Decision Day: ${result.decision_day}`);
  console.log(`Agents Processed: ${result.agents_processed}`);
  console.log(`Total Decisions: ${result.total_decisions}`);
  console.log(`Total Trades: ${result.total_trades}`);
  console.log(`Total Cost: $${result.total_cost_usd.toFixed(4)}`);
  console.log(`Duration: ${(result.duration_ms / 1000).toFixed(2)}s`);

  if (result.errors.length > 0) {
    console.log(`\nErrors (${result.errors.length}):`);
    result.errors.forEach(e => console.log(`  - ${e}`));
  }

  return result;
}

// Run if called directly
runDecisions()
  .then((result) => {
    if (result.errors.length === 0) {
      console.log('\nDecisions completed successfully!');
      process.exit(0);
    } else {
      console.log('\nDecisions completed with errors');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('\nFailed to run decisions:', error);
    process.exit(1);
  });
