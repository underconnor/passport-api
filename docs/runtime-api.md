# 실행 API 0.1.0

API는 기본적으로 JSON을 반환합니다. 오류는 `{ "code": "machine_readable_reason" }` 형식이며 내부 오류/DB 오류는 원문 대신 503 `temporarily_unavailable`로 반환합니다. 브라우저 mutation에는 `Origin`, HttpOnly 세션 쿠키, `X-CSRF-Token`을 함께 보냅니다. 서비스 요청은 `Authorization: Bearer <API_SERVICE_TOKEN>`을 사용합니다.

## 브라우저

| 메서드·경로 | 입력 / 응답 |
|---|---|
| GET /v1/auth/session | 익명 세션도 생성. `{authenticated,csrfToken,authMode}` |
| GET /v1/privacy | `{version,purpose,items,retention,withdrawal}` 고정 버전 안내 |
| POST /v1/auth/development | `{identity:"member"\|"outsider"}`. 개발 모드만 허용. 세션 회전 후 /me 응답 |
| POST /v1/auth/logout | 인증 세션 회수, 204 |
| GET /v1/me | `{id,displayName,identityProvider,membership:{status,effectiveStatus,roleLabel,verifiedUntil},minecraft:{uuid,name}\|null,discordReference:{id,verificationStatus:"self_reported",updatedAt}\|null,csrfToken}` |
| GET /v1/me/servers | `{servers:[{id,label,sensitive}]}`. 실제 허용 서버만 반환, 거절 대상 ID·이름 비노출 |
| GET /v1/me/minecraft-skin | 자신의 연결된 스킨 `{dataUrl,model}`. 상류 장애나 미연결은 null |
| PUT /v1/me/discord-id | 세션/CSRF 확인 후403 `discord_admin_contact_required` |
| DELETE /v1/me/discord-id | 세션/CSRF 확인 후403 `discord_admin_contact_required` |
| POST /v1/link-sessions/:id/inspect | `{token}`. 익명 세션+CSRF 허용. `{id,minecraftName,minecraftUuid,status,expiresAt,webConfirmed,gameConfirmed}` |
| POST /v1/link-sessions/:id/skin | `{token}`. 세션+CSRF+링크 소유 확인 → `{dataUrl,model}` |
| POST /v1/link-sessions/:id/web-confirm | `{token,consent:{accepted:true,version}}`. 학교 인증 세션+CSRF+현재 허용 서버 필요. `{id,status,expiresAt}` |
| POST /v1/auth/university/start | 사용자 `{link?:{id,token},consent:{accepted:true,version}}` + CSRF → `{url,expiresIn:300}`. 관리자 로그인은 consent 입력 불필요 |
| GET /v1/auth/university/callback/:state | 학교 `sToken,sIdno` query. 현재 브라우저 세션·단회 state·학번 검증 후 새 세션 및 303 clean redirect |
| GET /v1/auth/university/callback | state 없는 구형 경로는 비활성 |
| GET /v1/admin/session | 학교 로그인·등록·실제 MFA 상태, `schoolVerified`, `mfaRequired`, 최종 접근 여부 `authorized`, 최초 등록 가능 여부 |
| POST /v1/admin/enrollment | `{bootstrapToken}` → MFA 필수이면 `{mfaRequired:true,secret,otpauthUrl}`, 선택이면 `{mfaRequired:false,enrolled:true}`. 첫 운영자 한 명만 |
| POST /v1/admin/mfa | `{code}` → 15분 추가 인증, 쿠키·CSRF 회전 |
| GET /v1/admin/overview | 학교 인증·운영자 권한·설정상 필요한 MFA 후 실제 회원/연결/명부 통계 |
| GET /v1/admin/members?cursor= | 50명씩 회원·연결·권한·개인 제한 전 `eligibleServerIds` 조회 |
| PUT /v1/admin/members/:id/access | `{suspended,restricted,serverIds}`. 서버별 기본 허용 범위 안에서만 제한 |
| GET /v1/admin/servers | `{servers:[{id,label,sensitive,enabled,accessMode,allowedSubjectIds,paperSeenAt,proxySeenAt,online,proxyAvailable,createdAt,updatedAt}]}` |
| PUT /v1/admin/servers/:id | `{label,enabled,sensitive,accessMode,allowedSubjectIds,expectedUpdatedAt}` → `{server}`. 설정 충돌은409 `server_changed` |
| DELETE /v1/admin/members/:id/minecraft | 연결 해제·정책 버전 증가·pending 링크 취소 |
| POST /v1/admin/roster/preview | 현재 명부 변경 요약·digest·위험 표시 |
| POST /v1/admin/roster/sync | `{expectedApprovalDigest?}`. 위험 변경은 일치하는 digest 승인 필요 |
| GET /v1/admin/audit | 최근 감사 기록 100개와 변경 운영자 |

