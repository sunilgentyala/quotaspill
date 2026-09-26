import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_CONFIG = {
  port: 8787,
  statsFile: '.quotaspill-stats.json',
  chains: {},
  pricing: {},
};

/**
 * Resolves an "env:VAR_NAME" string to the value of process.env.VAR_NAME.
 * Plain strings (not prefixed with "env:") are returned as-is, so a config
 * file can also hold a literal key directly if the user prefers that.
 */
function resolveSecret(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    const varName = value.slice(4);
    const resolved = process.env[varName];
    if (!resolved) {
      throw new Error(`Config references env:${varName} but that environment variable is not set`);
    }
    return resolved;
  }
  return value;
}

function validateProvider(provider, chainName, index) {
  const label = `chains.${chainName}[${index}]`;
  if (!provider.name) throw new Error(`${label}.name is required`);
  if (!provider.baseUrl) throw new Error(`${label}.baseUrl is required`);
  if (!provider.apiKey) throw new Error(`${label}.apiKey is required`);
  if (!['primary', 'fallback'].includes(provider.kind)) {
    throw new Error(`${label}.kind must be "primary" or "fallback"`);
  }
}

export function loadConfig(path = process.env.QUOTASPILL_CONFIG || 'quotaspill.config.json') {
  const fullPath = resolve(process.cwd(), path);
  if (!existsSync(fullPath)) {
    throw new Error(
      `Config file not found at ${fullPath}. Copy quotaspill.config.example.json to ${path} and fill in your providers.`
    );
  }

  const raw = JSON.parse(readFileSync(fullPath, 'utf8'));
  const config = { ...DEFAULT_CONFIG, ...raw };

  for (const [chainName, providers] of Object.entries(config.chains || {})) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error(`chains.${chainName} must be a non-empty array`);
    }
    providers.forEach((p, i) => validateProvider(p, chainName, i));
    const primaries = providers.filter((p) => p.kind === 'primary');
    if (primaries.length !== 1) {
      throw new Error(`chains.${chainName} must have exactly one provider with kind "primary"`);
    }

    for (const provider of providers) {
      provider.apiKey = resolveSecret(provider.apiKey);
    }
  }

  return config;
}

export { DEFAULT_CONFIG };
