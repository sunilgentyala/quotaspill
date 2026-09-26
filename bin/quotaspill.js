#!/usr/bin/env node
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const command = process.argv[2] || 'start';

if (command !== 'start') {
  console.error(`Unknown command "${command}". Usage: quotaspill start [--config path.json]`);
  process.exit(1);
}

const configFlagIndex = process.argv.indexOf('--config');
const configPath = configFlagIndex !== -1 ? process.argv[configFlagIndex + 1] : undefined;

let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  console.error(`QuotaSpill config error: ${err.message}`);
  process.exit(1);
}

const server = createServer(config);
server.listen(config.port, () => {
  console.log(`QuotaSpill listening on http://localhost:${config.port}`);
  for (const [chainName, providers] of Object.entries(config.chains)) {
    const primary = providers.find((p) => p.kind === 'primary');
    const fallbacks = providers.filter((p) => p.kind === 'fallback').map((p) => p.name);
    console.log(`  ${chainName}: primary=${primary.name} -> fallback(s)=[${fallbacks.join(', ')}]`);
  }
  console.log(`Dashboard: http://localhost:${config.port}/`);
});