연결 토큰은 `/link/:id#token=...` fragment로만 웹에 전달하며 웹에서 즉시 URL에서 제거합니다. 검사 요청은 POST body를 사용합니다. API는 요청 URL·쿠키·본문을 기록하지 않습니다. 쿠키 Domain은 설정하지 않습니다. 사용자/관리자 쿠키 이름을 분리하고 각각의 세션에 host+port audience를 기록합니다. HTTPS origin에는 Secure를 설정하며 운영 모드는 HTTPS origin만 허용합니다.

`/me`는 현재 안내 버전의 `privacyConsent:{version,accepted,acceptedAt}`도 반환합니다. 사용자 학교 로그인에 연결 문맥이 있으면 성공한 새 세션으로 웹 확인까지 처리합니다. 게임 연결 단계만 실패하면 학교 로그인은 유지하고 `link_error` 코드와 함께 같은 링크로 복귀합니다. 동의 영수증과 스킨의 접근·상류 제한은 [개인정보와 스킨 문서](privacy-and-skins.md)를 참조합니다.

## 게임 서비스

| 메서드·경로 | 입력 / 응답 |
|---|---|
| POST /v1/link-sessions | `{minecraftUuid,minecraftName,gameSessionId}` → 201 `{id,url,expiresAt}` |
| POST /v1/link-sessions/:id/game-inspect | `{minecraftUuid,gameSessionId}` → `{id,status:"pending"\|"linked",expiresAt,webConfirmed,gameConfirmed}`. 현재 접속 소유권을 확인하는 읽기 전용 조회 |
| POST /v1/link-sessions/:id/game-confirm | `{minecraftUuid,gameSessionId}` → `{id,status:"pending"\|"linked",expiresAt}` |
| DELETE /v1/link-sessions/:id | 동일 게임 identity body → 204. 취소는 같은 접속 세션에만 허용 |
| GET /v1/minecraft/policies/:uuid | 계약 `0.1.0-draft`의 최소 정책 |
| GET /v1/minecraft/servers | 활성 서버의 `{servers:[{id,label,sensitive}]}` |
| POST /v1/minecraft/servers/heartbeat | `{source:"velocity"\|"paper",servers:[{id,label}]}` → `{received,registered}`. 새 서버는 비활성 발견 |
| GET /v1/minecraft/events?after= | `{cursor,reset,events:[{id,minecraftUuid,policyVersion}]}`. cursor와 id는 64비트 decimal 문자열, 최대 500개 |
| GET /healthz | DB 연결 확인. `{status:"ok",authMode}` |

UUID는 하이픈이 있는 36자 문자열, Minecraft name은 영숫자/밑줄 1–16자, gameSessionId는 16–128자입니다. gameSessionId는 매 접속마다 난수 UUID로 새로 발급합니다. 연결 요청은 그 UUID의 이전 pending 요청을 취소합니다. 웹/게임 확인 순서는 자유지만 두 확인을 모두 만족해야 연결하며 동일 확인의 재사용은 409입니다. 운영자는 MFA 이후 연결 해제를 실행할 수 있으며 UUID 정책 버전은 보존합니다.

