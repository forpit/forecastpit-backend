/**
 * Test Market Opinions Script
 *
 * Ask all 8 models for their opinion on a specific market.
 * This is a test to see how the feature would work.
 */

import 'dotenv/config';
import { getSupabase } from '../lib/supabase';
import { chatCompletionWithRetry } from '../lib/openrouter';
import { MODELS } from '../lib/constants';

const MARKET_ID = 'b4034e2c-a1d9-4383-babf-3a665ea47579'; // Russia/Ukraine ceasefire

interface MarketOpinion {
  model: string;
  provider: string;
  probability: number;
  action: 'BUY YES' | 'BUY NO' | 'HOLD';
  reasoning: string;
  responseTimeMs: number;
  error?: string;
}

function buildOpinionPrompt(market: any): string {
  const yesPrice = parseFloat(market.current_price);
  const noPrice = 1 - yesPrice;
  const yesPricePercent = (yesPrice * 100).toFixed(1);
  const noPricePercent = (noPrice * 100).toFixed(1);

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const closeDate = new Date(market.close_date);
  const daysUntilClose = Math.ceil((closeDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  const timeLabel = daysUntilClose <= 0 ? 'EXPIRED' :
                    daysUntilClose === 1 ? '1 day left' :
                    `${daysUntilClose} days left`;

  return `You are a forecaster analyzing a prediction market. Give your honest probability estimate and brief reasoning.

**Today's Date: ${todayStr}**

## Market
Question: ${market.question}
Category: ${market.category || 'General'}

Description: ${market.description || 'No description available.'}

Current prices: YES ${yesPricePercent}% / NO ${noPricePercent}%
Closes: ${closeDate.toISOString().split('T')[0]} (${timeLabel})
Trading volume: $${((parseFloat(market.volume) || 0) / 1000000).toFixed(1)}M

## Your Task
Analyze this market and respond with ONLY valid JSON (no markdown, no code blocks):

{
  "probability": <your probability estimate 0-100>,
  "action": "<BUY YES | BUY NO | HOLD>",
  "reasoning": "<2-3 sentences explaining your view>"
}

Guidelines:
- If your probability > market price + 5%, recommend BUY YES
- If your probability < market price - 5%, recommend BUY NO
- Otherwise recommend HOLD
- Think about base rates and outside view
- Consider the time remaining until resolution
- Be concise but insightful`;
}

async function getMarketOpinion(market: any, model: typeof MODELS[number]): Promise<MarketOpinion> {
  const startTime = Date.now();

  try {
    const prompt = buildOpinionPrompt(market);

    const response = await chatCompletionWithRetry(
      model.openrouterId,
      [{ role: 'user', content: prompt }],
      3, // maxRetries
      {
        temperature: 0,
        maxTokens: 500
      }
    );

    const responseTimeMs = response.response_time_ms;
    const content = response.content;

    // Parse JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response: ' + content.substring(0, 100));
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      model: model.displayName,
      provider: model.provider,
      probability: parsed.probability,
      action: parsed.action,
      reasoning: parsed.reasoning,
      responseTimeMs
    };
  } catch (error) {
    return {
      model: model.displayName,
      provider: model.provider,
      probability: 0,
      action: 'HOLD',
      reasoning: '',
      responseTimeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('TEST: MARKET OPINIONS FROM ALL 8 MODELS');
  console.log('='.repeat(70));

  // Fetch market
  const supabase = getSupabase();
  const { data: market, error } = await supabase
    .from('markets')
    .select('*')
    .eq('id', MARKET_ID)
    .single();

  if (error || !market) {
    console.error('Failed to fetch market:', error);
    process.exit(1);
  }

  console.log(`\nMarket: ${market.question}`);
  console.log(`Current price: ${(parseFloat(market.current_price) * 100).toFixed(1)}%`);
  console.log(`Volume: $${(parseFloat(market.volume) / 1000000).toFixed(1)}M`);
  console.log('\n' + '-'.repeat(70));
  console.log('Querying all 8 models in parallel...\n');

  const startTime = Date.now();

  // Query all models in parallel
  const opinions = await Promise.all(
    MODELS.map(model => getMarketOpinion(market, model))
  );

  const totalTime = Date.now() - startTime;

  // Display results
  console.log('='.repeat(70));
  console.log('RESULTS');
  console.log('='.repeat(70));

  for (const opinion of opinions) {
    console.log(`\n### ${opinion.model} (${opinion.provider})`);
    if (opinion.error) {
      console.log(`   ERROR: ${opinion.error}`);
    } else {
      console.log(`   Probability: ${opinion.probability}%`);
      console.log(`   Action: ${opinion.action}`);
      console.log(`   Reasoning: ${opinion.reasoning}`);
      console.log(`   Response time: ${(opinion.responseTimeMs / 1000).toFixed(1)}s`);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const successful = opinions.filter(o => !o.error);
  const avgProbability = successful.reduce((sum, o) => sum + o.probability, 0) / successful.length;

  const buyYes = successful.filter(o => o.action === 'BUY YES').length;
  const buyNo = successful.filter(o => o.action === 'BUY NO').length;
  const hold = successful.filter(o => o.action === 'HOLD').length;

  console.log(`\nMarket price: ${(parseFloat(market.current_price) * 100).toFixed(1)}%`);
  console.log(`Average AI probability: ${avgProbability.toFixed(1)}%`);
  console.log(`\nVotes: BUY YES: ${buyYes} | BUY NO: ${buyNo} | HOLD: ${hold}`);
  console.log(`\nTotal time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`Successful responses: ${successful.length}/${MODELS.length}`);
}

main().catch(console.error);
