const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.GALLERY_PASSWORD = 'test-password';
const app = require('./index');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const login = (password) =>
  fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

const sessionCookie = (response) => response.headers.get('set-cookie').split(';')[0];

const signed = (expires, key = 'test-password') =>
  `gallery_session=${expires}.${crypto.createHmac('sha256', key).update(String(expires)).digest('hex')}`;

test('protected endpoints reject requests without a session', async () => {
  for (const [method, path] of [
    ['GET', '/api/photos'],
    ['GET', '/api/photos/1'],
    ['DELETE', '/api/photos/1'],
    ['DELETE', '/api/photos'],
  ]) {
    const response = await fetch(base + path, { method });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});

test('login fails with a wrong or missing password', async () => {
  assert.equal((await login('nope')).status, 401);
  assert.equal((await login(undefined)).status, 401);
});

test('login sets an HttpOnly, SameSite=Strict cookie that opens the gallery', async () => {
  const response = await login('test-password');
  assert.equal(response.status, 204);
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);

  const listing = await fetch(`${base}/api/photos`, {
    headers: { cookie: sessionCookie(response) },
  });
  assert.equal(listing.status, 200);
});

test('tampered, expired or foreign-key cookies are rejected', async () => {
  const future = Date.now() + 60_000;
  for (const cookie of [
    `gallery_session=${future}.deadbeef`,
    signed(Date.now() - 1000),
    signed(future, 'other-password'),
  ]) {
    const response = await fetch(`${base}/api/photos`, { headers: { cookie } });
    assert.equal(response.status, 401, cookie);
  }
});

test('uploading evidence does not require a session', async () => {
  const response = await fetch(`${base}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: 'not-an-image' }),
  });
  assert.equal(response.status, 400); // validated, not 401
});

test('logout clears the cookie', async () => {
  const response = await fetch(`${base}/api/session`, { method: 'DELETE' });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /gallery_session=;/);
});