게임 조회는 서비스 인증과 해당 요청의 UUID·gameSessionId가 모두 일치해야 합니다. 웹 확인 토큰이나 학교 사용자 정보는 반환하지 않습니다. 만료는410, 취소·관리자가 이미 해제한 연결은409입니다. Velocity는 현재 접속 세션에서 `webConfirmed && !gameConfirmed`일 때만 기존 게임 확인을 호출할 수 있습니다. 동시 확인의409는 다음 조회로 해결하며, `linked` 응답을 받더라도 최신 서버 정책을 다시 받아 허용 여부를 판단해야 합니다. 조회 자체는 연결·감사·정책 버전을 변경하지 않습니다.

정책은 `status=active`이며 해당 서버가 allowedServerIds에 있고 lease가 유효한 경우에만 허용합니다. 여기서 active는 허용 서버가 하나 이상인 게임 권한 상태이며 `/me.membership.effectiveStatus`의 소모임 회원 상태와 구분합니다. 빈 허용 범위는 active로 반환하지 않습니다. lease는 최대60초와 학교 인증 유효기간(한국 시간 기준 다음 3월 1일 또는 9월 1일 00:00 직전까지) 중 먼저 만료되는 시점에서 잘리고, 허용 범위에 회원 전용 서버가 있거나 회원 prefix를 내보내면 명부 freshness도 적용합니다. 학교 전체(`university`) 서버만 허용되고 회원 prefix가 없으면 명부 TTL은 사용하지 않습니다. 비회원 또는 명부가 만료된 사용자의 회원 roleLabel은 비웁니다. 해당 UUID에서 policyVersion을 보존하고 권한 변화 시 증가시킵니다. API 장애를 허용으로 변환하지 않습니다. 정지의 실제 전파 시간은 현재 소비자의 polling 주기에 달리며 5초 목표를 달성했다는 뜻이 아닙니다.

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
| ADMIN_MFA_REQUIRED | 기본 `true`. 명시적 `false`이면 등록된 운영자의 추가 TOTP 단계만 생략. 학교 인증·관리자 등록·CSRF는 유지 |
| TRUST_PROXY_HOPS | 기본0. Caddy→nginx→API의 고정 격리 배포만2. API 직접 host port 금지 |
| NODE_ENV | production에서는 개발 인증 금지·HTTPS 필수 |
| SERVER_REGISTRY_JSON | 최초 DB 서버 seed와 명부 입력 검증용 최대64개 `{id,label,sensitive?}`. 기존 DB 설정은 덮어쓰지 않음 |
| BIND_HOST / PORT | 기본 127.0.0.1 / 3000. 컨테이너 포트 공개 범위는 배포 설정에서 제한 |
| TEST_DATABASE_URL | 통합 테스트용 전용 DB, 이름이 _test로 끝나야 함 |

현재 요청 제한은 단일 API 인스턴스 메모리 기준이며 DB 신원 데이터는 전부 PostgreSQL에 저장합니다. 여러 공개 인스턴스를 배포하기 전 공통 gateway rate limit을 구성해야 합니다. TTL 정리는 매 60초 실행하며 만료 세션, 만료 후 24시간 지난 연결 요청, 7일 지난 outbox, 90일 지난 감사 기록을 지웁니다. DB 연결 장애 시 다음 주기에 재시도합니다.

학교 토큰은 성공 후 SHA256 지문만 24시간 보관해 재사용을 거절합니다. 콜백 state는 5분이며 링크 복귀 문맥은 인증 암호화해 보관합니다. MFA는 30초 TOTP·±1 step 허용, 사용한 step 재사용 금지, 실패 5회 후 15분 잠금입니다. 관리자 제한은 Sheets 동기화로 해제되지 않습니다. 명부 구성은 [Sheets 문서](sheets-integration.md)를 참조합니다.

