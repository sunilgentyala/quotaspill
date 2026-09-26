import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function currentMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function emptyChainStats() {
  return {
    month: currentMonth(),
    monthRequests: 0,
    allTime: {
      requests: 0,
      bySource: {}, // sourceName -> count
      inputTokens: 0,
      outputTokens: 0,
      primaryInputTokens: 0,
      primaryOutputTokens: 0,
      fallbackInputTokens: 0,
      fallbackOutputTokens: 0,
    },
  };
}

export function loadStats(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveStats(path, stats) {
  writeFileSync(path, JSON.stringify(stats, null, 2));
}

/**
 * Rolls monthRequests over to 0 when the calendar month changes, so a
 * monthlyRequestCap budget check is comparing against the right window.
 */
export function ensureChain(stats, chainName) {
  if (!stats[chainName]) {
    stats[chainName] = emptyChainStats();
  }
  const chain = stats[chainName];
  const month = currentMonth();
  if (chain.month !== month) {
    chain.month = month;
    chain.monthRequests = 0;
  }
  return chain;
}

/**
 * @param {string} sourceKind - "primary" or "fallback"
 * @param {string} sourceName - the provider's configured name
 * @param {{inputTokens:number, outputTokens:number}|null} usage
 */
export function recordRequest(stats, chainName, sourceKind, sourceName, usage) {
  const chain = ensureChain(stats, chainName);
  chain.monthRequests += 1;
  chain.allTime.requests += 1;
  chain.allTime.bySource[sourceName] = (chain.allTime.bySource[sourceName] || 0) + 1;

  if (usage) {
    chain.allTime.inputTokens += usage.inputTokens || 0;
    chain.allTime.outputTokens += usage.outputTokens || 0;
    if (sourceKind === 'primary') {
      chain.allTime.primaryInputTokens += usage.inputTokens || 0;
      chain.allTime.primaryOutputTokens += usage.outputTokens || 0;
    } else {
      chain.allTime.fallbackInputTokens += usage.inputTokens || 0;
      chain.allTime.fallbackOutputTokens += usage.outputTokens || 0;
    }
  }
  return chain;
}

/**
 * Estimated dollars saved: fallback requests were served free, so we price
 * their tokens at the primary's configured rate to show what they *would*
 * have cost had the primary served them.
 */
export function estimateSavings(chain, pricing) {
  if (!pricing || (!pricing.inputPer1M && !pricing.outputPer1M)) return null;
  const inCost = (chain.allTime.fallbackInputTokens / 1_000_000) * (pricing.inputPer1M || 0);
  const outCost = (chain.allTime.fallbackOutputTokens / 1_000_000) * (pricing.outputPer1M || 0);
  return Number((inCost + outCost).toFixed(4));
}
