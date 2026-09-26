# QuotaSpill

**Keep your paid Claude/OpenAI-compatible coding agent running when your subscription quota runs out, by spilling over to a free-tier backend only when the primary actually fails.**

[![CI](https://github.com/sunilgentyala/quotaspill/actions/workflows/ci.yml/badge.svg)](https://github.com/sunilgentyala/quotaspill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

## Why this exists

Free-tier LLM routers (freellmapi, OpenRouter, LiteLLM's public routing) all solve the same problem: stack a bunch of free-tier accounts behind one endpoint and route across them. None of them solve the opposite, more common problem for a paying developer: **you already pay for Claude or OpenAI, you just don't want your coding agent to go dead the moment you hit a rate limit or burn through a monthly cap.**

QuotaSpill is not another free-tier aggregator. It is a thin proxy that:

1. Always tries your **real, paid** provider first.
2. Only fails over to a **free-tier fallback** (which can be a single free provider, or a whole aggregator like [freellmapi](https://github.com/tashfeenahmed/freellmapi) running locally) when the primary actually returns a quota/rate-limit error, or when you've configured a monthly request budget and hit it.
3. Never silently masks a real error. A bad request or an invalid API key is relayed to you as-is; only quota exhaustion triggers failover.
4. Labels every response with `X-QuotaSpill-Source: primary:<name>` or `fallback:<name>`, and tracks the split (plus estimated dollars saved) on a local dashboard.

## How it's different from freellmapi

They compose well together rather than compete:

| | freellmapi | QuotaSpill |
|---|---|---|
| What's "primary" | Whichever free-tier model scores best right now | Your real paid subscription/API key |
| When it fails over | Any provider hits its free-tier cap | Only when the primary returns a quota error, or your own budget cap is hit |
| Catalog | Tracks 34+ providers, hundreds of models | None. You configure 2-3 endpoints yourself |
| Dependencies | Full app: React dashboard, SQLite, Docker image | Zero npm dependencies, one Node process |

A natural pairing: point QuotaSpill's fallback at a local freellmapi instance, so when your paid Claude quota runs out mid-task, QuotaSpill spills over to whatever free model freellmapi currently has healthy, and your paid quota keeps resetting for next month untouched.

## Quick start

```bash
git clone https://github.com/sunilgentyala/quotaspill.git
cd quotaspill
cp quotaspill.config.example.json quotaspill.config.json
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and/or OPENAI_API_KEY, and FREELLMAPI_KEY
# edit quotaspill.config.json if your fallback isn't at localhost:3001

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
      { "name": "freellmapi-local", "kind": "fallback", "baseUrl": "http://localhost:3001", "apiKey": "env:FREELLMAPI_KEY" }
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

## Adding your own provider keys

QuotaSpill doesn't ship a provider catalog; you tell it what to call. Any fallback needs to speak the same wire format as the chain it's in:

- **Anthropic chain**: the fallback must expose an Anthropic-compatible `/v1/messages` endpoint. freellmapi does this natively.
- **OpenAI chain**: the fallback must expose an OpenAI-compatible `/v1/chat/completions` endpoint. Most free-tier routers (freellmapi, OpenRouter, Groq, Cerebras direct) do.

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
- **Single-process, no auth of its own.** Like freellmapi, this is meant to run on `localhost` for one person. It has no login and no rate limiting of its own; don't expose it to a network you don't trust.
- **A real Anthropic API key is not the same thing as a Claude subscription login.** `claude login` (Pro/Max) doesn't produce an API key you can point a raw HTTP client at; you need a separate pay-as-you-go key from the Anthropic Console for the "primary" side of an Anthropic chain.

## Development

```bash
npm test        # node --test test/, zero dependencies, zero build step
```

Every test in `test/proxy.test.js` runs against real throwaway HTTP servers standing in for the primary and fallback providers (not hand-rolled mocks of the fetch API), so the actual network and streaming code paths are exercised.

## License

[MIT](./LICENSE)
