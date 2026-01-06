/**
 * TypeScript Type Definitions
 *
 * Types for all database entities and API responses.
 *
 * @module types
 */

// ============================================================================
// DATABASE ENTITIES
// ============================================================================

export interface MethodologyVersion {
  version: string;
  title: string;
  description: string;
  changes_summary?: string;
  effective_from_season?: number;
  document_hash?: string;
  created_at: string;
}

export interface Season {
  id: string;
  season_number: number;
  started_at: string;
  status: 'active' | 'completed';
  completed_at?: string;
  methodology_version: string;
  initial_balance: number;
  created_at: string;
}

export interface Model {
  id: string;
  openrouter_id: string;
  display_name: string;
  provider: string;
  color?: string;
  is_active: boolean;
  added_at: string;
}

export interface Agent {
  id: string;
  season_id: string;
  model_id: string;
  cash_balance: number;
  total_invested: number;
  status: 'active' | 'bankrupt';
  created_at: string;
}

export interface Market {
  id: string;
  polymarket_id: string;
  slug?: string;
  event_slug?: string;
  question: string;
  description?: string;
  category?: string;
  market_type: 'binary' | 'multi_outcome';
  outcomes?: Record<string, unknown>;
  close_date: string;
  status: 'active' | 'closed' | 'resolved' | 'cancelled';
  current_price?: number;
  current_prices?: Record<string, number>;
  volume?: number;
  liquidity?: number;
  resolution_outcome?: string;
  resolved_at?: string;
  first_seen_at: string;
  last_updated_at: string;
}

export interface Position {
  id: string;
  agent_id: string;
  market_id: string;
  side: string;
  shares: number;
  avg_entry_price: number;
  total_cost: number;
  current_value?: number;
  unrealized_pnl?: number;
  status: 'open' | 'closed' | 'settled';
  opened_at: string;
  closed_at?: string;
}

export interface Decision {
  id: string;
  agent_id: string;
  season_id: string;
  decision_day: number;
  decision_timestamp: string;
  prompt_system: string;
  prompt_user: string;
  raw_response?: string;
  parsed_response?: ParsedDecision;
  retry_count: number;
  action: 'BET' | 'SELL' | 'HOLD' | 'ERROR';
  reasoning?: string;
  tokens_input?: number;
  tokens_output?: number;
  api_cost_usd?: number;
  response_time_ms?: number;
  error_message?: string;
  created_at: string;
}

export interface Trade {
  id: string;
  agent_id: string;
  market_id: string;
  position_id?: string;
  decision_id?: string;
  trade_type: 'BUY' | 'SELL';
  side: string;
  shares: number;
  price: number;
  total_amount: number;
  implied_confidence?: number;
  cost_basis?: number;
  realized_pnl?: number;
  executed_at: string;
}

export interface PortfolioSnapshot {
  id: string;
  agent_id: string;
  snapshot_timestamp: string;
  cash_balance: number;
  positions_value: number;
  total_value: number;
  total_pnl: number;
  total_pnl_percent: number;
  created_at: string;
}

export interface ApiCost {
  id: string;
  model_id: string;
  decision_id?: string;
  tokens_input?: number;
  tokens_output?: number;
  cost_usd?: number;
  recorded_at: string;
}

export interface SystemLog {
  id: string;
  event_type: string;
  event_data?: Record<string, unknown>;
  severity: 'info' | 'warning' | 'error';
  created_at: string;
}

// ============================================================================
// LLM DECISION TYPES
// ============================================================================

export interface BetInstruction {
  market_id: string;
  side: 'YES' | 'NO' | string;
  amount: number;
  reasoning?: string;  // Per-bet reasoning for transparency
}

export interface SellInstruction {
  position_id: string;
  percentage: number;
}

export interface ParsedDecision {
  action: 'BET' | 'SELL' | 'HOLD' | 'ERROR';
  bets?: BetInstruction[];
  sells?: SellInstruction[];
  reasoning: string;
  error?: string;
}

// ============================================================================
// POLYMARKET API TYPES
// ============================================================================

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
  winner?: boolean;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  description?: string;
  slug?: string;
  conditionId?: string;
  outcomes?: string[] | string;
  outcomePrices?: string[] | string;
  tokens?: PolymarketToken[];
  volume?: string | number;
  volumeNum?: number;
  liquidity?: string | number;
  liquidityNum?: number;
  endDate?: string;
  closed?: boolean;
  active?: boolean;
  archived?: boolean;
  category?: string;
  tags?: string[];
  events?: { slug?: string }[];
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  markets: PolymarketMarket[];
}

// ============================================================================
// OPENROUTER API TYPES
// ============================================================================

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenRouterResponse {
  content: string;
  usage: OpenRouterUsage;
  model: string;
  finish_reason: string;
  response_time_ms: number;
}

// ============================================================================
// HELPER TYPES
// ============================================================================

export interface PositionWithMarket extends Position {
  market_question: string;
  current_price: number;
}

export interface AgentWithModel extends Agent {
  model: Model;
}

export interface TradeResult {
  success: boolean;
  trade_id?: string;
  position_id?: string;
  shares?: number;
  error?: string;
}

export interface SellResult {
  success: boolean;
  trade_id?: string;
  proceeds?: number;
  shares_sold?: number;
  error?: string;
}
