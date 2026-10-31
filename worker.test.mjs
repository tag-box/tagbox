import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';
const env = { GITHUB_TOKEN: 'test-only' };
const req = (method, body) => new Request('https://example.test/api/images', { method, body: body && JSON.stringify(body) });
test('missing server credentials never pretend to save', async () => {
  const res = await worker.fetch(req('GET'), {});
  assert.equal(res.status, 503);
});
test('invalid IDs and invalid file bytes are rejected before GitHub calls', async () => {
  assert.equal((await worker.fetch(req('DELETE', { id: '../index.html' }), env)).status, 400);
  assert.equal((await worker.fetch(req('POST', { id: '00000000-0000-4000-8000-000000000000', type: 'image/png', base64: btoa('<script>bad</script>'), name: 'bad' }), env)).status, 400);
});
test('GitHub read failure is not shown as an empty successful library', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{}', { status: 403 });
    assert.equal((await worker.fetch(req('GET'), env)).status, 403);
  } finally { globalThis.fetch = original; }
});
test('concurrent branch update retries using latest records, commits image and index together', async () => {
  const original = globalThis.fetch;
  let refs = 0, updates = 0; const indexes = [], trees = [];
  const existing = { id: '11111111-1111-4111-8111-111111111111', name: '다른 사용자', tags: [], fileName: 'library/images/other.png' };
  try {
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname.replace('/repos/tag-box/tagbox/', '');
      const body = options.body ? JSON.parse(options.body) : null;
      let out = {};
      if (path === 'git/ref/heads/main') out = { object: { sha: 'parent' + (++refs) } };
      else if (path.startsWith('git/commits/')) out = { tree: { sha: 'base' } };
      else if (path === 'contents/library/index.json') out = { content: Buffer.from(JSON.stringify(refs > 1 ? [existing] : [])).toString('base64') };
      else if (path === 'git/blobs') {
        const decoded = Buffer.from(body.content, 'base64').toString();
        if (decoded.startsWith('[')) indexes.push(JSON.parse(decoded));
        out = { sha: 'blob' };
      } else if (path === 'git/trees') { trees.push(body); out = { sha: 'tree' }; }
      else if (path === 'git/commits') out = { sha: 'newcommit' };
      else if (path === 'git/refs/heads/main') {
        assert.equal(body.force, false);
        if (++updates === 1) return new Response('{}', { status: 422 });
      } else throw new Error('Unexpected endpoint ' + path);
      return Response.json(out);
    };
    const result = await worker.fetch(req('POST', { id: '00000000-0000-4000-8000-000000000000', type: 'image/png', base64: btoa('\x89PNG\r\n\x1a\n'), name: '새 이미지' }), env);
    assert.equal(result.status, 200);
    assert.equal(updates, 2);
    assert.equal(indexes[1].length, 2);
    assert.equal(indexes[1][1].name, existing.name);
    assert.equal(trees[1].tree.length, 2);
    assert.match((await result.json()).path, /newcommit/);
  } finally { globalThis.fetch = original; }
});

const b64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hmac = async (secret, data) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
};
const tokenFor = async payload => {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac('test-secret', body)}`;
};
const authReq = (method, body, token) => new Request('https://example.test/api/images', {
  method,
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: body && JSON.stringify(body)
});

test('tag changes require login and only the owner may remove a tag', async () => {
  const original = globalThis.fetch;
  const item = { id: '11111111-1111-4111-8111-111111111111', name: 'x', tags: ['a', 'b'], owners: { a: '111', b: '222' }, fileName: 'library/images/x.webp', created: 1 };
  const written = [];
  const envAuth = { GITHUB_TOKEN: 'test-only', SESSION_SECRET: 'test-secret' };
  try {
    globalThis.fetch = async (url, options) => {
      const path = new URL(url).pathname.replace('/repos/tag-box/tagbox/', '');
      const body = options.body ? JSON.parse(options.body) : null;
      if (path === 'git/ref/heads/main') return Response.json({ object: { sha: 'parent' } });
      if (path.startsWith('git/commits/')) return Response.json({ tree: { sha: 'base' } });
      if (path === 'contents/library/index.json') return Response.json({ content: Buffer.from(JSON.stringify([item])).toString('base64') });
      if (path === 'git/blobs') { const decoded = Buffer.from(body.content, 'base64').toString(); if (decoded.startsWith('[')) written.push(JSON.parse(decoded)); return Response.json({ sha: 'blob' }); }
      if (path === 'git/trees') return Response.json({ sha: 'tree' });
      if (path === 'git/commits') return Response.json({ sha: 'newcommit' });
      if (path === 'git/refs/heads/main') return Response.json({ ok: true });
      throw new Error('Unexpected endpoint ' + path);
    };
    const id = item.id;
    const alice = await tokenFor({ uid: '111', login: 'alice', adm: false, exp: Date.now() + 60000 });
    const admin = await tokenFor({ uid: '999', login: 'boss', adm: true, exp: Date.now() + 60000 });
    assert.equal((await worker.fetch(authReq('PATCH', { id, tags: ['b'] }), envAuth)).status, 401);
    assert.equal((await worker.fetch(authReq('PATCH', { id, tags: ['b'] }, alice), envAuth)).status, 200);
    assert.deepEqual(written.at(-1)[0].tags, ['b']);
    assert.deepEqual(written.at(-1)[0].owners, { b: '222' });
    assert.equal((await worker.fetch(authReq('PATCH', { id, tags: ['a'] }, alice), envAuth)).status, 403);
    assert.equal((await worker.fetch(authReq('PATCH', { id, tags: ['a'] }, admin), envAuth)).status, 200);
    assert.deepEqual(written.at(-1)[0].owners, { a: '111' });
  } finally { globalThis.fetch = original; }
});

test('expired or forged sessions are rejected', async () => {
  const envAuth = { GITHUB_TOKEN: 'test-only', SESSION_SECRET: 'test-secret' };
  const expired = await tokenFor({ uid: '111', login: 'alice', adm: false, exp: Date.now() - 1000 });
  const res = await worker.fetch(authReq('PATCH', { id: '11111111-1111-4111-8111-111111111111', tags: [] }, expired), envAuth);
  assert.equal(res.status, 401);
  const forged = (await tokenFor({ uid: '111', login: 'alice', adm: true, exp: Date.now() + 60000 })).replace(/\.[^.]+$/, '.bad');
  assert.equal((await worker.fetch(authReq('PATCH', { id: '11111111-1111-4111-8111-111111111111', tags: [] }, forged), envAuth)).status, 401);
});
