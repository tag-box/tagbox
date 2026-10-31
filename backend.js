(() => {
  const endpoint = (window.TAGBOX_CONFIG.apiUrl || '').replace(/\/$/, '');
  let database;
  const ready = new Promise((resolve, reject) => {
    if (endpoint) return resolve();
    const request = indexedDB.open('tagbox-web', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
    request.onsuccess = () => { database = request.result; resolve(); };
    request.onerror = () => reject(request.error);
  });
  async function local(mode, action) {
    await ready;
    return new Promise((resolve, reject) => {
      const tx = database.transaction('images', mode);
      const request = action(tx.objectStore('images'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('저장 취소됨'));
    });
  }
  async function remote(method, body, path = '/api/images') {
    const headers = { 'Content-Type': 'application/json' };
    let token = '';
    try { token = localStorage.getItem('tagbox-token') || ''; } catch {}
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(endpoint + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '서버 요청 실패');
    return data;
  }
  window.tagboxAPI = {
    async loadData() {
      return endpoint ? remote('GET') : (await local('readonly', s => s.getAll())).sort((a,b) => b.created - a.created);
    },
    async saveImage(input) {
      if (input.base64.length > 14 * 1024 * 1024) throw new Error('이미지는 한 장당 10MB 이하로 올려주세요.');
      if (endpoint) return remote('POST', input);
      const item = { id: input.id, name: input.name, tags: [], created: Date.now(), fileName: input.id,
        path: `data:${input.type};base64,${input.base64}` };
      await local('readwrite', s => s.put(item));
      return item;
    },
    async saveTags(id, tags) {
      if (endpoint) return remote('PATCH', { id, tags });
      const item = await local('readonly', s => s.get(id));
      if (!item) return false;
      item.tags = tags;
      await local('readwrite', s => s.put(item));
      return true;
    },
    async login(username, password) {
      if (!endpoint) throw new Error('로그인은 공동 라이브러리에서만 사용할 수 있습니다.');
      return remote('POST', { username, password }, '/auth/login');
    },
    async register(username, password, code) {
      if (!endpoint) throw new Error('회원가입은 공동 라이브러리에서만 사용할 수 있습니다.');
      return remote('POST', { username, password, code }, '/auth/register');
    },
    async deleteImage(id) {
      if (endpoint) return remote('DELETE', { id });
      await local('readwrite', s => s.delete(id)); return true;
    }
  };
  window.tagboxShared = Boolean(endpoint);
})();
