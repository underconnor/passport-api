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
| POST /v1/auth/university/start | `{link?:{id,token}}` + CSRF → `{url,expiresIn:300}`. university 모드만 학교로 이동 |
| GET /v1/auth/university/callback/:state | 학교 `sToken,sIdno` query. 현재 브라우저 세션·단회 state·학번 검증 후 새 세션 및 303 clean redirect |
| GET /v1/auth/university/callback | state 없는 구형 경로는 비활성 |
| GET /v1/admin/session | 학교 로그인·등록·MFA 상태와 최초 등록 가능 여부 |
| POST /v1/admin/enrollment | `{bootstrapToken}` → TOTP 수동 등록키와 otpauth URI. 첫 운영자 한 명만 |
| POST /v1/admin/mfa | `{code}` → 15분 추가 인증, 쿠키·CSRF 회전 |
| GET /v1/admin/overview | 학교 인증·운영자 권한·MFA 후 실제 회원/연결/명부 통계 |
| GET /v1/admin/members?cursor= | 50명씩 회원·연결·권한 조회 |
| PUT /v1/admin/members/:id/access | `{suspended,restricted,serverIds}`. 명부 허용 범위 안에서만 제한 |
| DELETE /v1/admin/members/:id/minecraft | 연결 해제·정책 버전 증가·pending 링크 취소 |
| POST /v1/admin/roster/preview | 현재 명부 변경 요약·digest·위험 표시 |
| POST /v1/admin/roster/sync | `{expectedApprovalDigest?}`. 위험 변경은 일치하는 digest 승인 필요 |
| GET /v1/admin/audit | 최근 감사 기록 100개와 변경 운영자 |

연결 토큰은 `/link/:id#token=...` fragment로만 웹에 전달하며 웹에서 즉시 URL에서 제거합니다. 검사 요청은 POST body를 사용합니다. API는 요청 URL·쿠키·본문을 기록하지 않습니다. 쿠키 Domain은 설정하지 않습니다. 사용자/관리자 쿠키 이름을 분리하고 각각의 세션에 host+port audience를 기록합니다. HTTPS origin에는 Secure를 설정하며 운영 모드는 HTTPS origin만 허용합니다.

## 게임 서비스

| 메서드·경로 | 입력 / 응답 |
|---|---|
| POST /v1/link-sessions | `{minecraftUuid,minecraftName,gameSessionId}` → 201 `{id,url,expiresAt}` |
| POST /v1/link-sessions/:id/game-confirm | `{minecraftUuid,gameSessionId}` → `{id,status:"pending"\|"linked",expiresAt}` |
| DELETE /v1/link-sessions/:id | 동일 게임 identity body → 204. 취소는 같은 접속 세션에만 허용 |
| GET /v1/minecraft/policies/:uuid | 계약 `0.1.0-draft`의 최소 정책 |
| GET /v1/minecraft/servers | `{servers:[{id,label,sensitive?}]}` |
| GET /v1/minecraft/events?after= | `{cursor,reset,events:[{id,minecraftUuid,policyVersion}]}`. cursor와 id는 64비트 decimal 문자열, 최대 500개 |
| GET /healthz | DB 연결 확인. `{status:"ok",authMode}` |

UUID는 하이픈이 있는 36자 문자열, Minecraft name은 영숫자/밑줄 1–16자, gameSessionId는 16–128자입니다. gameSessionId는 매 접속마다 난수 UUID로 새로 발급합니다. 연결 요청은 그 UUID의 이전 pending 요청을 취소합니다. 웹/게임 확인 순서는 자유지만 두 확인을 모두 만족해야 연결하며 동일 확인의 재사용은 409입니다. 운영자는 MFA 이후 연결 해제를 실행할 수 있으며 UUID 정책 버전은 보존합니다.

정책은 `status=active`이며 해당 서버가 allowedServerIds에 있고 lease가 유효한 경우에만 허용합니다. lease는 60초 이하이며 명부 freshness와 학교 인증 유효기간(로그인 후 180일) 중 먼저 만료되는 시점에서 잘립니다. 해당 UUID에서 policyVersion을 보존하고 권한 변화 시 증가시킵니다. API 장애를 허용으로 변환하지 않습니다. 회원 정지의 실제 전파 시간은 현재 소비자의 polling 주기에 달리며 5초 목표를 달성했다는 뜻이 아닙니다.

