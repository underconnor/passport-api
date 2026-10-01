# 검증된 Discord 연결과 역할 동기화

Discord 봇의 서버 내 `연동하기` interaction에서 호출자의 계정·서버 ID를 받아 전용 링크를 만든다. 봇은 링크를 호출자에게만 ephemeral 응답으로 전달한다. 사용자는 링크에 표시된 Discord 계정을 확인하고 개인정보 안내에 동의한 후 학교 인증을 마친다. API는 유효한 학교 인증과 통합 접속 정지 여부를 확인하며 비회원도 연결할 수 있다. 학교 인증 역할, 현재 회원 역할, 누적 학기 역할과 닉네임의 개별 조건은 [관리 계약 v2](discord-v2.md)를 따른다. Minecraft 개별 서버 범위 제한은 Discord 인증 역할에 영향을 주지 않는다.

한 학교 사용자와 한 Discord 계정만 연결한다. 기존 `Subject.discordId`의 수동 입력 값은 `discordReference`로 남으며 검증된 계정으로 승격하지 않는다. 검증된 연결은 `/me.discordConnection`과 관리자 회원 목록에 별도로 제공한다. 사용자 직접 PUT/DELETE `/v1/me/discord-id`는 세션·CSRF 확인 후403 `discord_admin_contact_required`다. 해제는 운영자에게 요청하며 관리자 API만 수행한다.

## 설정과 권한

다음 설정을 모두 제공한 경우에만 봇 API를 활성화한다.

- `PASSPORT_DISCORD_SERVICE_TOKEN`: 최소32자 독립 credential. Minecraft `API_SERVICE_TOKEN` 및 세션/회원/관리자 비밀과 분리한다.
- `DISCORD_GUILD_ID`: 이 설치에서 관리하는 서버의 uint64 decimal ID.
- `DISCORD_MEMBER_ROLE_ID`: 기존 변수명이며 학교 인증 역할의 최초 DB 설정 값. 현재 회원 역할은 별도 관리자 DB 설정이다.

Minecraft 서비스 토큰은 Discord 봇 API에 접근할 수 없고, 봇 토큰은 Minecraft 정책 API에 접근할 수 없다. 봇은 job의 guild/role을 자신의 설정과 다시 대조해야 한다. `/v1/auth/session.features.discordLinking`은 설정 여부만 공개하며 비밀이나 실제 ID를 노출하지 않는다. 미설정 봇 API는503 `discord_not_configured`로 닫힌다. 관리자에 의한 과거 참고 ID 삭제는 미설정 상태에도 가능하다.

## 연결 및 v1 호환 계약

아래 v1 역할 worker는 학교 인증 역할 하나만 처리한다. 새 worker는 [v2 설정·claim·ack](discord-v2.md)를 사용한다.

| 경로 | 입력과 결과 |
| --- | --- |
| POST /v1/discord/link-sessions | 봇 Bearer. `{discordUserId,guildId,discordUsername,discordDisplayName?,interactionId}` →201 `{id,url,expiresAt}` |
| POST /v1/discord/link-sessions/:id/inspect | 웹 Origin/세션/CSRF와 `{token}` → `{id,discordId,username,displayName,status,expiresAt}` |
| POST /v1/discord/link-sessions/:id/web-confirm | 학교 세션/CSRF와 `{token,consent:{accepted:true,version}}` → `{id,status,expiresAt}` |
| POST /v1/auth/university/start | `{discordLink:{id,token},consent}`. Minecraft `link`와 동시 전달 불가 |
| POST /v1/discord/roles/claim | 봇 Bearer. `{guildId,limit:1..20}` → `{jobs:[{id,leaseToken,guildId,discordUserId,roleId,desired,version,expiresAt}]}` |
| POST /v1/discord/roles/:id/ack | 봇 Bearer. `{leaseToken,version,outcome}` →204. outcome은 `applied`, `retry`, `member_absent`, `configuration_error` 중 하나 |
| DELETE /v1/admin/members/:id/discord | 관리자 학교 세션/CSRF → `{unlinked:true}`. Minecraft 연결은 유지 |

`discordConnection`은 null 또는 기존 `{discordId,username,displayName,linkedAt,roleStatus,roleUpdatedAt}`와 [v2의 역할·학기·닉네임 상태](discord-v2.md)를 함께 제공한다. roleStatus는 `pending`, `granted`, `revoked`, `failed`다. 표시 이름은 interaction에서 봇이 받은 값이며 별도 아바타나 사용자 목록을 요청하지 않는다.

링크는5분간 유효하며 토큰과 interaction ID의 hash만 DB에 저장한다. 같은 계정/서버에 새 요청을 만들면 이전 pending 요청을 취소한다. interaction 재사용은409 `discord_interaction_consumed`, 이미 연결된 Discord 계정은409 `discord_already_linked`다. 링크 토큰은 URL fragment로만 전달한다. 학교 로그인에 동행하는 문맥은 기존 암호화 returnContext에 묶는다.

