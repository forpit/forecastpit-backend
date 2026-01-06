/**
 * Local Development Server for Market Opinions
 *
 * Run: npx tsx scripts/serve-opinions.ts
 *
 * This mimics the Edge Function locally for development.
 */

import 'dotenv/config';
import http from 'http';
import { getSupabase } from '../lib/supabase';
import { chatCompletionWithRetry } from '../lib/openrouter';
import { MODELS } from '../lib/constants';

const PORT = 3001;
const CACHE_HOURS = 24;

interface MarketOpinion {
  model_id: string;
  display_name: string;
  provider: string;
  probability: number;
  action: string;
  reasoning: string;
  response_time_ms: number;
  created_at: string;
  error?: string;
}

function buildPrompt(market: any): string {
  const yesPrice = parseFloat(market.current_price) || 0;
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

async function getModelOpinion(
  market: any,
  model: typeof MODELS[number]
): Promise<MarketOpinion> {
  const startTime = Date.now();

  try {
    const prompt = buildPrompt(market);

    const response = await chatCompletionWithRetry(
      model.openrouterId,
      [{ role: 'user', content: prompt }],
      3,
      { temperature: 0, maxTokens: 500 }
    );

    const responseTimeMs = response.response_time_ms;
    const content = response.content;

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      model_id: model.id,
      display_name: model.displayName,
      provider: model.provider,
      probability: parsed.probability,
      action: parsed.action,
      reasoning: parsed.reasoning,
      response_time_ms: responseTimeMs,
      created_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      model_id: model.id,
      display_name: model.displayName,
      provider: model.provider,
      probability: 0,
      action: 'HOLD',
      reasoning: '',
      response_time_ms: Date.now() - startTime,
      created_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Streaming endpoint
  if (req.method === 'POST' && req.url === '/get-market-opinions-stream') {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const { market_id, refresh = false } = JSON.parse(body);

      if (!market_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'market_id is required' }));
        return;
      }

      const supabase = getSupabase();

      // Fetch market
      const { data: market, error: marketError } = await supabase
        .from('markets')
        .select('*')
        .eq('id', market_id)
        .single();

      if (marketError || !market) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Market not found' }));
        return;
      }

      console.log(`\n📊 Market: ${market.question}`);

      // Check cache if not refreshing
      if (!refresh) {
        const cacheThreshold = new Date(Date.now() - CACHE_HOURS * 60 * 60 * 1000).toISOString();

        const { data: cachedOpinions } = await supabase
          .from('market_opinions')
          .select('*')
          .eq('market_id', market_id)
          .gte('created_at', cacheThreshold);

        if (cachedOpinions && cachedOpinions.length === MODELS.length) {
          console.log('✅ Returning cached opinions');

          const enrichedOpinions = cachedOpinions.map(op => {
            const model = MODELS.find(m => m.id === op.model_id);
            return {
              ...op,
              display_name: model?.displayName || op.model_id,
              provider: model?.provider || 'Unknown'
            };
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            market,
            opinions: enrichedOpinions,
            cached: true,
            cache_age_hours: Math.round((Date.now() - new Date(cachedOpinions[0].created_at).getTime()) / (1000 * 60 * 60))
          }));
          return;
        }
      }

      // SSE streaming
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // Send market info first
      res.write(`data: ${JSON.stringify({ type: 'market', market })}\n\n`);

      console.log('🤖 Streaming responses from 8 models...');

      // Query all models in parallel, stream as they complete
      const promises = MODELS.map(async (model) => {
        const opinion = await getModelOpinion(market, model);

        // Send opinion immediately
        res.write(`data: ${JSON.stringify({ type: 'opinion', opinion })}\n\n`);
        console.log(`  ✓ ${model.displayName}: ${opinion.probability}%`);

        // Save to database
        if (!opinion.error) {
          await supabase
            .from('market_opinions')
            .upsert({
              market_id,
              model_id: opinion.model_id,
              probability: opinion.probability,
              action: opinion.action,
              reasoning: opinion.reasoning,
              response_time_ms: opinion.response_time_ms,
              created_at: opinion.created_at
            }, {
              onConflict: 'market_id,model_id'
            });
        }

        return opinion;
      });

      await Promise.all(promises);

      // Send done signal
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();

    } catch (error) {
      console.error('Stream error:', error);
      res.write(`data: ${JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Unknown error' })}\n\n`);
      res.end();
    }
    return;
  }

  // Original non-streaming endpoint
  if (req.method !== 'POST' || req.url !== '/get-market-opinions') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  try {
    // Parse body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const { market_id, refresh = false } = JSON.parse(body);

    if (!market_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'market_id is required' }));
      return;
    }

    const supabase = getSupabase();

    // Fetch market
    const { data: market, error: marketError } = await supabase
      .from('markets')
      .select('*')
      .eq('id', market_id)
      .single();

    if (marketError || !market) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Market not found' }));
      return;
    }

    console.log(`\n📊 Market: ${market.question}`);

    // Check cache if not refreshing
    if (!refresh) {
      const cacheThreshold = new Date(Date.now() - CACHE_HOURS * 60 * 60 * 1000).toISOString();

      const { data: cachedOpinions } = await supabase
        .from('market_opinions')
        .select('*')
        .eq('market_id', market_id)
        .gte('created_at', cacheThreshold);

      if (cachedOpinions && cachedOpinions.length === MODELS.length) {
        console.log('✅ Returning cached opinions');

        const enrichedOpinions = cachedOpinions.map(op => {
          const model = MODELS.find(m => m.id === op.model_id);
          return {
            ...op,
            display_name: model?.displayName || op.model_id,
            provider: model?.provider || 'Unknown'
          };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          market,
          opinions: enrichedOpinions,
          cached: true,
          cache_age_hours: Math.round((Date.now() - new Date(cachedOpinions[0].created_at).getTime()) / (1000 * 60 * 60))
        }));
        return;
      }
    }

    console.log('🤖 Querying all 8 models...');

    // Query all models in parallel
    const opinions = await Promise.all(
      MODELS.map(model => getModelOpinion(market, model))
    );

    // Save to database
    for (const opinion of opinions) {
      if (!opinion.error) {
        await supabase
          .from('market_opinions')
          .upsert({
            market_id,
            model_id: opinion.model_id,
            probability: opinion.probability,
            action: opinion.action,
            reasoning: opinion.reasoning,
            response_time_ms: opinion.response_time_ms,
            created_at: opinion.created_at
          }, {
            onConflict: 'market_id,model_id'
          });
      }
    }

    const successful = opinions.filter(o => !o.error);
    console.log(`✅ Got ${successful.length}/${MODELS.length} responses`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      market,
      opinions,
      cached: false
    }));

  } catch (error) {
    console.error('Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }));
  }
});

server.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log(`🚀 Market Opinions Server running on http://localhost:${PORT}`);
  console.log('='.repeat(50));
  console.log('\nEndpoint: POST /get-market-opinions');
  console.log('Body: { "market_id": "uuid", "refresh": false }');
  console.log('\nPress Ctrl+C to stop\n');
});
