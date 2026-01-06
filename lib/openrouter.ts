/**
 * OpenRouter API Client
 *
 * Client for making LLM API calls via OpenRouter.
 * Supports all 8 competing models with unified interface.
 *
 * @see https://openrouter.ai/docs
 * @module openrouter
 */

import {
  OPENROUTER_API_KEY,
  OPENROUTER_API_URL,
  LLM_TEMPERATURE,
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  API_DELAYS
} from './constants';
import type { OpenRouterMessage, OpenRouterResponse, OpenRouterUsage } from './types';

// ============================================================================
// TYPES
// ============================================================================

interface OpenRouterAPIResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: OpenRouterUsage;
}

interface OpenRouterError {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Make a chat completion request to OpenRouter
 */
export async function chatCompletion(
  modelId: string,
  messages: OpenRouterMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
  } = {}
): Promise<OpenRouterResponse> {
  if (!OPENROUTER_API_KEY) {
    throw new Error('Missing OPENROUTER_API_KEY environment variable');
  }

  const temperature = options.temperature ?? LLM_TEMPERATURE;
  const maxTokens = options.maxTokens ?? LLM_MAX_TOKENS;
  const timeout = options.timeout ?? LLM_TIMEOUT_MS;

  const startTime = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://prediarena.com',
        'X-Title': 'Prediarena'
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json() as OpenRouterError;
      throw new Error(
        `OpenRouter API error (${response.status}): ${errorData.error?.message || response.statusText}`
      );
    }

    const data = await response.json() as OpenRouterAPIResponse;
    const responseTimeMs = Date.now() - startTime;

    // Debug: log full response for troubleshooting
    if (process.env.DEBUG_OPENROUTER) {
      console.log('\n=== DEBUG: Full OpenRouter Response ===');
      console.log(JSON.stringify(data, null, 2));
      console.log('========================================\n');
    }

    if (!data.choices || data.choices.length === 0) {
      throw new Error('OpenRouter returned empty response');
    }

    return {
      content: data.choices[0].message.content,
      usage: data.usage,
      model: data.model,
      finish_reason: data.choices[0].finish_reason,
      response_time_ms: responseTimeMs
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`OpenRouter request timed out after ${timeout}ms`);
    }

    throw error;
  }
}

/**
 * Make a chat completion with retry logic
 */
export async function chatCompletionWithRetry(
  modelId: string,
  messages: OpenRouterMessage[],
  maxRetries: number = 3,
  options: {
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
  } = {}
): Promise<OpenRouterResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await chatCompletion(modelId, messages, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on certain errors
      if (lastError.message.includes('Invalid API key') ||
          lastError.message.includes('model not found') ||
          lastError.message.includes('context length exceeded')) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        // Exponential backoff
        const delay = Math.min(
          API_DELAYS.RETRY_BASE_DELAY * Math.pow(2, attempt),
          API_DELAYS.RETRY_MAX_DELAY
        );
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Unknown error in chatCompletionWithRetry');
}

/**
 * Calculate estimated cost for a request
 * Note: This is an approximation - actual costs come from OpenRouter
 */
export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Approximate pricing per million tokens (from OpenRouter, Dec 2024)
  // These are estimates - actual costs tracked in OpenRouter dashboard
  const pricing: Record<string, { input: number; output: number }> = {
    'openai/gpt-5.2': { input: 1.75, output: 14.00 },
    'anthropic/claude-opus-4.5': { input: 5.00, output: 25.00 },
    'google/gemini-3-pro-preview': { input: 2.00, output: 12.00 },
    'x-ai/grok-4.1': { input: 3.00, output: 15.00 },
    'deepseek/deepseek-r1': { input: 0.50, output: 2.00 },
    'qwen/qwen3-235b-a22b-instruct': { input: 1.00, output: 4.00 },
    'mistralai/mistral-large-2512': { input: 0.50, output: 1.50 },
    'moonshotai/kimi-k2': { input: 1.00, output: 4.00 }
  };

  const modelPricing = pricing[modelId] || { input: 1.00, output: 3.00 };

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Get actual cost from OpenRouter usage data
 */
export function calculateCostFromUsage(usage: OpenRouterUsage, modelId: string): number {
  return estimateCost(modelId, usage.prompt_tokens, usage.completion_tokens);
}