## 환경 변수

| 변수 | 의미 |
|---|---|
| DATABASE_URL | PostgreSQL 연결 문자열 |
| API_SERVICE_TOKEN | 게임 서비스용 임의 비밀. 최소 32자 |
| SESSION_SECRET | CSRF HMAC용 별도 비밀. 최소 32자이며 서비스 비밀과 달라야 함 |
| WEB_ORIGIN | 사용자 웹의 정확한 origin |
| ADMIN_ORIGIN | 실제 학교 모드에서는 사용자와 다른 관리자 host 필수 |
| PASSPORT_AUTH_MODE | university: 실제 학교 연동, university-disabled: 미설정, development: 합성 전용 |
| ROSTER_MATCHING_SECRET | 학교 학번·명부 학번의 동일 HMAC 키, 최소 32자 |
| DATA_ENCRYPTION_KEY | 독립 32바이트 hex. 일시 연결 문맥과 TOTP 등록키 AES-256-GCM 암호화 |
| ADMIN_BOOTSTRAP_TOKEN | 최초 운영자 등록용 32바이트 이상 난수. 채팅·소스에 기록하지 않음 |
| TRUST_PROXY_HOPS | 기본0. Caddy→nginx→API의 고정 격리 배포만2. API 직접 host port 금지 |
| NODE_ENV | production에서는 개발 인증 금지·HTTPS 필수 |
| SERVER_REGISTRY_JSON | 최대 64개 `{id,label,sensitive?}` 배열 |
| BIND_HOST / PORT | 기본 127.0.0.1 / 3000. 컨테이너 포트 공개 범위는 배포 설정에서 제한 |
| TEST_DATABASE_URL | 통합 테스트용 전용 DB, 이름이 _test로 끝나야 함 |

현재 요청 제한은 단일 API 인스턴스 메모리 기준이며 DB 신원 데이터는 전부 PostgreSQL에 저장합니다. 여러 공개 인스턴스를 배포하기 전 공통 gateway rate limit을 구성해야 합니다. TTL 정리는 매 60초 실행하며 만료 세션, 만료 후 24시간 지난 연결 요청, 7일 지난 outbox, 90일 지난 감사 기록을 지웁니다. DB 연결 장애 시 다음 주기에 재시도합니다.

학교 토큰은 성공 후 SHA256 지문만 24시간 보관해 재사용을 거절합니다. 콜백 state는 5분이며 링크 복귀 문맥은 인증 암호화해 보관합니다. MFA는 30초 TOTP·±1 step 허용, 사용한 step 재사용 금지, 실패 5회 후 15분 잠금입니다. 관리자 제한은 Sheets 동기화로 해제되지 않습니다. 명부 구성은 [Sheets 문서](sheets-integration.md)를 참조합니다.

이벤트는 정책 변경 알림이며 허가 증거가 아닙니다. `reset=true`이면 접속자를 다시 조회하고, 보존한 UUID 버전보다 낮은 정책은 거절합니다. DB 복원으로 버전이 내려가면 운영자가 버전을 복구해야 합니다.

이벤트를 생성할 수 있는 정책 트랜잭션은 `policyTransaction`을 사용합니다. 트랜잭션의 첫 SQL에서 공통 PostgreSQL advisory transaction lock을 획득해 ID 발급과 커밋 순서가 어긋나지 않도록 합니다. 웹·게임 연결 완료, 정책 조회 중 변경 감지, 관리자 접근 제한·연결 해제, 명부 반영, 학교 로그인 완료에 적용합니다. 학교 재로그인 시 기존 Minecraft 연결이 있으면 갱신된 학교 유효기간·이름·명부 정보를 소비자가 다시 읽도록 정책 버전과 이벤트를 함께 갱신합니다. 미연결 첫 로그인은 이벤트를 만들지 않습니다. 일반 인증 준비·MFA·읽기 트랜잭션에는 적용하지 않습니다. 잠금은 커밋·롤백 시 자동 해제됩니다. 앞으로 이벤트 생산 경로를 추가할 때도 같은 wrapper를 사용해야 합니다.
