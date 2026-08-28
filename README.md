# 알뜰폰 사용량 위젯 (웹 + Scriptable)

원본 명세 문서(5개 알뜰폰 사업자 통합 조회 Android 앱)를 다음 구조로 재구성한 버전:

```
[사용자] → [웹 대시보드: 로그인 + 세션 관리 (server/)] → 서버가 30분마다 각 통신사 스크래핑
                                                              ↓
                                              StateStore(정제된 JSON, 중복 제거)
                                                              ↓
                                        Scriptable 위젯이 /api/usage 를 fetch만 함
```

- **로그인/세션 관리/스크래핑은 전부 서버가 담당**한다. Scriptable은 로그인 로직을 전혀 모르고,
  서버가 만들어둔 정제된 JSON을 받아 그리기만 한다.
- 아이디/비밀번호 로그인(아이즈모바일, 프리티, 티플러스)은 서버가 직접 폼을 POST한다.
- 소셜 로그인이 필요한 곳(알닷, 핀다이렉트)은 서버가 실제 브라우저(Playwright)를 띄우고
  화면을 웹 대시보드로 스트리밍한다. 대시보드 캔버스를 클릭/입력하면 그대로 서버 브라우저에
  전달되어, 사용자가 웹에서 실제 네이버/카카오 로그인을 완료할 수 있다. 로그인이 끝나면
  브라우저의 쿠키만 뽑아서 저장하고, 그 뒤로는 브라우저 없이 일반 HTTP 요청으로 조회한다.

## 폴더 구조

```
server/                 Node.js + TypeScript 백엔드
  src/carriers/          통신사 5개 어댑터 (원본 Kotlin 로직 이식)
  src/core/               HTTP 클라이언트, 쿠키 저장소, AES-GCM 암호화, 위젯 토큰 인증
  src/engine/             RefreshEngine(뮤텍스+세션갱신 규칙), StateStore, 중복 회선 제거
  src/browser/            aldot/pindirect용 원격 브라우저(Playwright) 로그인
  src/routes/             REST API + WebSocket
  web/                    로그인/상태 확인용 대시보드 (정적 HTML/JS)
scriptable/
  MVNO-Usage.js           iOS 홈 화면 위젯 스크립트
```

## 서버 실행

```bash
cd server
npm install                 # postinstall이 playwright chromium도 같이 설치함
cp .env.example .env
# .env에 MVNO_ENCRYPTION_KEY, MVNO_WIDGET_TOKEN 채우기 (각각 `openssl rand -hex 32`)
npm run dev                  # http://localhost:8787
```

브라우저로 `http://localhost:8787` 열면 대시보드가 뜬다.

- 아이즈모바일/프리티/티플러스: 아이디·비밀번호 입력 후 로그인. "자동 재로그인 저장"을
  체크해두면 세션이 만료돼도(예: 아이즈 30분) 다음 정기 갱신 때 서버가 알아서 다시 로그인한다.
- 알닷/핀다이렉트: "원격 브라우저로 로그인" 클릭 → 뜨는 화면에서 실제 로그인 진행(네이버/카카오
  포함) → URL이 로그인 완료 조건에 도달하면 자동으로 창이 닫히고 세션이 저장된다.

로그인 후 30분마다 자동 갱신되며(§자동 갱신 설정 대응), 대시보드의 "지금 새로고침"으로 즉시
갱신할 수도 있다(관리용 토큰 = `MVNO_WIDGET_TOKEN` 필요).

### 회선 별칭

대시보드의 회선 카드마다 별칭 입력칸이 있다. 지정하면 위젯이 마스킹된 번호("010-00\*\*-00\*\*")
대신 별칭을 표시한다. 별칭은 `server/data/labels.json`에 평문으로 저장되고, 회선 키와
`(사업자, 순번)` 두 키에 함께 기록된다 — 티플러스처럼 회선 ID가 세션마다 바뀌는 곳에서도
별칭이 유지되도록 하기 위함(문서 §2.10). 빈 값으로 저장하면 별칭이 지워진다.

## 공개 배포 (리버스 프록시 + HTTPS)

아이폰 위젯이 접근하려면 서버가 외부에서 열려 있어야 한다. nginx + Let's Encrypt 기준 구성:

- Node 서비스는 8787에 띄우되 **방화벽으로 8787은 막아둔다.** 외부 트래픽은 nginx가 받아
  `127.0.0.1:8787`로만 프록시한다.
- nginx에 아래 서버 블록을 넣고 `certbot --nginx -d <도메인>` 으로 인증서를 발급한다.
  80 → 443 리다이렉트는 certbot이 넣어준다.
- `certbot.timer`가 자동 갱신하고, 갱신 설정의 `installer = nginx` 덕분에 갱신 후 nginx도
  알아서 reload된다.

