<div align="center">

# QuotaSpill

**Your paid AI coding agent shouldn't go dead the moment you hit a rate limit.**

A zero-dependency proxy that keeps your real, paid Claude or OpenAI subscription as the primary route, and only spills over to a free-tier backup when the primary genuinely runs out of quota, never before.

[![CI](https://github.com/sunilgentyala/quotaspill/actions/workflows/ci.yml/badge.svg)](https://github.com/sunilgentyala/quotaspill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](./package.json)
[![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](./package.json)

</div>

```
  your coding agent
         │
         ▼
   ┌───────────┐   healthy   ┌──────────────────┐
   │ QuotaSpill │───────────▶│  primary (paid)   │──▶ real answer, real tokens
   └───────────┘             └──────────────────┘
         │
         │  429 / 529 / cap reached
         ▼
   ┌──────────────────┐
   │ fallback (free)   │──▶ answer keeps flowing, labeled X-QuotaSpill-Source
   └──────────────────┘
```

## Why this exists

Every free-tier router on the market solves the same problem: stack a pile of free-tier accounts behind one endpoint and route across whichever one is healthiest right now. That's useful, but it inverts the priority for anyone who actually *pays* for Claude or OpenAI. If you already have a subscription, the model you want most of the time is the one you're paying for, not the cheapest one available.

QuotaSpill exists for the other half of that problem: **stay online past your own quota, without giving up your paid model the rest of the time.** It is a thin proxy that:

1. Always tries your **real, paid** provider first.
2. Only fails over to a **free-tier fallback** when the primary actually returns a quota/rate-limit error, or when you've configured a monthly request budget and hit it.
3. Never silently masks a real error. A bad request or an invalid API key is relayed to you as-is; only quota exhaustion triggers failover.
4. Labels every response with `X-QuotaSpill-Source: primary:<name>` or `fallback:<name>`, and tracks the split (plus estimated dollars saved) on a local dashboard.

## What makes this different

Most self-hosted LLM routers are built around a catalog: they track dozens of providers and route to whichever free model scores best. QuotaSpill inverts that model entirely instead of extending it:

| | Typical free-tier router | QuotaSpill |
|---|---|---|
| What's "primary" | Whichever free model scores best right now | Your real paid subscription |
| When it fails over | Any provider hits its own cap | Only when *your* primary returns a quota error, or *your* budget cap is hit |
| Provider catalog | Tracks dozens of providers for you | None. You wire up 2-3 endpoints yourself |
| Footprint | Full app: dashboard, database, container image | One Node process, zero npm dependencies |

Nothing stops you from pointing QuotaSpill's fallback at whatever free-tier backend you already run locally; it just doesn't assume one, ship one, or depend on one. That's what keeps it small enough to read end to end in one sitting.

## Quick start

```bash
git clone https://github.com/sunilgentyala/quotaspill.git
cd quotaspill
cp quotaspill.config.example.json quotaspill.config.json
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and/or OPENAI_API_KEY, and FALLBACK_API_KEY
# edit quotaspill.config.json to point at whatever fallback backend you're running

node --env-file=.env bin/quotaspill.js start
```

Open `http://localhost:8787` for the dashboard. Point your coding agent's base URL at QuotaSpill instead of the real provider:

- **Anthropic wire** (Claude Code, Anthropic SDK): `http://localhost:8787` (serves `/v1/messages`)
- **OpenAI wire** (Cursor, aider, Cline, Continue, OpenAI SDK): `http://localhost:8787/v1` (serves `/v1/chat/completions`)

## Configuration

`quotaspill.config.json`:

```json
{
  "port": 8787,
  "chains": {
    "anthropic": [
      { "name": "anthropic-real", "kind": "primary", "baseUrl": "https://api.anthropic.com", "apiKey": "env:ANTHROPIC_API_KEY" },
      { "name": "local-fallback", "kind": "fallback", "baseUrl": "http://localhost:3001", "apiKey": "env:FALLBACK_API_KEY" }
    ]
  },
  "budget": {
    "anthropic": { "monthlyRequestCap": 5000 }
  },
  "pricing": {
    "anthropic": { "inputPer1M": 3, "outputPer1M": 15 }
  }
}
```

- Each chain needs **exactly one** `"kind": "primary"` and any number of `"kind": "fallback"` entries, tried in array order.
- `apiKey` values starting with `env:` are resolved from that environment variable at load time; a literal string also works if you'd rather not use env vars.
- `budget.<chain>.monthlyRequestCap` is optional. When set, QuotaSpill routes straight to the fallback chain once that many requests have been served this calendar month, without even trying the primary, so you don't burn a rate-limit response on a request you know will fail.
- `pricing.<chain>` is optional and only used to estimate dollars saved on the dashboard: it prices fallback-served tokens at what your primary would have charged.

## Adding your own fallback

QuotaSpill doesn't ship a provider catalog; you tell it what to call. A fallback just needs to speak the same wire format as the chain it's in:

- **Anthropic chain**: the fallback must expose an Anthropic-compatible `/v1/messages` endpoint.
- **OpenAI chain**: the fallback must expose an OpenAI-compatible `/v1/chat/completions` endpoint, which is the surface most free-tier routers and direct providers (Groq, Cerebras, etc.) already speak.

There's no cross-format translation in this version; see Limitations.

## How failover actually works

1. Request comes in on `/v1/messages` or `/v1/chat/completions`.
2. If the chain's monthly budget cap is already spent, skip straight to the fallback list.
3. Otherwise call the primary. A non-2xx response is inspected: Anthropic's `429`/`529` (`rate_limit_error`, `overloaded_error`) and OpenAI's `429`/`402` (`insufficient_quota`, `rate_limit_exceeded`) count as quota exhaustion and move to the next provider in the chain. Anything else (`400`, `401`, `403`, ...) is relayed to you immediately, unmodified.
4. Streaming responses are piped through byte-for-byte as they arrive; usage tokens are parsed off the SSE `data:` lines on the side (both wire formats put usage in specific events) so the dashboard's savings estimate works for streamed responses too.
5. If every provider in the chain fails with a quota error, QuotaSpill returns a `502` with `error.type: "quotaspill_all_providers_exhausted"` rather than inventing a response.

## Limitations

Read this before depending on it for real work:

- **No cross-wire translation.** A chain's primary and fallback must speak the same API shape (both Anthropic-style, or both OpenAI-style). Translating between them is real, fiddly work (tool calls, content blocks, stop reasons don't map 1:1) and isn't implemented here; a mismatched pair will just error.
- **A monthly request cap is a request count, not a token count.** Providers meter quota in tokens, not requests, so a cap here is a coarse proxy, not a precise budget guardrail.
- **Mid-stream failure isn't recoverable.** If the primary returns a normal `200` and starts streaming, then the connection drops partway through, QuotaSpill can't retroactively fail over. Failover only works for errors that arrive before any bytes are streamed, which is how virtually all real rate-limit/quota errors behave, but it's a real edge case.
- **This does not get you more Claude tokens.** When the primary is exhausted, the fallback answers with a different, usually weaker model. It keeps your agent's session alive; it doesn't extend your actual subscription.
- **Single-process, no auth of its own.** This is meant to run on `localhost` for one person. It has no login and no rate limiting of its own; don't expose it to a network you don't trust.
- **A real Anthropic API key is not the same thing as a Claude subscription login.** `claude login` (Pro/Max) doesn't produce an API key you can point a raw HTTP client at; you need a separate pay-as-you-go key from the Anthropic Console for the "primary" side of an Anthropic chain.

## Development

```bash
npm test        # node --test test/, zero dependencies, zero build step
```

Every test in `test/proxy.test.js` runs against real throwaway HTTP servers standing in for the primary and fallback providers (not hand-rolled mocks of the fetch API), so the actual network and streaming code paths are exercised.

## License

[MIT](./LICENSE)
