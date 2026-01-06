/**
 * Supabase Client for Backend Operations
 *
 * Uses service role key for full database access.
 * Only use this in backend scripts, never in frontend.
 *
 * @module supabase
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from './constants';

let supabaseClient: SupabaseClient | null = null;

/**
 * Get Supabase client instance (singleton)
 */
export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error(
        'Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.'
      );
    }

    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
  }

  return supabaseClient;
}

/**
 * Log a system event to the system_logs table
 */
export async function logSystemEvent(
  eventType: string,
  eventData: Record<string, unknown>,
  severity: 'info' | 'warning' | 'error' = 'info'
): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from('system_logs').insert({
      event_type: eventType,
      event_data: eventData,
      severity
    });
  } catch (error) {
    console.error('Failed to log system event:', error);
  }
}

/**
 * Helper to handle Supabase errors
 */
export function handleSupabaseError(error: unknown, context: string): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Supabase error in ${context}:`, message);
  throw new Error(`${context}: ${message}`);
}
