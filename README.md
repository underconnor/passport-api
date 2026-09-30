# Passport API

[개발 배포 검증 범위](docs/verification.md)

학교 신원, 회원 명단, Minecraft 계정 연결과 서버 접근 정책을 관리하는 독립 백엔드입니다. Node.js 24, NestJS 12, PostgreSQL 17, Prisma 6을 사용합니다.

## 현재 구현

- PostgreSQL에 저장하는 브라우저 세션, 로그인 시 세션 회전, host/port별 audience, 사용자·관리자 쿠키 분리, HttpOnly·SameSite와 Origin/CSRF 검증
- 서비스 Bearer 인증, 5분 단회 연결 URL, 웹·게임 양쪽 확인, 접속 세션 일치, 원자적 연결·취소·재사용 차단
- UUID별 단조 증가 정책 버전, 최대 60초 lease, 회원·명부 유효기간 만료 시 차단, 변경 outbox 기록
- 자기신고 Discord ID 입력·수정·삭제. 양의 uint64 문자열만 받으며 소유권 확인이나 권한 증거로 사용하지 않음
- 명시적으로 켜는 합성 개발 회원·비회원. `NODE_ENV=production`에서는 개발 인증 시작 자체를 거부
- 학교 공식 로그인 → 브라우저에 묶인 단회 콜백 → SAP 토큰 교환 → 학교 학번 대조, HMAC 신원 매칭과 세션 회전
- Google Sheets 읽기 전용 어댑터, 원자적 명부 snapshot 반영, 60초 자동 동기화와 15분 freshness, 위험 변경 digest 승인
- 관리자 학교 인증 + 최초 등록 코드 + TOTP, 회원 조회·접속 정지·서버 범위 제한·Minecraft 연결 해제·감사 조회
- 서비스 인증으로 보호하는 outbox cursor API, 유실·보관 기간 경과·DB 복원 시 전체 재검사 신호
- 만료 세션 정리와 단일 인스턴스용 요청 제한

실제 학교·명부·관리자 코드가 연결되어 있습니다. 학교 비밀번호는 이 API에서 받지 않으며, 학교에서 받은 토큰·세션 쿠키·원본 HTML은 영속 저장하거나 로그에 남기지 않습니다. 실제 학교 계정의 콜백 왕복과 정품 게임 클라이언트의 전체 접속 QA는 별도 확인해야 합니다. 공개 운영에는 HTTPS와 분리된 비밀값을 사용하고 개발 인증을 끕니다.

## 로컬 실행

Node.js 24와 별도의 PostgreSQL 17이 필요합니다. `.env.example`을 `.env`로 복사한 뒤 DB 주소와 서로 다른 임의의 긴 비밀값 두 개를 설정합니다. 비밀값·서비스 계정 JSON·실제 회원 명단은 커밋하지 않습니다.

```sh
npm ci
npm run build
npm run db:migrate
# 합성 계정을 사용하려는 비공개 개발 환경에서만 .env의 PASSPORT_AUTH_MODE=development 설정
node --env-file=.env dist/seed-development.js
node --env-file=.env dist/main.js
```

웹은 `/v1`을 API로 프록시하며 원래 `Host`와 `Origin`을 보존해야 합니다. 브라우저 Origin은 `WEB_ORIGIN` 또는 `ADMIN_ORIGIN`과 정확히 일치해야 합니다. 웹 브라우저에 `API_SERVICE_TOKEN`을 전달하지 않습니다. `BIND_HOST` 기본값은 `127.0.0.1`이고 Docker 이미지는 컨테이너 내부에서 `0.0.0.0`을 사용합니다. 개발 이미지의 외부 포트는 VPN 주소나 loopback에만 공개합니다.

## 검사

```sh
npm run check
# TEST_DATABASE_URL은 이름이 _test로 끝나는 전용 DB여야 함
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate
npm run test:integration
npm audit
```

통합 테스트는 해당 전용 DB의 Passport 테이블을 초기화합니다. 이름 검사만으로 운영 DB와의 분리가 보장되지는 않으므로 CI 또는 격리된 DB만 지정합니다. 단위 검사와 학교 파서, 명부 동기화, 실제 PostgreSQL 기반 학교 세션·MFA·정책 통합 검사를 실행합니다. 통합 검사는 서비스 인증, 세션 회전·CSRF·host 분리, 두 가지 확인 순서, 만료·재사용·중복 UUID/회원, 동시 확정, 로그아웃·접속 취소, 회원 정지·유효기간, Discord 범위를 포함합니다.

## 배포

```sh
docker build -t passport-api:local .
# 실행 전 동일 이미지와 DB 설정으로 npm run db:migrate 실행
# 개발 인증이 필요한 환경에서만 npm run db:seed:development 실행
```

이미지는 비특권 사용자로 실행하며 `/healthz`에서 DB 연결을 확인합니다. 스키마 적용과 fixture 생성은 서버 시작에 자동으로 포함하지 않습니다. 의존성은 lockfile로 고정합니다. Prisma CLI의 `deepmerge-ts` 간접 의존성은 보안 수정 버전 8.0.0으로 재정의했고 생성·migration·빌드를 검증했습니다.

[실행 API와 환경 변수](docs/runtime-api.md) · [Sheets 동기화](docs/sheets-integration.md) · [학교 파서](docs/usaint-integration.md) · [남은 구현](docs/implementation-plan.md)

공개 저장소의 CI·빌드는 비공개 계약 저장소 없이 독립적으로 동작합니다. 현재 Minecraft 응답 계약 식별자는 `0.1.0-draft`입니다.
