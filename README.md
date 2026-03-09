# Terminal Session Manager (TSM)

PWA + WebSocket 기반 터미널 세션 매니저. 브라우저에서 서버의 터미널 세션을 생성/관리하고, 모바일에서도 홈 화면에 추가하여 사용할 수 있습니다.

## 주요 기능

- **다중 세션** — 여러 PTY 세션을 동시에 생성/전환
- **다중 뷰어** — 하나의 세션에 여러 클라이언트가 접속 (writer/viewer 권한 분리)
- **iTerm2 연동** — 맥에서 기존 iTerm2 세션을 브라우저로 미러링
- **PWA** — 모바일 홈 화면 설치, 오프라인 지원
- **모바일 최적화** — 터치 제스처, 햅틱 피드백, iOS 키보드 뷰포트 보정

## 아키텍처

```
┌─────────────────────┐         WebSocket          ┌──────────────────────┐
│   Client (PWA)      │◄──────────────────────────►│   Server (Node.js)   │
│                     │                             │                      │
│  xterm.js           │                             │  PTY Manager         │
│  Auth Screen        │                             │  Session Manager     │
│  Session Panel      │                             │  Permission Control  │
│  Touch Gestures     │                             │  Rate Limiter        │
│  Haptics            │                             │  Audit Logger        │
│                     │                             │  Env Sanitizer       │
│                     │                             │                      │
│                     │                             │  ┌─ iTerm Bridge     │
│                     │                             │  │  (AppleScript)    │
│                     │                             │  └─ Python Bridge    │
│                     │                             │     (iterm2 API)     │
└─────────────────────┘                             └──────────────────────┘
```

## 빠른 시작

### 요구 사항

- Node.js >= 20
- pnpm

### 설치

```bash
git clone https://github.com/Chocothin/terminal-session-manager.git
cd terminal-session-manager
pnpm install
```

### 개발 모드

```bash
./dev.sh
# 또는
TSM_AUTH_TOKEN="your-token-at-least-32-characters-long" pnpm dev
```

클라이언트: `http://localhost:5173` / 서버: `ws://localhost:3001`

### 프로덕션

```bash
pnpm build
./start.sh
```

`start.sh`는 최초 실행 시 `.tsm-token` 파일에 토큰을 자동 생성합니다. 이 토큰으로 브라우저에서 인증합니다.

## 환경 변수

모든 환경 변수는 `TSM_` 접두사를 사용합니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `TSM_AUTH_TOKEN` | (필수) | 인증 토큰 (최소 32자) |
| `TSM_PORT` | `3001` | 서버 포트 |
| `TSM_HOST` | `127.0.0.1` | 바인딩 주소 |
| `TSM_SESSION_TTL` | `300000` | 미접속 세션 유지 시간 (ms) |
| `TSM_HEARTBEAT_INTERVAL` | `30000` | 하트비트 주기 (ms) |
| `TSM_HEARTBEAT_TIMEOUT` | `45000` | 하트비트 타임아웃 (ms) |
| `TSM_MAX_BUFFER_SIZE` | `262144` | 스크롤백 버퍼 크기 (bytes) |
| `TSM_MAX_SESSIONS_PER_CLIENT` | `10` | 클라이언트당 최대 세션 수 |
| `TSM_ALLOWED_ORIGINS` | (없음) | CORS 허용 오리진 (콤마 구분) |
| `TSM_LOG_DIR` | `./logs` | 감사 로그 경로 |
| `TSM_SHELL` | 시스템 기본 쉘 | PTY에서 사용할 쉘 |

## 보안

- 토큰 인증: timing-safe comparison으로 타이밍 공격 방어
- Rate limiting: 인증 실패 시 IP 기반 차단
- 환경 변수 샌드박싱: PTY 프로세스에 allowlist 기반으로 안전한 변수만 전달
- 입력 검증: 모든 WebSocket 메시지에 대한 strict schema validation
- 감사 로그: 모든 이벤트 JSON 형식으로 일별 로테이션 기록

## 프로젝트 구조

```
terminal-session-manager/
├── packages/
│   ├── server/             # Node.js WebSocket 서버
│   │   └── src/
│   │       ├── index.ts            # 엔트리포인트
│   │       ├── config.ts           # 환경 변수 기반 설정
│   │       ├── ws-server.ts        # WebSocket 서버
│   │       ├── pty-manager.ts      # PTY 프로세스 관리
│   │       ├── session-manager.ts  # 세션 생명주기
│   │       ├── permission.ts       # writer/viewer 권한
│   │       ├── rate-limiter.ts     # 인증 brute-force 방어
│   │       ├── env-sanitizer.ts    # 환경 변수 필터링
│   │       ├── validate.ts         # 메시지 스키마 검증
│   │       ├── audit-logger.ts     # 감사 로그
│   │       ├── iterm-bridge.ts     # iTerm2 AppleScript 제어
│   │       ├── python-bridge.ts    # iTerm2 Python API 브릿지
│   │       └── iterm2_bridge.py    # Python 스크린 캡처
│   │
│   └── client/             # Vite + xterm.js PWA 클라이언트
│       └── src/
│           ├── main.ts             # 엔트리포인트
│           ├── app.ts              # 앱 컨트롤러
│           ├── auth-screen.ts      # 토큰 인증 화면
│           ├── ws-client.ts        # WebSocket 클라이언트
│           ├── terminal-view.ts    # xterm.js 터미널 뷰
│           ├── session-panel.ts    # 세션 목록 사이드바
│           ├── status-bar.ts       # 상태 바
│           ├── permission-controls.ts # 권한 UI
│           ├── touch-gestures.ts   # 모바일 터치 제스처
│           ├── haptics.ts          # 진동 피드백
│           ├── ios-viewport-fix.ts # iOS 키보드 뷰포트 보정
│           └── styles/main.css     # 다크 테마 스타일
│
├── dev.sh                  # 개발 실행 스크립트
├── start.sh                # 프로덕션 실행 스크립트
└── pnpm-workspace.yaml     # 모노레포 설정
```

## 기술 스택

| 영역 | 기술 |
|------|------|
| 서버 런타임 | Node.js 20+ |
| PTY | node-pty |
| WebSocket | ws |
| 클라이언트 빌드 | Vite |
| 터미널 렌더링 | xterm.js (WebGL) |
| PWA | vite-plugin-pwa |
| 패키지 매니저 | pnpm (monorepo) |
| 언어 | TypeScript |

## 라이선스

MIT
