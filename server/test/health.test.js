const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { after, before, test } = require('node:test');
const app = require('../index');

const server = createServer(app);
let baseUrl;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
}));

test('GET /api/v1/health returns the current UTC time without authentication', async () => {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);

  const body = await response.json();
  const finishedAt = Date.now();
  assert.deepEqual(body, { ok: true, time: new Date(body.time).toISOString() });

  const serverTime = Date.parse(body.time);
  assert.ok(serverTime >= startedAt && serverTime <= finishedAt);
});

test('GET /api/hello still returns the scaffold greeting', async () => {
  const response = await fetch(`${baseUrl}/api/hello`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { message: 'Xin chào từ server' });
});