`ADMIN_MFA_REQUIRED=false`는 학교 로그인만으로 누구나 관리자가 되는 설정이 아닙니다. 유효한 학교 세션과 `enabled` 관리자 등록이 필요하고 첫 등록에는 같은 bootstrap 비밀을 확인합니다. `authorized`는 접근 허용 여부이며 `mfaVerified`는 실제 TOTP 검증 사실만 나타냅니다. 기존 TOTP 비밀과 검증 기록은 설정 변경으로 지우지 않습니다. TOTP 없이 최초 등록한 관리자가 이후 필수 모드로 바뀌면 `enrollmentPending=true`가 됩니다. 해당 동일 학교 계정이 올바른 bootstrap 코드를 다시 입력해 TOTP를 등록하고 검증해야 접근할 수 있으며, 다른 계정의 재등록은 거절합니다.

이벤트는 정책 변경 알림이며 허가 증거가 아닙니다. `reset=true`이면 접속자를 다시 조회하고, 보존한 UUID 버전보다 낮은 정책은 거절합니다. DB 복원으로 버전이 내려가면 운영자가 버전을 복구해야 합니다.

DB에 보관하는 발견·활성화·접근 범위와 동시 편집 규칙은 [서버 등록 문서](server-registry.md)를 참조합니다. `accessMode`는 `roster|members|selected|university`입니다. university만 비회원의 유효한 학교 인증을 허용하며 모든 모드에서 전체 정지·개인 서버 제한은 유지합니다. 기존 서버는 설정을 바꾸지 않고 새 발견도 비활성 roster로 남습니다. `admin/overview.servers`는 관리자에게 비활성 서버도 이름을 확인할 수 있도록 `{id,label,sensitive,enabled}` 전체 목록을 제공합니다.

이벤트를 생성할 수 있는 정책 트랜잭션은 `policyTransaction`을 사용합니다. 트랜잭션의 첫 SQL에서 공통 PostgreSQL advisory transaction lock을 획득해 ID 발급과 커밋 순서가 어긋나지 않도록 합니다. 웹·게임 연결 완료, 정책 조회 중 변경 감지, 관리자 접근 제한·연결 해제, 명부 반영, 학교 로그인 완료에 적용합니다. 학교 재로그인 시 기존 Minecraft 연결이 있으면 갱신된 학교 유효기간·이름·명부 정보를 소비자가 다시 읽도록 정책 버전과 이벤트를 함께 갱신합니다. 미연결 첫 로그인은 이벤트를 만들지 않습니다. 일반 인증 준비·MFA·읽기 트랜잭션에는 적용하지 않습니다. 잠금은 커밋·롤백 시 자동 해제됩니다. 앞으로 이벤트 생산 경로를 추가할 때도 같은 wrapper를 사용해야 합니다.

## Discord 봇

[검증된 연결·역할 큐·별도 서비스 권한](discord-integration.md)을 참조합니다. `/v1/auth/session`에 `features:{discordLinking:boolean}`, `/me`와 관리자 회원 목록에 `discordConnection`이 추가됩니다. 기존 사용자 수동 Discord PUT/DELETE는403 `discord_admin_contact_required`이며 관리자가 해제합니다.

Discord 역할·닉네임 v2와 관리자 설정·수동 재조정, 현재 동의 갱신의 DTO는 [Discord 관리 v2](discord-v2.md)를 따른다. `/v2/discord/*`도 별도 봇 Bearer가 필요하며 웹 reverse proxy가 해당 prefix를 API로 전달해야 한다. 비회원은 유효 학교 인증·비정지로 학교 역할을 받을 수 있지만 현재 회원 역할은 활성 명부·TTL을 추가 요구한다. Minecraft의 서버별 자격 계산은 이 변경으로 넓히지 않는다.