학교 로그인과 연결 완료는 별도 트랜잭션이다. 성공한 학교 세션을 먼저 커밋한 후 현재 링크·새 세션·동의·학교 인증·정지 상태를 재검사한다. Discord 연결 실패가 학교 로그인을 취소하지 않는다. 복귀는 `/discord/link/:id?discord_link_error=<code>#token=...`이며 오류는 `discord_link_expired`, `discord_link_consumed`, `discord_link_not_found`, `discord_already_linked`, `discord_guild_mismatch`, `school_verification_required`, `confirming_session_expired`, `consent_version_mismatch`와 fallback `discord_link_confirmation_failed`로 제한한다. 원문 학교/DB/Discord 오류는 브라우저나 작업 테이블에 남기지 않는다.

## 역할 작업과 실패 복구

연결 완료는 identity, `discord_link` 동의 영수증, 감사 `discord.linked`, 최초 역할 desired state를 같은 정책 트랜잭션에 저장한다. 명부 동기화, 학교 재인증, 관리자 통합 정지, 관리자 해제 역시 같은 트랜잭션에서 역할 상태를 갱신한다. 자연 만료는 claim/ack에서 다시 확인한다. 관리자 해제는 `admin.discord_unlinked` 감사를 남기고 역할 회수 작업을 보관하므로 연결이 없어져도 회수는 재시도할 수 있다.

lease는최대60초이며 지급 작업은 알려진 학교/회원 유효기간보다 길게 발급하지 않는다. 정책 변경은 version을 올리되 실행 중 lease를 다른 worker에 즉시 넘기지 않는다. 이전 version의 ack는409 `discord_lease_stale`로 거절하고 최신 작업을 다시 대기 상태로 둔다. 잘못된 토큰은 lease를 해제하지 않는다. API 재시작에도 작업/lease/version은 PostgreSQL에 남는다.

성공한 작업도60초 후 다시 확인하여 수동 역할 변경과 서버 재가입에 대응한다. `member_absent`는60초, `configuration_error`는300초, `retry`는5초부터 최대300초까지 지수 간격으로 재시도한다. 회수 대상이 이미 서버에 없는 경우에는 회수 완료로 처리한다. 오류는 위 고정 코드만 저장하고 상류 응답 본문이나 인증 정보는 받지 않는다.

DB version fencing이 Discord REST 자체를 원자적으로 만들지는 않는다. 봇은 단일 worker에서 대상별로 직렬 실행하고, REST 호출 직전 lease 만료를 확인하며,60초보다 짧은 요청 timeout을 적용한다. 늦은 외부 요청이 발생할 가능성은 남으므로 stale ack와 후속 회수/정기 재조정으로 복구한다. 프로필은 마지막 동기화 상태이므로 자연 만료 직후 다음 worker 확인까지 잠시 이전 역할 상태를 표시할 수 있다. API 또는 봇 장애 중 Discord가 이미 부여한 역할을 오프라인으로 강제 회수할 수는 없다. 건강 상태와 작업 실패를 운영 감시에 포함해야 한다.

guild와 기존 verification 역할의 환경 설정은 운영 절차로만 바꾼다. v2 관리자에서 현재 회원·학기 역할을 교체하면 과거 역할을 allowlist에 유지하고 같은 대상의 회수 ack 이후 새 역할을 지급한다.

## 데이터와 배포

현재 개인정보 안내는 학교·현재 회원·누적 학기 역할과 실명/Minecraft 서버 닉네임 관리 목적을 포함한 `2026-10-01.3`이다. 새 학기·닉네임 처리는 새 동의 후 시작한다. 기존 동의 영수증은 수정하지 않는다. 진행 중인 이전 버전 로그인/미완료 게임 링크는 새 안내로 다시 시작하며, 이미 연결된 Minecraft 계정은 유지한다. Discord 링크 요청도 만료 후24시간 뒤 정리한다. 연결 정보와 동의 기록은 계정 삭제 요청 처리까지, 감사는90일 보관하며 암호화 백업은 별도 보관 주기를 따른다.

`20261001060000_verified_discord` migration은 기존 수동 ID에 연결을 생성하지 않는다. 봇 배포와 실제 Discord 역할 설정/권한 검사, ephemeral 링크→실제 학교 로그인→실제 역할 지급/회수 검사가 완료되기 전에는 실제 Discord 연동이 배포 완료되었다고 기록하지 않는다.

## 이전 v1 검증 기록

2026-10-01 소스 검증: `npm run check` 빌드와 단위34개, 전용 PostgreSQL DB 전체 통합70개, 이후 추가한 서로 다른 링크의 동일 학교 사용자 경합1개를 별도로 통과했다. 추가 검사는 identity·동의·역할·감사 각각1개만 남고 응답은200/409임을 확인한다. 실제 Discord 계정이나 운영 DB를 사용하지 않은 합성 회원의 통합 회귀이며, 실제 Discord 서버 권한 설정과 봇 역할 변경 검증은 별도 배포 단계다.
