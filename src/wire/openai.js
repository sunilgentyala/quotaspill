// Wire adapter for the OpenAI Chat Completions API (/v1/chat/completions),
// the surface most coding agents (Cursor, aider, Cline, Continue) speak, and
// what freellmapi and most free-tier routers expose natively.

export const path = '/v1/chat/completions';

/**
 * OpenAI-compatible providers signal quota exhaustion with 429 (rate limit
 * or insufficient_quota) or occasionally 402. We treat both as safe to fail
 * over on since no tokens were billed for a non-2xx response.
 */
export function isQuotaError(status, bodyJson) {
  if (status === 429 || status === 402) return true;
  const code = bodyJson?.error?.code || bodyJson?.error?.type;
  if (status >= 400 && (code === 'insufficient_quota' || code === 'rate_limit_exceeded')) return true;
  return false;
}

export function buildHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    accept: 'text/event-stream, application/json',
  };
}

/** Non-streaming response usage: { usage: { prompt_tokens, completion_tokens } }. */
export function extractUsage(bodyJson) {
  const usage = bodyJson?.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

/**
 * Streaming usage only appears if the client requested
 * stream_options: { include_usage: true }, in the final chunk before [DONE].
 */
export function parseSSEChunkForUsage(_eventName, dataJson) {
  const usage = dataJson?.usage;
  if (!usage) return null;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}
