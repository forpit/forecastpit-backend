/**
 * Application Constants and Configuration
 *
 * Central configuration for Prediarena.
 * All magic numbers and configuration values are defined here.
 *
 * @module constants
 */

// ============================================================================
// BETTING CONFIGURATION
// ============================================================================

/**
 * Initial balance for each agent in a new season
 * Each LLM starts with $10,000 virtual dollars
 */
export const INITIAL_BALANCE = 10000;

/**
 * Minimum bet size in dollars
 * Bets below this are rejected
 */
export const MIN_BET = 50;

/**
 * Maximum bet as percentage of current cash balance
 * Agents cannot bet more than 10% of their cash on a single market
 */
export const MAX_BET_PERCENT = 0.10;

/**
 * Number of top markets by volume to show to LLMs
 * Limits context size while focusing on most liquid markets
 */
export const TOP_MARKETS_COUNT = 300;

// ============================================================================
// LLM CONFIGURATION
// ============================================================================

/**
 * Temperature for LLM API calls
 * 0 = deterministic (reproducible results)
 */
export const LLM_TEMPERATURE = 0;

/**
 * Maximum tokens for LLM response
 * Needs to be higher for models with longer reasoning (e.g. Gemini Pro)
 */
export const LLM_MAX_TOKENS = 16000;

/**
 * Request timeout in milliseconds
 */
export const LLM_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Number of retries for malformed responses
 */
export const LLM_MAX_RETRIES = 1;

// ============================================================================
// SCHEDULING
// ============================================================================

/**
 * Decisions run daily at this hour (UTC)
 */
export const DECISION_HOUR_UTC = 0;

// ============================================================================
// METHODOLOGY
// ============================================================================

/**
 * Current methodology version
 */
export const METHODOLOGY_VERSION = 'v1';

// ============================================================================
// MODEL DEFINITIONS
// ============================================================================

/**
 * Competing LLM models (roster changes each season)
 */
export const MODELS = [
  {
    id: 'gpt-5.2',
    openrouterId: 'openai/gpt-5.2',
    displayName: 'GPT-5.2',
    provider: 'OpenAI',
    color: '#10B981'
  },
  {
    id: 'claude-opus-4.5',
    openrouterId: 'anthropic/claude-opus-4.5',
    displayName: 'Claude Opus 4.5',
    provider: 'Anthropic',
    color: '#F59E0B'
  },
  {
    id: 'gemini-3-pro',
    openrouterId: 'google/gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro',
    provider: 'Google',
    color: '#3B82F6'
  },
  {
    id: 'grok-4',
    openrouterId: 'x-ai/grok-4',
    displayName: 'Grok 4',
    provider: 'xAI',
    color: '#8B5CF6'
  },
  {
    id: 'deepseek-v3.2',
    openrouterId: 'deepseek/deepseek-v3.2',
    displayName: 'DeepSeek V3.2',
    provider: 'DeepSeek',
    color: '#EF4444'
  },
  {
    id: 'qwen3-235b',
    openrouterId: 'qwen/qwen3-235b-a22b-07-25',
    displayName: 'Qwen3-235B',
    provider: 'Alibaba',
    color: '#06B6D4'
  },
  {
    id: 'mistral-large-3',
    openrouterId: 'mistralai/mistral-large-2512',
    displayName: 'Mistral Large 3',
    provider: 'Mistral',
    color: '#EC4899'
  },
  {
    id: 'llama-3.3-70b',
    openrouterId: 'meta-llama/llama-3.3-70b-instruct',
    displayName: 'Llama 3.3 70B',
    provider: 'Meta',
    color: '#F97316'
  }
] as const;

/**
 * Type for model IDs
 */
export type ModelId = typeof MODELS[number]['id'];

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

/**
 * Supabase URL
 */
export const SUPABASE_URL = process.env.SUPABASE_URL || '';

/**
 * Supabase Service Role Key (for backend operations)
 */
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

/**
 * OpenRouter API Key
 */
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// ============================================================================
// API CONFIGURATION
// ============================================================================

/**
 * Polymarket Gamma API base URL
 */
export const POLYMARKET_API_URL = 'https://gamma-api.polymarket.com';

/**
 * OpenRouter API base URL
 */
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Rate limiting delays (in ms)
 */
export const API_DELAYS = {
  POLYMARKET_BETWEEN_REQUESTS: 500,
  OPENROUTER_BETWEEN_REQUESTS: 1000,
  RETRY_BASE_DELAY: 2000,
  RETRY_MAX_DELAY: 30000
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get model configuration by ID
 */
export function getModelById(id: string) {
  return MODELS.find(m => m.id === id);
}

/**
 * Get model configuration by OpenRouter ID
 */
export function getModelByOpenRouterId(openrouterId: string) {
  return MODELS.find(m => m.openrouterId === openrouterId);
}

/**
 * Calculate maximum bet for a given cash balance
 */
export function calculateMaxBet(cashBalance: number): number {
  return cashBalance * MAX_BET_PERCENT;
}

/**
 * Validate bet amount against constraints
 */
export function validateBetAmount(amount: number, cashBalance: number): {
  valid: boolean;
  error?: string;
  adjustedAmount?: number;
} {
  if (amount < MIN_BET) {
    return { valid: false, error: `Minimum bet is $${MIN_BET}` };
  }

  const maxBet = calculateMaxBet(cashBalance);

  if (amount > maxBet) {
    return {
      valid: true,
      adjustedAmount: maxBet,
      error: `Amount capped to maximum of $${maxBet.toFixed(2)} (${MAX_BET_PERCENT * 100}% of balance)`
    };
  }

  if (amount > cashBalance) {
    return { valid: false, error: 'Insufficient balance' };
  }

  return { valid: true };
}
