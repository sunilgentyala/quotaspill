import { createServer as createHttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleProxyRequest } from './proxy.js';
import { loadStats, ensureChain, estimateSavings } from './stats.js';
import * as anthropicWire from './wire/anthropic.js';
import * as openaiWire from './wire/openai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');

const WIRES = {
  anthropic: { adapter: anthropicWire, routePath: anthropicWire.path },
  openai: { adapter: openaiWire, routePath: openaiWire.path },
};

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function buildStatsPayload(config, stats) {
  const chains = {};
  for (const chainName of Object.keys(config.chains)) {
    const chain = ensureChain(stats, chainName);
    const providers = config.chains[chainName];
    const primary = providers.find((p) => p.kind === 'primary');
    const cap = config.budget?.[chainName]?.monthlyRequestCap ?? null;
    chains[chainName] = {
      month: chain.month,
      monthRequests: chain.monthRequests,
      monthlyRequestCap: cap,
      capReached: cap != null && chain.monthRequests >= cap,
      allTime: chain.allTime,
      estimatedSavedUsd: estimateSavings(chain, config.pricing?.[chainName] || config.pricing?.primary),
      primaryName: primary?.name || null,
    };
  }
  return { chains, generatedAt: new Date().toISOString() };
}

/**
 * @param {object} config - result of loadConfig()
 * @param {object} [options]
 * @param {object} [options.stats] - inject an in-memory stats object (tests)
 * @param {string|null} [options.statsPath] - override persistence path, or null to disable
 */
export function createServer(config, options = {}) {
  const stats = options.stats ?? loadStats(config.statsFile);
  const statsPath = options.statsPath !== undefined ? options.statsPath : config.statsFile;

  return createHttpServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/stats') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(buildStatsPayload(config, stats)));
        return;
      }

      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (req.method === 'POST') {
        for (const [chainName, wire] of Object.entries(WIRES)) {
          if (req.url === wire.routePath && config.chains[chainName]) {
            const requestBody = await readJsonBody(req);
            await handleProxyRequest(
              {
                requestBody,
                requestHeaders: req.headers,
                chain: config.chains[chainName],
                wireAdapter: wire.adapter,
                chainName,
                budget: config.budget,
                stats,
                statsPath,
              },
              res
            );
            return;
          }
        }
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found. QuotaSpill serves /v1/messages and /v1/chat/completions.' } }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: { message: `QuotaSpill internal error: ${err.message}` } }));
    }
  });
}
