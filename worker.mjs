// Anyone may add images. Tag changes require a TagBox account; a tag may only be
// edited or removed by the account that added it (admins can edit any tag).
const MAX = 14 * 1024 * 1024;
const DEFAULT_ITERATIONS = 100000;
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
  let s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function b64urlToBytes(text) {
  let s = String(text).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
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
async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64urlToBytes(salt), iterations, hash: 'SHA-256' }, key, 256);
  return b64url(bits);
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
function checkCredentials(username, password) {
  if (!/^[A-Za-z0-9_-]{3,24}$/.test(username)) throw fail('아이디는 영문·숫자·_·- 3~24자로 입력해주세요.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 100) throw fail('비밀번호는 8~100자로 입력해주세요.');
}
async function makeSession(env, user) {
  const adm = Boolean(user.admin) || adminLogins(env).includes(String(user.username).toLowerCase());
  const login = user.nickname || user.display;
  const token = await signToken({ uid: String(user.id), login, adm, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 }, env.SESSION_SECRET);
  return { token, uid: String(user.id), login, adm };
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
    try {
      if (url.pathname === '/auth/register' || url.pathname === '/auth/login') {
        if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
        if (!env.SESSION_SECRET) throw fail('로그인 설정이 아직 완료되지 않았습니다.', 503);
        if (!env.DB) throw fail('계정 저장소가 설정되지 않았습니다.', 503);
        const input = await bodyJSON(request);
        const display = String(input.username || '').trim();
        const password = String(input.password || '');
        const nickname = String(input.nickname || '').trim();
        checkCredentials(display, password);
        const username = display.toLowerCase();
        if (url.pathname === '/auth/register') {
          if (!env.SIGNUP_CODE) throw fail('회원가입이 잠겨 있습니다.', 403);
          if (!safeEqual(String(input.code || ''), String(env.SIGNUP_CODE))) throw fail('가입 코드가 올바르지 않습니다.', 403);
          if (!nickname || nickname.length > 20 || /[\r\n<>]/.test(nickname)) throw fail('닉네임은 1~20자로 입력해주세요. (채팅에 표시됩니다)');
          const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
          if (existing) throw fail('이미 사용 중인 아이디입니다.', 409);
          const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
          const admin = Number(total && total.n) === 0 ? 1 : 0;
          const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
          const iterations = Number(env.PBKDF2_ITERATIONS) || DEFAULT_ITERATIONS;
          const hash = await hashPassword(password, salt, iterations);
          const inserted = await env.DB.prepare(
            'INSERT INTO users (username, display, nickname, salt, hash, iterations, admin, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(username, display, nickname, salt, hash, iterations, admin, Date.now()).run();
          return reply(await makeSession(env, { id: inserted.meta.last_row_id, display, nickname, username, admin }));
        }
        const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
        if (!user) throw fail('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
        const hash = await hashPassword(password, user.salt, Number(user.iterations) || DEFAULT_ITERATIONS);
        if (!safeEqual(hash, user.hash)) throw fail('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
        return reply(await makeSession(env, user));
      }
      if (url.pathname === '/auth/me') {
        const session = await readToken(request, env);
        if (!session) throw fail('로그인이 필요합니다.', 401);
        return reply({ uid: session.uid, login: session.login, adm: Boolean(session.adm) });
      }
      if (url.pathname === '/auth/nickname') {
        if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
        if (!env.DB) throw fail('계정 저장소가 설정되지 않았습니다.', 503);
        const session = await readToken(request, env);
        if (!session) throw fail('로그인이 필요합니다.', 401);
        const input = await bodyJSON(request);
        const nickname = String(input.nickname || '').trim();
        if (!nickname || nickname.length > 20 || /[\r\n<>]/.test(nickname)) throw fail('닉네임은 1~20자로 입력해주세요.');
        await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(nickname, Number(session.uid)).run();
        const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(session.uid)).first();
        if (!user) throw fail('계정을 찾지 못했습니다.', 404);
        return reply(await makeSession(env, user));
      }

      if (url.pathname === '/api/storage') {
        if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
        if (!env.GITHUB_TOKEN) throw fail('저장 서버 설정이 아직 완료되지 않았습니다.', 503);
        const repo = env.GITHUB_REPO || 'tag-box/tagbox';
        const res = await fetch(`https://api.github.com/repos/${repo}`, {
          headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'TagBox', Accept: 'application/vnd.github+json' }
        });
        if (!res.ok) throw fail(`저장소 정보를 가져오지 못했습니다. (${res.status})`, res.status);
        const data = await res.json();
        const used = Number(data.size || 0) * 1024;
        const limit = 1024 * 1024 * 1024;
        return reply({ used, limit, percent: Math.min(100, (used / limit) * 100) });
      }

      if (url.pathname === '/api/chat') {
        if (!env.DB) throw fail('채팅 저장소가 설정되지 않았습니다.', 503);
        if (request.method === 'GET') {
          const after = Number(url.searchParams.get('after')) || 0;
          const rows = await env.DB.prepare(
            'SELECT m.id, COALESCE(u.nickname, m.login) AS login, m.body, m.created, COALESCE(u.admin, 0) AS adm FROM messages m LEFT JOIN users u ON u.id = CAST(m.uid AS INTEGER) WHERE m.id > ? ORDER BY m.id DESC LIMIT 60'
          ).bind(after).all();
          return reply((rows.results || []).reverse());
        }
        if (request.method === 'POST') {
          const session = await readToken(request, env);
          if (!session) throw fail('채팅을 보내려면 로그인이 필요합니다.', 401);
          const input = await bodyJSON(request);
          const body = String(input.body || '').trim();
          if (!body || body.length > 500) throw fail('메시지는 1~500자로 입력해주세요.');
          const last = await env.DB.prepare('SELECT created FROM messages WHERE uid = ? ORDER BY id DESC LIMIT 1').bind(session.uid).first();
          if (last && Date.now() - Number(last.created) < 2000) throw fail('너무 빨리 보냈습니다. 잠시 후 다시 시도해주세요.', 429);
          const created = Date.now();
          const inserted = await env.DB.prepare('INSERT INTO messages (uid, login, body, created) VALUES (?, ?, ?, ?)')
            .bind(session.uid, session.login, body, created).run();
          return reply({ id: inserted.meta.last_row_id, login: session.login, body, created });
        }
        return reply({ error: 'Method not allowed' }, 405);
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
        if (!session) throw fail('태그를 바꾸려면 로그인이 필요합니다.', 401);
      }
      if (request.method === 'DELETE') {
        session = await readToken(request, env);
        if (!session) throw fail('이미지를 삭제하려면 로그인이 필요합니다.', 401);
        if (!session.adm) throw fail('이미지 삭제는 관리자만 할 수 있습니다.', 403);
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
