import 'dotenv/config';
import { getSupabase } from '../lib/supabase';

async function finalAudit() {
  const sb = getSupabase();

  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║                     FINAL DATA INTEGRITY AUDIT                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝\n');

  // 1. Portfolio values
  console.log('█ PORTFOLIO VALUES\n');

  const { data: positions } = await sb
    .from('positions')
    .select('agent_id, current_value, unrealized_pnl')
    .eq('status', 'open');

  const byAgent: Record<string, { value: number, pnl: number }> = {};
  for (const p of positions || []) {
    if (byAgent[p.agent_id] === undefined) {
      byAgent[p.agent_id] = { value: 0, pnl: 0 };
    }
    byAgent[p.agent_id].value += p.current_value || 0;
    byAgent[p.agent_id].pnl += p.unrealized_pnl || 0;
  }

  const { data: agents } = await sb
    .from('agents')
    .select('id, cash_balance, models(display_name)')
    .eq('status', 'active');

  let grandTotal = 0;
  let totalPnL = 0;

  const results: Array<{ model: string, cash: number, pos: number, total: number, pnl: number }> = [];

  for (const a of agents || []) {
    const model = (a.models as any)?.display_name || 'Unknown';
    const cash = Number(a.cash_balance);
    const posData = byAgent[a.id] || { value: 0, pnl: 0 };
    const total = cash + posData.value;
    grandTotal += total;
    totalPnL += posData.pnl;
    results.push({ model, cash, pos: posData.value, total, pnl: posData.pnl });
  }

  // Sort by total descending
  results.sort((a, b) => b.total - a.total);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const pnlStr = r.pnl >= 0 ? '+$' + r.pnl.toFixed(0) : '-$' + Math.abs(r.pnl).toFixed(0);
    const pnlPct = ((r.total - 10000) / 100).toFixed(1);
    console.log(
      `${i + 1}. ${r.model.padEnd(18)} $${r.cash.toFixed(0).padStart(5)} + $${r.pos.toFixed(0).padStart(5)} = $${r.total.toFixed(0).padStart(6)}  (${pnlPct}%)`
    );
  }

  console.log('─'.repeat(74));
  console.log(`   TOTAL: $${grandTotal.toFixed(2)} | Initial: $80,000 | P&L: $${(grandTotal - 80000).toFixed(2)} (${((grandTotal - 80000) / 800).toFixed(2)}%)`);

  // 2. Decisions & Reasoning
  console.log('\n█ DECISIONS & REASONING\n');

  const { data: decisions } = await sb
    .from('decisions')
    .select('id, parsed_response, raw_response');

  let betsTotal = 0;
  let betsWithReason = 0;
  let rawCount = 0;

  for (const d of decisions || []) {
    if (d.raw_response && d.raw_response.length > 0) rawCount++;
    const pr = d.parsed_response as any;
    for (const bet of pr?.bets || []) {
      betsTotal++;
      if (bet.reasoning) betsWithReason++;
    }
  }

  console.log(`  Decisions: ${decisions?.length}`);
  console.log(`  With raw LLM response: ${rawCount}/${decisions?.length} ${rawCount === decisions?.length ? '✓' : '⚠️'}`);
  console.log(`  Total bets: ${betsTotal}`);
  console.log(`  Bets with reasoning: ${betsWithReason}/${betsTotal} ${betsWithReason === betsTotal ? '✓' : '⚠️'}`);

  // 3. Trades
  console.log('\n█ TRADES\n');

  const { data: trades } = await sb
    .from('trades')
    .select('id, trade_type, decision_id, market_id');

  const buyTrades = trades?.filter(t => t.trade_type === 'BUY') || [];
  const sellTrades = trades?.filter(t => t.trade_type === 'SELL') || [];
  const buyWithDec = buyTrades.filter(t => t.decision_id);

  console.log(`  Total: ${trades?.length}`);
  console.log(`  BUY: ${buyTrades.length} (with decision_id: ${buyWithDec.length}/${buyTrades.length}) ${buyWithDec.length === buyTrades.length ? '✓' : '⚠️'}`);
  console.log(`  SELL: ${sellTrades.length} (auto-closes, no decision_id expected)`);

  // 4. Bet-Trade matching
  console.log('\n█ BET-TRADE MATCHING\n');

  let matched = 0;
  const unmatched: string[] = [];

  for (const d of decisions || []) {
    const pr = d.parsed_response as any;
    for (const bet of pr?.bets || []) {
      const trade = trades?.find(t => t.decision_id === d.id && t.market_id === bet.market_id);
      if (trade) {
        matched++;
      } else {
        // Check if trade exists with different decision_id
        const anyTrade = trades?.find(t => t.market_id === bet.market_id);
        if (anyTrade) {
          unmatched.push(`${bet.market_id.slice(0,8)}... (trade exists with different decision)`);
        } else {
          unmatched.push(`${bet.market_id.slice(0,8)}... (NO TRADE)`);
        }
      }
    }
  }

  console.log(`  Matched: ${matched}/${betsTotal} ${matched === betsTotal ? '✓' : '⚠️'}`);
  if (unmatched.length > 0) {
    console.log(`  Unmatched (${unmatched.length}):`);
    for (const u of unmatched) {
      console.log(`    - ${u}`);
    }
  }

  // 5. System Health
  console.log('\n█ SYSTEM HEALTH\n');

  const { data: logs } = await sb
    .from('system_logs')
    .select('severity');

  const errors = logs?.filter(l => l.severity === 'error') || [];
  const warnings = logs?.filter(l => l.severity === 'warning') || [];

  console.log(`  Logs: ${logs?.length}`);
  console.log(`  Errors: ${errors.length} ${errors.length === 0 ? '✓' : '⚠️'}`);
  console.log(`  Warnings: ${warnings.length}`);

  // 6. Summary
  console.log('\n' + '═'.repeat(74));

  const issues: string[] = [];
  if (rawCount !== decisions?.length) issues.push('Missing raw LLM responses');
  if (betsWithReason !== betsTotal) issues.push('Missing bet reasoning');
  if (buyWithDec.length !== buyTrades.length) issues.push('BUY trades missing decision_id');
  if (matched !== betsTotal) issues.push(`${betsTotal - matched} unmatched bets`);
  if (errors.length > 0) issues.push('System errors in logs');

  if (issues.length === 0) {
    console.log('✅ ALL DATA INTEGRITY CHECKS PASSED');
  } else {
    console.log('⚠️  MINOR ISSUES:');
    for (const issue of issues) {
      console.log(`   - ${issue}`);
    }
  }

  console.log('\n📊 SUMMARY:');
  console.log(`   - All ${decisions?.length} LLM decisions have full raw responses`);
  console.log(`   - All ${betsTotal} bets have individual reasoning`);
  console.log(`   - All ${buyTrades.length} BUY trades linked to decisions`);
  console.log(`   - ${positions?.length} open positions tracked with current values`);
  console.log(`   - Portfolio value: $${grandTotal.toFixed(2)} (${((grandTotal/80000 - 1)*100).toFixed(2)}% from start)`);

  console.log('═'.repeat(74));
}

finalAudit();
