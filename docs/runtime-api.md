# 실행 API 0.1.0

API는 기본적으로 JSON을 반환합니다. 오류는 `{ "code": "machine_readable_reason" }` 형식이며 내부 오류/DB 오류는 원문 대신 503 `temporarily_unavailable`로 반환합니다. 브라우저 mutation에는 `Origin`, HttpOnly 세션 쿠키, `X-CSRF-Token`을 함께 보냅니다. 서비스 요청은 `Authorization: Bearer <API_SERVICE_TOKEN>`을 사용합니다.

## 브라우저

| 메서드·경로 | 입력 / 응답 |
|---|---|
| GET /v1/auth/session | 익명 세션도 생성. `{authenticated,csrfToken,authMode}` |
| POST /v1/auth/development | `{identity:"member"\|"outsider"}`. 개발 모드만 허용. 세션 회전 후 /me 응답 |
| POST /v1/auth/logout | 인증 세션 회수, 204 |
| GET /v1/me | `{id,displayName,identityProvider,membership:{status,roleLabel,verifiedUntil},minecraft:{uuid,name}\|null,discordReference:{id,verificationStatus:"self_reported",updatedAt}\|null,csrfToken}` |
| GET /v1/me/servers | `{servers:[{id,label,sensitive?}]}` |
| PUT /v1/me/discord-id | `{id:"123..."}` → 자기신고 reference |
| DELETE /v1/me/discord-id | 204. 이후 /me의 discordReference는 null |
| POST /v1/link-sessions/:id/inspect | `{token}`. 익명 세션+CSRF 허용. `{id,minecraftName,minecraftUuid,status,expiresAt,webConfirmed,gameConfirmed}` |
| POST /v1/link-sessions/:id/web-confirm | `{token}`. 인증한 회원 세션+CSRF. `{id,status,expiresAt}` |
| POST /v1/auth/university/start | CSRF 검사 후 503 university_provider_not_configured |
| GET /v1/auth/university/callback | 503 university_provider_not_configured |
| GET /v1/admin/overview | 인증 세션 검사 후 403 admin_unavailable |

연결 토큰은 `/link/:id#token=...` fragment로만 웹에 전달하며 웹에서 즉시 URL에서 제거합니다. 검사 요청은 POST body를 사용합니다. API는 요청 URL·쿠키·본문을 기록하지 않습니다. 쿠키 Domain은 설정하지 않습니다. 사용자/관리자 쿠키 이름을 분리하고 각각의 세션에 host+port audience를 기록합니다. HTTPS origin에는 Secure를 설정하며 운영 모드는 HTTPS origin만 허용합니다.

## 게임 서비스

| 메서드·경로 | 입력 / 응답 |
|---|---|
| POST /v1/link-sessions | `{minecraftUuid,minecraftName,gameSessionId}` → 201 `{id,url,expiresAt}` |
| POST /v1/link-sessions/:id/game-confirm | `{minecraftUuid,gameSessionId}` → `{id,status:"pending"\|"linked",expiresAt}` |
| DELETE /v1/link-sessions/:id | 동일 게임 identity body → 204. 취소는 같은 접속 세션에만 허용 |
| GET /v1/minecraft/policies/:uuid | 계약 `0.1.0-draft`의 최소 정책 |
| GET /v1/minecraft/servers | `{servers:[{id,label,sensitive?}]}` |
| GET /healthz | DB 연결 확인. `{status:"ok",authMode}` |

UUID는 하이픈이 있는 36자 문자열, Minecraft name은 영숫자/밑줄 1–16자, gameSessionId는 16–128자입니다. gameSessionId는 매 접속마다 난수 UUID로 새로 발급합니다. 연결 요청은 그 UUID의 이전 pending 요청을 취소합니다. 웹/게임 확인 순서는 자유지만 두 확인을 모두 만족해야 연결하며 동일 확인의 재사용은 409입니다. 연결 완료 후 직접 재연결·연결 해제 API는 아직 없습니다.

정책은 `status=active`이며 해당 서버가 allowedServerIds에 있고 lease가 유효한 경우에만 허용합니다. lease는 60초 이하이며 회원 유효기간에서 잘립니다. 해당 UUID에서 policyVersion을 보존하고 권한 변화 시 증가시킵니다. API 장애를 허용으로 변환하지 않습니다. 회원 정지의 실제 전파 시간은 현재 소비자의 polling 주기에 달리며 5초 목표를 달성했다는 뜻이 아닙니다.

## 환경 변수

| 변수 | 의미 |
|---|---|
| DATABASE_URL | PostgreSQL 연결 문자열 |
| API_SERVICE_TOKEN | 게임 서비스용 임의 비밀. 최소 32자 |
| SESSION_SECRET | CSRF HMAC용 별도 비밀. 최소 32자이며 서비스 비밀과 달라야 함 |
| WEB_ORIGIN | 사용자 웹의 정확한 origin |
| ADMIN_ORIGIN | 선택. 관리자 웹 origin |
| PASSPORT_AUTH_MODE | 기본 university-disabled. 합성 계정은 development일 때만 활성 |
| NODE_ENV | production에서는 개발 인증 금지·HTTPS 필수 |
| SERVER_REGISTRY_JSON | 최대 64개 `{id,label,sensitive?}` 배열 |
| BIND_HOST / PORT | 기본 127.0.0.1 / 3000. 컨테이너 포트 공개 범위는 배포 설정에서 제한 |
| TEST_DATABASE_URL | 통합 테스트용 전용 DB, 이름이 _test로 끝나야 함 |

현재 요청 제한은 단일 API 인스턴스 메모리 기준이며 DB 신원 데이터는 전부 PostgreSQL에 저장합니다. 여러 공개 인스턴스를 배포하기 전 공통 gateway rate limit을 구성해야 합니다. TTL 정리는 매 60초 실행하며 만료 세션, 만료 후 24시간 지난 연결 요청, 7일 지난 outbox, 90일 지난 감사 기록을 지웁니다. DB 연결 장애 시 다음 주기에 재시도합니다.
