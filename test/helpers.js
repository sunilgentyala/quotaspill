import { createServer } from 'node:http';

/**
 * Starts a throwaway HTTP server that responds according to `handler`.
 * Returns { url, close }. Used to stand in for "the real provider" and
 * "the fallback provider" in tests without hitting the network.
 */
export function startMockProvider(handler) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export function jsonHandler(status, body) {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}
