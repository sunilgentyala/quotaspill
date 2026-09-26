import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { loadConfig } from '../src/config.js';

const TMP_PATH = '.test-config.json';

function writeTmpConfig(obj) {
  writeFileSync(TMP_PATH, JSON.stringify(obj));
}

test('loadConfig resolves env: references to environment variables', () => {
  process.env.QS_TEST_KEY = 'secret-value-123';
  writeTmpConfig({
    chains: {
      anthropic: [
        { name: 'p', kind: 'primary', baseUrl: 'http://x', apiKey: 'env:QS_TEST_KEY' },
      ],
    },
  });

  const config = loadConfig(TMP_PATH);
  assert.equal(config.chains.anthropic[0].apiKey, 'secret-value-123');

  delete process.env.QS_TEST_KEY;
  unlinkSync(TMP_PATH);
});

test('loadConfig throws when an env: reference is unset', () => {
  writeTmpConfig({
    chains: {
      anthropic: [
        { name: 'p', kind: 'primary', baseUrl: 'http://x', apiKey: 'env:QS_DOES_NOT_EXIST' },
      ],
    },
  });

  assert.throws(() => loadConfig(TMP_PATH), /QS_DOES_NOT_EXIST/);
  unlinkSync(TMP_PATH);
});

test('loadConfig throws when a chain has zero or multiple primaries', () => {
  writeTmpConfig({
    chains: {
      anthropic: [
        { name: 'a', kind: 'fallback', baseUrl: 'http://x', apiKey: 'k' },
        { name: 'b', kind: 'fallback', baseUrl: 'http://y', apiKey: 'k' },
      ],
    },
  });
  assert.throws(() => loadConfig(TMP_PATH), /exactly one provider with kind "primary"/);
  unlinkSync(TMP_PATH);
});

test('loadConfig throws a clear error when the file is missing', () => {
  assert.throws(() => loadConfig('.does-not-exist.json'), /Config file not found/);
});