### 접근 제어 2단

| 경로 | 인증 | 용도 |
|---|---|---|
| `/api/usage` | `MVNO_WIDGET_TOKEN` Bearer/쿼리 토큰 | Scriptable 위젯 전용 (Basic Auth 없음) |
| 그 외 전부 (`/`, `/api/status`, `/ws/`) | nginx Basic Auth | 대시보드·원격 브라우저 로그인 |

대시보드에는 회선번호·요금제와 통신사 로그인 폼, 원격 브라우저 제어가 그대로 노출되므로
Basic Auth를 씌운다. 계정 생성/변경은:

```bash
sudo htpasswd -c /etc/nginx/mvno.htpasswd mvno   # 최초 생성 (이후엔 -c 빼기)
```

```nginx
server {
    server_name YOUR_DOMAIN;
    listen 80;   # certbot 실행 후 443 + 리다이렉트로 바뀐다

    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 위젯 전용. 자체 Bearer 토큰으로 인증하므로 Basic Auth 예외.
    location /api/usage {
        proxy_pass http://127.0.0.1:8787;
    }

    # 원격 브라우저 로그인 스크린캐스트. 프레임이 계속 흐르므로 타임아웃을 길게 잡는다.
    location /ws/ {
        auth_basic "mvno";
        auth_basic_user_file /etc/nginx/mvno.htpasswd;

        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        auth_basic "mvno";
        auth_basic_user_file /etc/nginx/mvno.htpasswd;

        proxy_pass http://127.0.0.1:8787;
    }
}
```

`auth_basic`을 server가 아니라 각 location 안에 두는 게 중요하다. server 레벨에 걸면
certbot이 만드는 `/.well-known/acme-challenge/` 요청까지 401로 막혀 인증서 발급이 실패한다.

> Ubuntu에서 `sudo certbot`이 `ImportError: cannot import name 'appengine'`으로 죽는다면,
> 사용자 홈의 `~/.local` urllib3이 시스템 패키지를 가린 경우다. `sudo PYTHONNOUSERSITE=1 certbot ...`
> 로 우회할 것. systemd 타이머는 root 홈으로 돌기 때문에 자동 갱신에는 영향이 없다.

## Scriptable에서 접근하려면

`scriptable/MVNO-Usage.js`를 Scriptable 앱에 추가하고 상단 `CONFIG`의 `SERVER_URL`(위에서 만든
도메인)과 `WIDGET_TOKEN`(`server/.env`의 `MVNO_WIDGET_TOKEN`)을 채운다. 그 뒤 홈 화면에
위젯 추가 → 스크립트로 이 파일 선택. 위젯 크기별로 데이터는 항상 보이고, 통화/문자는 large에서만
보이도록 접는다(§2.13 규칙 대응). 위젯을 탭하면 대시보드가 열린다(이때는 Basic Auth를 물어봄).

## 보안 메모

- 통신사 쿠키/토큰은 `server/data/sessions.enc`에 AES-256-GCM으로 암호화되어 저장된다
  (`MVNO_ENCRYPTION_KEY`가 곧 복호화 키이므로 서버 파일시스템 접근 권한 관리가 중요).
- `/api/usage`, `/api/refresh`는 `MVNO_WIDGET_TOKEN`이 없으면 401.
- 대시보드(로그인 폼, 원격 브라우저)는 토큰 보호가 없다 — **개인 서버 용도이며, 공개
  인터넷에 그대로 노출하지 말 것.** 외부에 열 경우 리버스 프록시 단에 Basic Auth 등을 추가하는 걸 권장.
- HTTPS만 허용(`httpEngine.ts`에서 강제)하고, 리다이렉트는 수동으로 따라간다.

## 알아두어야 할 한계

- 각 통신사 API 필드명/엔드포인트는 원본 문서에 있던 소스코드를 그대로 옮긴 것이라, 실제 서버가
  스펙을 바꿨다면 안 맞을 수 있다. 로그인 후 대시보드에 "오류" 배지가 뜨면 `server` 콘솔 로그로
  실제 응답을 확인하고 `src/carriers/<id>.ts`의 파싱 로직을 맞춰 조정하면 된다.
- 티플러스는 회선 식별 토큰(`num`)이 세션마다 바뀔 수 있어, 최초 로그인 후 페이지들을 순회하며
  토큰을 찾아 저장해둔다(`sessionStore`의 `tplus.lineTokens`). 못 찾으면 이전에 저장된 토큰으로
  폴백한다.
- 아이즈모바일은 서버가 "현재 선택된 회선" 상태를 들고 있어 회선을 병렬로 조회할 수 없다
  (`supportsParallelLines: false`로 순차 처리).
