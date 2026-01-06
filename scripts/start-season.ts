/**
 * Start Season Script
 *
 * Creates a new season and initializes agents for all 8 models.
 * Should be run once to start a new competition round.
 *
 * Usage: npx tsx scripts/start-season.ts
 *
 * @module scripts/start-season
 */

import 'dotenv/config';
import { getSupabase, logSystemEvent } from '../lib/supabase';
import { MODELS, INITIAL_BALANCE, METHODOLOGY_VERSION } from '../lib/constants';

interface SeasonResult {
  season_id: string;
  season_number: number;
  agents_created: number;
  errors: string[];
}

/**
 * Get the next season number
 */
async function getNextSeasonNumber(): Promise<number> {
  const supabase = getSupabase();

  const { data } = await supabase
    .from('seasons')
    .select('season_number')
    .order('season_number', { ascending: false })
    .limit(1)
    .single();

  return (data?.season_number ?? 0) + 1;
}

/**
 * Create a new season
 */
async function createSeason(seasonNumber: number): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('seasons')
    .insert({
      season_number: seasonNumber,
      started_at: new Date().toISOString(),
      status: 'active',
      methodology_version: METHODOLOGY_VERSION,
      initial_balance: INITIAL_BALANCE
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create season: ${error?.message}`);
  }

  return data.id;
}

/**
 * Ensure model exists in database
 */
async function ensureModel(model: typeof MODELS[number]): Promise<string> {
  const supabase = getSupabase();

  // Check if model exists
  const { data: existing } = await supabase
    .from('models')
    .select('id')
    .eq('openrouter_id', model.openrouterId)
    .single();

  if (existing) {
    return existing.id;
  }

  // Create model
  const { data, error } = await supabase
    .from('models')
    .insert({
      id: model.id,
      openrouter_id: model.openrouterId,
      display_name: model.displayName,
      provider: model.provider,
      color: model.color,
      is_active: true
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create model ${model.displayName}: ${error?.message}`);
  }

  return data.id;
}

/**
 * Create an agent for a model in the season
 */
async function createAgent(seasonId: string, modelId: string): Promise<string> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('agents')
    .insert({
      season_id: seasonId,
      model_id: modelId,
      cash_balance: INITIAL_BALANCE,
      total_invested: 0,
      status: 'active'
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to create agent: ${error?.message}`);
  }

  return data.id;
}

/**
 * Main function to start a new season
 */
async function startSeason(): Promise<SeasonResult> {
  console.log('='.repeat(60));
  console.log('START SEASON');
  console.log('='.repeat(60));

  const result: SeasonResult = {
    season_id: '',
    season_number: 0,
    agents_created: 0,
    errors: []
  };

  try {
    // Get next season number
    const seasonNumber = await getNextSeasonNumber();
    result.season_number = seasonNumber;
    console.log(`\nCreating Season #${seasonNumber}...`);

    // Create season
    const seasonId = await createSeason(seasonNumber);
    result.season_id = seasonId;
    console.log(`Season created: ${seasonId}`);

    // Create agents for each model
    console.log(`\nInitializing ${MODELS.length} agents...`);

    for (const model of MODELS) {
      try {
        console.log(`  - ${model.displayName} (${model.provider})...`);

        // Ensure model exists
        const modelId = await ensureModel(model);

        // Create agent
        const agentId = await createAgent(seasonId, modelId);

        console.log(`    Agent created: ${agentId}`);
        result.agents_created++;
      } catch (error) {
        const errorMsg = `Failed to create agent for ${model.displayName}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`    ERROR: ${errorMsg}`);
        result.errors.push(errorMsg);
      }
    }

    // Log event
    await logSystemEvent('season_started', {
      season_id: seasonId,
      season_number: seasonNumber,
      agents_created: result.agents_created,
      initial_balance: INITIAL_BALANCE,
      methodology_version: METHODOLOGY_VERSION
    });

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SEASON STARTED');
    console.log('='.repeat(60));
    console.log(`Season Number: ${result.season_number}`);
    console.log(`Season ID: ${result.season_id}`);
    console.log(`Agents Created: ${result.agents_created}/${MODELS.length}`);
    console.log(`Initial Balance: $${INITIAL_BALANCE.toLocaleString()}`);

    if (result.errors.length > 0) {
      console.log(`\nErrors (${result.errors.length}):`);
      result.errors.forEach(e => console.log(`  - ${e}`));
    }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('\nFatal error:', errorMsg);
    result.errors.push(errorMsg);

    await logSystemEvent('season_start_error', {
      error: errorMsg,
      ...result
    }, 'error');
  }

  return result;
}

// Run if called directly
startSeason()
  .then((result) => {
    if (result.agents_created === MODELS.length) {
      console.log('\nSeason started successfully!');
      process.exit(0);
    } else {
      console.log('\nSeason started with errors');
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('\nFailed to start season:', error);
    process.exit(1);
  });
