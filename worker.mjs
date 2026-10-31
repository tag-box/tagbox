// Public API: anyone may add, edit and delete. Credentials remain in Worker secrets.
const MAX = 14 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
function encoded(text) {
  const bytes = new TextEncoder().encode(text);
  let s = ''; for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}
async function bodyJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw fail('요청 내용이 없습니다.');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > MAX) { await reader.cancel(); throw fail('한 장당 10MB 이하로 올려주세요.', 413); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { all.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder().decode(all)); } catch { throw fail('잘못된 JSON 요청입니다.'); }
}
export default {
  async fetch(request, env) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.SITE_ORIGIN || 'https://tag-box.github.io',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      if (new URL(request.url).pathname !== '/api/images') return reply({ error: 'Not found' }, 404);
      if (!['GET','POST','PATCH','DELETE'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405);
      if (!env.GITHUB_TOKEN) throw fail('GitHub 저장 서버 설정이 아직 완료되지 않았습니다.', 503);
      const repo = env.GITHUB_REPO || 'tag-box/tagbox';
      const branch = env.GITHUB_BRANCH || 'main';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail('저장소 설정 오류', 503);
      const gh = async (url, method = 'GET', data) => {
        const res = await fetch(`https://api.github.com/repos/${repo}/${url}`, {
          method, headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'TagBox',
            Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
          body: data ? JSON.stringify(data) : undefined
        });
        if (!res.ok) throw fail(`GitHub 저장 요청 실패 (${res.status}). 저장소 설정이나 사용량을 확인해주세요.`, res.status);
        return res.json();
      };
      const read = async ref => {
        try {
          const file = await gh(`contents/library/index.json?ref=${encodeURIComponent(ref)}`);
          const items = JSON.parse(decode(file.content));
          if (!Array.isArray(items)) throw fail('저장 목록 형식이 올바르지 않습니다.', 500);
          return items;
        } catch (e) { if (e.status === 404) return []; throw e; }
      };
      const publicItem = (item, ref = branch) => ({ ...item,
        path: `https://raw.githubusercontent.com/${repo}/${ref}/${item.fileName}` });
      if (request.method === 'GET') return reply((await read(branch)).map(i => publicItem(i)));
      const input = await bodyJSON(request);
      if (!/^[0-9a-f-]{36}$/i.test(input.id || '')) throw fail('이미지 ID가 올바르지 않습니다.');
      let newItem, blob;
      if (request.method === 'POST') {
        const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
        if (!types[input.type] || typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw fail('지원하지 않는 이미지입니다.');
        let bytes; try { bytes = atob(input.base64); } catch { throw fail('이미지 데이터가 손상되었습니다.'); }
        if (bytes.length > 10 * 1024 * 1024) throw fail('한 장당 10MB 이하로 올려주세요.', 413);
        const valid = input.type === 'image/png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
          : input.type === 'image/jpeg' ? bytes.startsWith('\xff\xd8\xff')
          : input.type === 'image/webp' ? bytes.startsWith('RIFF') && bytes.slice(8,12) === 'WEBP'
          : input.type === 'image/gif' ? /^GIF8[79]a/.test(bytes)
          : bytes.slice(4,8) === 'ftyp' && /avif|avis/.test(bytes.slice(8,64));
        if (!valid) throw fail('파일 내용과 이미지 형식이 일치하지 않습니다.');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 300) throw fail('이미지 이름을 확인해주세요.');
        newItem = { id: input.id, name: input.name.trim(), tags: [], created: Date.now(), fileName: `library/images/${input.id}.${types[input.type]}` };
        blob = await gh('git/blobs', 'POST', { content: input.base64, encoding: 'base64' });
      }
      if (request.method === 'PATCH' && (!Array.isArray(input.tags) || input.tags.length > 100 || input.tags.some(t => typeof t !== 'string' || t.length > 100))) throw fail('태그는 100개 이하, 각 100자 이하로 입력해주세요.');
      // Compare-and-swap branch updates prevent concurrent edits losing records.
      for (let attempt = 0; attempt < 4; attempt++) {
        const ref = await gh(`git/ref/heads/${encodeURIComponent(branch)}`);
        const parent = ref.object.sha;
        const commit = await gh(`git/commits/${parent}`);
        let items = await read(parent);
        const item = items.find(i => i.id === input.id);
        const tree = [];
        if (newItem) {
          if (item) throw fail('이미 등록된 이미지입니다.', 409);
          items.unshift(newItem);
          tree.push({ path: newItem.fileName, mode: '100644', type: 'blob', sha: blob.sha });
        } else {
          if (!item) throw fail('이미지가 삭제되었거나 존재하지 않습니다.', 404);
          if (request.method === 'PATCH') item.tags = [...new Set(input.tags.map(t => t.trim()).filter(Boolean))];
          else {
            if (!/^library\/images\/[0-9a-f-]+\.(png|jpg|webp|gif|avif)$/i.test(item.fileName)) throw fail('이미지 경로 오류', 500);
            tree.push({ path: item.fileName, mode: '100644', type: 'blob', sha: null });
            items = items.filter(i => i.id !== input.id);
          }
        }
        const index = await gh('git/blobs', 'POST', { content: encoded(JSON.stringify(items)), encoding: 'base64' });
        tree.push({ path: 'library/index.json', mode: '100644', type: 'blob', sha: index.sha });
        const nextTree = await gh('git/trees', 'POST', { base_tree: commit.tree.sha, tree });
        const next = await gh('git/commits', 'POST', { message: `TagBox ${request.method.toLowerCase()} ${input.id}`, tree: nextTree.sha, parents: [parent] });
        try {
          await gh(`git/refs/heads/${encodeURIComponent(branch)}`, 'PATCH', { sha: next.sha, force: false });
          return reply(newItem ? publicItem(newItem, next.sha) : true);
        } catch (e) { if (![409,422].includes(e.status) || attempt === 3) throw e; }
      }
    } catch (error) {
      return reply({ error: error.status ? error.message : '저장 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' }, error.status >= 400 && error.status < 600 ? error.status : 500);
    }
  }
};
