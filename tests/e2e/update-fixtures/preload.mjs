// Test-only transport and clock seam. Production CLI has no fixture/server flags.
// Loaded explicitly with node --import by the journey harness, never installed.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const path = process.env.TRACER_E2E_UPDATE_FIXTURE;
if (!path) throw new Error('Update journey preload requires its isolated fixture.');
const fixture = () => JSON.parse(readFileSync(path, 'utf8'));
const API = 'https://api.github.com/repos/pcopu/tracerCLI';
const originalFetch = globalThis.fetch;
const now = fixture().now;
if (now !== undefined) Date.now = () => now;
globalThis.fetch = async (url, init) => {
  assert.equal(typeof url, 'string');
  assert.ok(url.startsWith(`${API}/`), `Unexpected external request: ${url}`);
  assert.equal(init.method, 'GET');
  assert.equal(init.redirect, 'error');
  assert.equal(init.credentials, 'omit');
  assert.equal(Object.keys(init.headers).some(key => key.toLowerCase() === 'authorization'), false);
  appendFileSync(`${path}.requests`, `${JSON.stringify({ url, method: init.method })}\n`);
  const data = fixture();
  if (data.networkError) throw new Error(data.networkError);
  const body = data.routes[url.slice(API.length)];
  const status = data.httpStatus ?? (body === undefined ? 404 : 200);
  const bytes = JSON.stringify(body ?? {});
  let response;
  if (data.transport === 'http') {
    // Each child owns its loopback server, avoiding a parent spawnSync/server deadlock.
    const server = createServer((_request, reply) => {
      reply.writeHead(status, { 'Content-Type': 'application/json' });
      reply.write(bytes.slice(0, 10)); reply.end(bytes.slice(10));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const local = await originalFetch(`http://127.0.0.1:${server.address().port}/fixture`, init);
      const body = await local.text();
      // Exercise the production streaming reader using an actual HTTP response's bytes.
      response = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(body.slice(0, 10)));
        controller.enqueue(Buffer.from(body.slice(10))); controller.close();
      } }), { status, headers: local.headers });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  } else {
    response = new Response(bytes, { status, headers: { 'Content-Type': 'application/json' } });
  }
  if (data.foreignURL) Object.defineProperty(response, 'url', { value: data.foreignURL });
  return response;
};
