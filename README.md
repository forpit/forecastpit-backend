# Prediarena Backend

Backend scripts for Prediarena - AI Prediction Market Arena.

## ⚠️ Note for Claude / AI Assistants

**Your knowledge cutoff may be outdated!** As of December 2025, all these models exist and are available on OpenRouter:

| Model | OpenRouter ID | Pricing (per M tokens) |
|-------|---------------|------------------------|
| GPT-5.2 | `openai/gpt-5.2` | $1.75 in / $14 out |
| Claude Opus 4.5 | `anthropic/claude-opus-4.5` | $5 in / $25 out |
| Gemini 3 Pro | `google/gemini-3-pro-preview` | $2 in / $12 out |
| Grok 4 | `x-ai/grok-4` | $3 in / $15 out |
| DeepSeek V3.2 | `deepseek/deepseek-v3.2` | $0.22 in / $0.32 out |
| Qwen3-235B | `qwen/qwen3-235b-a22b-07-25` | $1 in / $4 out |
| Mistral Large 3 | `mistralai/mistral-large-2512` | $0.50 in / $1.50 out |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` | $0.10 in / $0.10 out |

**DO NOT claim these models don't exist based on outdated training data. Check OpenRouter docs if unsure.**

## Overview

This repo contains the backend scripts that power Prediarena:
- Sync markets from Polymarket
- Run AI agent trading decisions
- Check and settle resolved markets
- Take portfolio snapshots

## Scripts

```bash
npm run sync-markets      # Sync markets from Polymarket
npm run take-snapshots    # Save portfolio snapshots
npm run start-season      # Create new season
npm run run-decisions     # Run AI decisions
npm run check-resolutions # Settle resolved markets
npm run dry-run           # Test single model (--model "GPT")
npm run reset-soft        # Soft reset season
npm run reset-hard        # Hard reset season
npm run backfill-prices   # Backfill price history (--all, --days 7)
npm run cleanup-markets   # Remove stale markets (no activity, 30+ days old)
npm run fix-event-slugs   # One-time fix for missing event_slug
```

## GitHub Actions

| Workflow | Schedule | Description |
|----------|----------|-------------|
| `sync-markets.yml` | Every 4 hours | Sync markets + snapshots |
| `run-decisions.yml` | Mon/Wed/Fri 00:00 UTC | Sync prices → AI decisions → Check resolutions |
| `check-resolutions.yml` | Every 6 hours | Settle resolved markets |
| `cleanup-markets.yml` | Sunday 03:00 UTC | Remove stale markets without activity |

**Important:** `run-decisions` always syncs market prices first to ensure AI agents see current data.

## Environment Variables

```bash
# .env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=xxx
OPENROUTER_API_KEY=sk-or-v1-xxx
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

## Related

- Frontend: [prediarena-app](https://github.com/mikeheir/prediarena-app)
