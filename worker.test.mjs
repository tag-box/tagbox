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
