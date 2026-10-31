# TagBox Web

기존 TagBox의 이미지 추가, 태그 자동 저장·삭제, AND 검색, 인기 태그,
확대·축소·드래그, 이미지 삭제를 웹으로 옮긴 버전입니다. 회원 가입·승인은 없습니다.

## 지금 실행하기

`index.html`을 브라우저에서 여세요. 기본값은 **브라우저 체험 모드**입니다.
이미지는 IndexedDB에 저장되며 다른 기기에는 공유되지 않습니다.
브라우저 데이터를 지우면 체험 데이터도 삭제됩니다.

## GitHub Pages 올리기 (터미널 없이)

1. https://github.com/tag-box/tagbox 에서 **uploading an existing file** 또는 **Add file → Upload files**를 누릅니다.
2. `index.html`, `backend.js`, `config.js`, `README.md`를 저장소 최상위에 올리고 Commit changes를 누릅니다.
3. Settings → Pages → Build and deployment에서 **Deploy from a branch**, `main`, `/(root)`를 선택하고 Save 합니다.
4. 배포가 완료되면 https://tag-box.github.io/tagbox/ 에서 열 수 있습니다.

화면만 배포하면 계속 브라우저 체험 모드입니다. 공동 저장은 아래 서버 연결까지 필요합니다.
원하면 동봉한 `.github/workflows/pages.yml`로 GitHub Actions 배포도 가능합니다.

## 누구나 GitHub에 업로드하도록 연결하기

GitHub Pages는 서버 코드를 실행할 수 없으므로 작은 Cloudflare Worker가 업로드 요청을 받습니다.
이미지와 태그는 `tag-box/tagbox` 저장소의 `library/`에 저장됩니다. Supabase는 사용하지 않습니다.

1. GitHub에서 이 저장소만 대상으로 하는 fine-grained token을 만들고 **Contents: Read and write**만 허용합니다.
2. Cloudflare Workers에서 Worker를 만들고 `worker.mjs` 전체를 코드 편집기에 넣어 배포합니다.
3. Worker Settings의 Variables and Secrets에 `GITHUB_TOKEN`을 **Secret**으로 등록합니다.
   일반 변수 `GITHUB_REPO=tag-box/tagbox`, `GITHUB_BRANCH=main`, `SITE_ORIGIN=https://tag-box.github.io`를 설정합니다.
4. `config.js`의 `apiUrl`에 Worker 주소(예: `https://tagbox-storage.계정.workers.dev`)를 넣고 GitHub에 저장합니다.
5. 페이지를 새로고침하고 **공동 라이브러리** 표시를 확인합니다. 다른 브라우저에서도 같은 이미지가 보이면 연결 완료입니다.

토큰을 GitHub 파일·채팅·브라우저 코드에 넣지 마세요. 이 API는 사용자 요청대로 인증이 없으며,
누구나 이미지·태그를 추가·변경·삭제할 수 있습니다. 이미지당 10MB 제한을 적용합니다.
GitHub 기록에 이전 파일이 남으므로 사이트에서 삭제해도 저장소 전체 크기가 즉시 줄지 않습니다.
GitHub API와 Worker 사용량 제한이 적용됩니다.

## 이미지 품질

현재는 글씨·선 보존을 위해 원본을 그대로 저장합니다. PNG, JPEG, WebP, GIF, AVIF를 지원합니다.
무손실 WebP 자동 최적화는 아직 포함되지 않았습니다. 목록은 지연 로딩을 사용합니다.

## 확인

Node.js에서 `node --test worker.test.mjs`로 API 입력 검증을 확인할 수 있습니다.
실제 GitHub 저장 및 배포는 계정 연결 후 별도 확인이 필요합니다.
