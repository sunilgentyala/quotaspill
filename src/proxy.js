import { ensureChain, recordRequest, saveStats } from './stats.js';

/**
 * Reads an upstream SSE stream, passing bytes through to the client
 * unmodified (byte-for-byte, so no re-framing bugs), while scanning
 * `event:`/`data:` lines on the side to accumulate token-usage metadata.
 */
async function pipeSSEWithUsageTracking(upstream, res, wireAdapter, onUsage) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const dataJson = JSON.parse(dataStr);
            const usage = wireAdapter.parseSSEChunkForUsage(currentEvent, dataJson);
            if (usage) onUsage(usage);
          } catch {
            // Not a JSON data line; skip it, it isn't a usage event.
          }
        }
      } else if (line === '') {
        currentEvent = null;
      }
    }
  }
  res.end();
}

async function relayResponse(upstream, res, provider, wireAdapter, requestBody, ctx) {
  const { chainName, stats, statsPath } = ctx;
  const contentType = upstream.headers.get('content-type') || '';
  const headers = { 'x-quotaspill-source': `${provider.kind}:${provider.name}` };
  if (contentType) headers['content-type'] = contentType;
  res.writeHead(upstream.status, headers);

  let usage = null;
  if (requestBody?.stream === true && contentType.includes('text/event-stream')) {
    const acc = {};
    await pipeSSEWithUsageTracking(upstream, res, wireAdapter, (partial) => Object.assign(acc, partial));
    if (acc.inputTokens != null || acc.outputTokens != null) {
      usage = { inputTokens: acc.inputTokens || 0, outputTokens: acc.outputTokens || 0 };
    }
  } else {
    const text = await upstream.text();
    res.end(text);
    try {
      usage = wireAdapter.extractUsage(JSON.parse(text));
    } catch {
      usage = null;
    }
  }

  recordRequest(stats, chainName, provider.kind, provider.name, usage);
  if (statsPath) saveStats(statsPath, stats);
}

/**
 * Tries the primary provider first (unless its monthly request budget is
 * already spent), then each fallback in order, stopping at the first
 * response that isn't a quota/rate-limit error. A real error from a
 * provider (bad request, invalid auth, etc.) is relayed to the client
 * as-is rather than masked by a silent retry; only quota exhaustion
 * triggers failover.
 */
export async function handleProxyRequest({ requestBody, requestHeaders, chain, wireAdapter, chainName, budget, stats, statsPath }, res) {
  const chainStats = ensureChain(stats, chainName);
  const primary = chain.find((p) => p.kind === 'primary');
  const fallbacks = chain.filter((p) => p.kind === 'fallback');

  const cap = budget?.[chainName]?.monthlyRequestCap;
  const capReached = cap != null && chainStats.monthRequests >= cap;
  const attemptOrder = capReached ? fallbacks : [primary, ...fallbacks];

  const ctx = { chainName, stats, statsPath };
  let lastError = null;

  for (const provider of attemptOrder) {
    let upstream;
    try {
      upstream = await fetch(provider.baseUrl + wireAdapter.path, {
        method: 'POST',
        headers: wireAdapter.buildHeaders(provider.apiKey, requestHeaders),
        body: JSON.stringify(requestBody),
      });
    } catch (networkErr) {
      lastError = { status: 0, body: { error: { message: String(networkErr) } } };
      continue;
    }

    if (!upstream.ok) {
      let bodyJson = null;
      try {
        bodyJson = await upstream.clone().json();
      } catch {
        // Non-JSON error body, status code alone still drives isQuotaError.
      }
      if (wireAdapter.isQuotaError(upstream.status, bodyJson)) {
        lastError = { status: upstream.status, body: bodyJson };
        continue;
      }
      // A real error (bad request, invalid key, etc.); relay it, don't mask it.
      await relayResponse(upstream, res, provider, wireAdapter, requestBody, ctx);
      return;
    }

    await relayResponse(upstream, res, provider, wireAdapter, requestBody, ctx);
    return;
  }

  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        type: 'quotaspill_all_providers_exhausted',
        message: 'Every configured provider in this chain returned a quota/rate-limit error or was unreachable.',
        lastError,
      },
    })
  );
}
