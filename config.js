// Cloudflare Worker 배포 후 URL을 입력하면 GitHub 공동 저장 모드로 전환됩니다.
// 비어 있으면 현재 브라우저에만 저장하는 체험 모드입니다. 토큰은 넣지 마세요.
window.TAGBOX_CONFIG = {
  apiUrl: 'https://tagbox-storage.gloomybunnie.workers.dev'
};
