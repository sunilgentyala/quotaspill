// Wire adapter for Anthropic's Messages API (/v1/messages), also spoken by
// several self-hosted routers that offer an Anthropic-compatible mode.

export const path = '/v1/messages';

/**
 * Anthropic signals quota/rate-limit exhaustion with HTTP 429 (rate_limit_error)
 * or 529 (overloaded_error). Both are safe to fail over on: the request was
 * never billed/served by this provider.
 */
export function isQuotaError(status, bodyJson) {
  if (status === 429 || status === 529) return true;
  if (status >= 400 && bodyJson?.error?.type === 'rate_limit_error') return true;
  return false;
}

export function buildHeaders(apiKey, incomingHeaders) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': incomingHeaders['anthropic-version'] || '2023-06-01',
    accept: incomingHeaders.accept || 'application/json',
  };
}

/** Non-streaming response usage: { usage: { input_tokens, output_tokens } }. */
export function extractUsage(bodyJson) {
  const usage = bodyJson?.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

/**
 * Streaming usage arrives split across two SSE events: message_start carries
 * input_tokens, message_delta carries the final output_tokens. We merge
 * across calls by returning partial updates; the caller accumulates them.
 */
export function parseSSEChunkForUsage(eventName, dataJson) {
  if (eventName === 'message_start') {
    const u = dataJson?.message?.usage;
    if (u?.input_tokens != null) return { inputTokens: u.input_tokens };
  }
  if (eventName === 'message_delta') {
    const u = dataJson?.usage;
    if (u?.output_tokens != null) return { outputTokens: u.output_tokens };
  }
  return null;
}
