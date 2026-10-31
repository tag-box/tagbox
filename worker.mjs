// Anyone may add images. Tag changes require GitHub login; a tag may only be edited
// or removed by the GitHub account that added it (admins can edit any tag).
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

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = text => b64url(new TextEncoder().encode(text));
function fromB64url(text) {
  let s = text.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
async function signToken(payload, secret) {
  const body = b64urlText(JSON.stringify(payload));
  return `${body}.${await hmac(secret, body)}`;
}
async function readToken(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !env.SESSION_SECRET) return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  if (!safeEqual(await hmac(env.SESSION_SECRET, body), signature)) return null;
  try {
    const payload = JSON.parse(fromB64url(body));
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function adminLogins(env) {
  return String(env.ADMIN_LOGINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}
function ownedTags(tags, owners) {
  const out = {};
  for (const t of tags) {
    if (owners && Object.prototype.hasOwnProperty.call(owners, t)) {
      const o = owners[t];
      if (typeof o === 'string' && /^[0-9]{1,20}$/.test(o)) out[t] = o;
    }
  }
  return out;
}

export default {
  async fetch(request, env) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': env.SITE_ORIGIN || 'https://tag-box.github.io',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin' };
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    const callbackUrl = env.CALLBACK_URL || `${url.origin}/auth/callback`;
    try {
      if (url.pathname === '/auth/login') {
        if (!env.OAUTH_CLIENT_ID || !env.SESSION_SECRET) throw fail('로그인 설정이 아직 완료되지 않았습니다.', 503);
        const state = await signToken({ k: 'state', n: crypto.randomUUID(), exp: Date.now() + 10 * 60 * 1000 }, env.SESSION_SECRET);
        const target = new URL('https://github.com/login/oauth/authorize');
        target.searchParams.set('client_id', env.OAUTH_CLIENT_ID);
        target.searchParams.set('redirect_uri', callbackUrl);
        target.searchParams.set('scope', 'read:user');
        target.searchParams.set('state', state);
        return Response.redirect(target.toString(), 302);
      }
      if (url.pathname === '/auth/callback') {
        if (!env.OAUTH_CLIENT_ID || !env.OAUTH_CLIENT_SECRET || !env.SESSION_SECRET) throw fail('로그인 설정이 아직 완료되지 않았습니다.', 503);
        const state = url.searchParams.get('state') || '';
        const [stateBody, stateSig] = state.split('.');
        const validState = stateBody && stateSig &&
          safeEqual(await hmac(env.SESSION_SECRET, stateBody), stateSig) &&
          (() => { try { const p = JSON.parse(fromB64url(stateBody)); return p.k === 'state' && p.exp > Date.now(); } catch { return false; } })();
        if (!validState) throw fail('로그인 요청이 만료되었습니다. 다시 시도해주세요.', 400);
        const code = url.searchParams.get('code');
        if (!code) throw fail('GitHub 승인이 취소되었습니다.', 400);
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: env.OAUTH_CLIENT_ID, client_secret: env.OAUTH_CLIENT_SECRET, code, redirect_uri: callbackUrl })
        });
        const tokenData = await tokenRes.json().catch(() => ({}));
        if (!tokenData.access_token) throw fail('GitHub 로그인에 실패했습니다.', 401);
        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'TagBox', Accept: 'application/vnd.github+json' }
        });
        const user = await userRes.json().catch(() => ({}));
        if (!user || !user.id) throw fail('GitHub 사용자 정보를 가져오지 못했습니다.', 401);
        const adm = adminLogins(env).includes(String(user.login).toLowerCase());
        const session = await signToken({ uid: String(user.id), login: user.login, adm, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, env.SESSION_SECRET);
        return Response.redirect(`${env.SITE_URL || 'https://tag-box.github.io/tagbox/'}#auth=${session}`, 302);
      }

      if (url.pathname !== '/api/images') return reply({ error: 'Not found' }, 404);
      if (!['GET','POST','PATCH','DELETE'].includes(request.method)) return reply({ error: 'Method not allowed' }, 405);
      if (!env.GITHUB_TOKEN) throw fail('GitHub 저장 서버 설정이 아직 완료되지 않았습니다.', 503);
      const repo = env.GITHUB_REPO || 'tag-box/tagbox';
      const branch = env.GITHUB_BRANCH || 'main';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw fail('저장소 설정 오류', 503);
      const gh = async (path, method = 'GET', data) => {
        const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
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
      let newItem, blob, session;
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
        newItem = { id: input.id, name: input.name.trim(), tags: [], owners: {}, created: Date.now(), fileName: `library/images/${input.id}.${types[input.type]}` };
        blob = await gh('git/blobs', 'POST', { content: input.base64, encoding: 'base64' });
      }
      if (request.method === 'PATCH') {
        if (!Array.isArray(input.tags) || input.tags.length > 100 || input.tags.some(t => typeof t !== 'string' || t.length > 100)) throw fail('태그는 100개 이하, 각 100자 이하로 입력해주세요.');
        session = await readToken(request, env);
        if (!session) throw fail('태그를 바꾸려면 GitHub 로그인이 필요합니다.', 401);
      }
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
          if (request.method === 'PATCH') {
            const uid = String(session.uid);
            const adm = Boolean(session.adm);
            const next = [...new Set(input.tags.map(t => t.trim()).filter(Boolean))];
            const prev = Array.isArray(item.tags) ? item.tags : [];
            const owners = ownedTags(prev, item.owners);
            for (const t of prev) {
              if (!next.includes(t) && owners[t] !== uid && !adm) {
                throw fail('다른 사람이 추가한 태그는 수정하거나 삭제할 수 없습니다.', 403);
              }
            }
            const nextOwners = {};
            for (const t of next) {
              if (prev.includes(t)) { if (owners[t]) nextOwners[t] = owners[t]; }
              else nextOwners[t] = uid;
            }
            item.tags = next;
            item.owners = nextOwners;
          } else {
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
