import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchPionexWorkflow } from '../src/github-dispatch.js';

const env = { GITHUB_DISPATCH_TOKEN: 'ghp_secret', GITHUB_REPOSITORY: 'owner/repo' };

test('dispatch: nothing is sent without the token and the repository', async () => {
  let called = false;
  assert.equal(await dispatchPionexWorkflow({}, async () => { called = true; }), null);
  assert.equal(called, false);
});

test('dispatch: asks GitHub to run the Pionex workflow on main, and the token only goes in the header', async () => {
  let seen;
  const result = await dispatchPionexWorkflow(env, async (url, init) => { seen = { url, init }; return new Response(null, { status: 204 }); });
  assert.equal(result.ok, true);
  assert.equal(seen.url, 'https://api.github.com/repos/owner/repo/actions/workflows/pionex-sync.yml/dispatches');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, '{"ref":"main"}');
  assert.equal(seen.init.headers.Authorization, 'Bearer ghp_secret');
  assert.ok(!seen.url.includes('ghp_secret'));
});

test('dispatch: a refusal names the status and never the token', async () => {
  const result = await dispatchPionexWorkflow(env, async () => new Response('{"message":"Bad credentials"}', { status: 401 }));
  assert.equal(result.ok, false);
  assert.match(result.message, /status 401/);
  assert.ok(!result.message.includes('ghp_secret'));
});

test('dispatch: a network failure is reported, not thrown', async () => {
  const result = await dispatchPionexWorkflow(env, async () => { throw new Error('offline'); });
  assert.equal(result.ok, false);
  assert.match(result.message, /offline/);
});
