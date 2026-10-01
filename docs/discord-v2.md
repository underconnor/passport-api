# Discord 관리 계약 v2

기존 Discord 전용 Bearer를 유지한다. 실제 guild·role·계정·비밀 값은 이 문서에 넣지 않는다. 학교 인증이 유효하고 전체 정지가 아니면 비회원도 Discord를 연결할 수 있다. Minecraft 서버 접근 정책은 바꾸지 않는다.

## 자격과 동의

- `verification`: 유효한 u-SAINT, `accessSuspended=false`, 회원 상태가 `suspended`가 아님. 명부 회원 여부는 요구하지 않는다.
- `member`: 위 조건과 활성 소모임 명부·명부 TTL을 모두 요구한다.
- `semester`: 최신 안내 동의 후 현재 학기에 활성 명부로 확인된 이력을 사용한다. 이력은 탈퇴나 학기 변경으로 삭제하지 않으며 역할은 현재 학교 인증·비정지 조건을 요구한다. 현재 명부에서 탈락해도 과거 학기 역할은 유지한다.
- 학교 인증 만료·전체 정지·관리자 Discord 해제는 관리 역할을 모두 회수한다. 같은 학교 계정의 재연결은 과거 학기 이력을 복원할 수 있다.
- 학기는 관리자가 `YY-1` 또는 `YY-2`로 명시적으로 바꾼다. 날짜 기반 자동 전환과 과거 학기 추측은 없다. 새 학교 신원이 확인되지 않은 명부 행만으로 Discord 계정이나 역할을 만들지 않는다.

개인정보 안내는 `2026-10-01.3`이다. 새 학기 이력 및 실명 닉네임 처리는 해당 버전 동의 후 시작한다. 기존 학교 역할·Minecraft 연결은 동의 갱신 전에도 유지하며 새 처리를 소급 실행하지 않는다. 기존 연결 사용자는 세션·Origin·CSRF가 있는 `POST /v1/me/discord/consent`에 `{consent:{accepted:true,version}}`을 보내 갱신한다. 응답은 `{updated:true}`이고 중복 요청은 같은 정책 transaction 안에서 멱등 처리한다.

## 관리자

학교 세션·등록 관리자·설정상 필요한 MFA를 요구한다. 변경 요청에는 Origin/CSRF가 필요하다.

`GET /v1/admin/discord`:

```text
{configured, settings: null | {
  guildId, verificationRoleId, memberRoleId: string|null,
  currentSemester: string|null, semesterRoles:[{semester,roleId}],
  nicknameEnabled:boolean, revision:string
}, status:{linked:number,roles:{pending:number,failed:number},nicknames:{pending:number,failed:number}}}
```

`PUT /v1/admin/discord`:

```text
{memberRoleId:string|null,currentSemester:string|null,
 semesterRoles:[{semester,roleId}],nicknameEnabled:boolean,expectedRevision:string}
→ {settings}
```

guild와 verificationRoleId는 운영 환경의 기존 `DISCORD_GUILD_ID`, `DISCORD_MEMBER_ROLE_ID`로 최초 초기화하고 일반 관리자 편집으로 바꾸지 않는다. 환경 변경은 기존 DB 설정을 덮어쓰지 않는다. `DISCORD_MEMBER_ROLE_ID`라는 과거 변수명은 v1 호환용 학교 인증 역할 초기값이다. 현재 회원 역할은 DB의 별도 `memberRoleId`다.

role ID는 양의 uint64 십진 문자열이며 `@everyone` 및 모든 설정 내 중복을 거절한다. semesterRoles는 최대40개, 중복 학기 불가다. currentSemester가 있으면 대응하는 매핑도 필요하다. revision은 양의 int64 문자열이며 충돌은409 `discord_settings_changed`다. 같은 역할을 다른 kind/학기로 재사용하면400 `discord_role_conflict`다. 현역 및 회수중 과거 역할은 최대256개다.

`POST /v1/admin/discord/reconcile {expectedRevision}` → `{queued:true}`. 즉시 Discord 반영 완료를 뜻하지 않는다. 관리자 변경과 이력·역할·닉네임 desired 상태·감사를 같은 정책 transaction에 저장한다. 위험한 명부 일괄 변경 승인 절차는 유지한다.

## 봇

`GET /v2/discord/config` → `{contractVersion:2,settingsRevision:string,guildId,managedRoleIds:string[],nicknameEnabled:boolean}`. allowlist에는 과거 역할 회수 대상도 포함한다. 봇은 고정 guild, 계약 버전, 고유 ID, 최대256개를 검증한다.

`POST /v2/discord/roles/claim`, `POST /v2/discord/nicknames/claim`:

```text
{contractVersion:2,guildId,settingsRevision,limit:1..20}
→ {contractVersion:2,jobs:[...]}
공통 job: {id,leaseToken,guildId,discordUserId,version:string,expiresAt}
role job 추가: {roleId,desired:boolean,kind:'verification'|'member'|'semester',semester:string|null}
nickname job 추가: {nickname:string|null}
```

설정 revision이 바뀌면409 `discord_settings_changed`이며 봇은 설정을 다시 읽는다. nickname은 최대32 Unicode codepoint이며 실명과 연결된 Minecraft 이름을 `실명 / Minecraft이름`으로 조합한다. Minecraft 미연결은 실명만 사용한다. 중앙 DB의 연결 이름을 사용하며 게임 연결·해제 시 갱신한다. Mojang 외부의 계정 이름 변경을 별도 조회로 자동 감지하지 않는다. 학교 이름에 붙은 알려진 인사말 suffix는 제거하며 모호한 이름은 닉네임으로 보내지 않는다.

`POST /v2/discord/roles/:id/ack`, `POST /v2/discord/nicknames/:id/ack`:

```text
{contractVersion:2,leaseToken,version,outcome} → 204
role outcome: applied | retry | member_absent | configuration_error
nickname outcome: 위 4개 + not_manageable
```

닉네임의 `not_manageable`은 서버 소유자/역할 계층처럼 대상별 변경 불가다. 역할 성공 여부와 별도로 저장한다. 전체 닉네임 권한 부족은 `configuration_error`다. 원문 오류, 사용자 이름, 닉네임을 ack나 로그에 넣지 않는다.

nickname `null`은 **봇의 닉네임 관리 해제**다. 봇은 변경 전 원래 닉네임과 자신이 쓴 마지막 닉네임을 지속 저장하고, 현재 닉네임이 자신이 쓴 값과 같을 때만 원래 값으로 복구한다. 이미 같아 쓰지 않았거나 사용자가 나중에 바꾼 닉네임은 소유한 것으로 간주하지 않는다. `nicknameEnabled=false`에도 이 복구 작업은 실행한다.

역할 및 닉네임 lease는 최대60초이며 지급/적용 작업은 알려진 학교·회원 자격 만료를 넘지 않는다. 변경 중 lease를 빼앗지 않으며 오래된 ack는409 `discord_lease_stale`다. 역할 교체는 같은 사용자·kind·학기의 이전 역할 회수 ack 이후 새 역할을 지급한다. 성공 후60초 재확인, 회원 부재60초, 설정/관리 불가300초, 일시 오류5~300초 backoff를 사용한다. 작업은 nextAttemptAt 순서로 공정하게 처리하고, 이전 역할 회수를 기다리는 지급은5초 뒤로 재예약하여 후보100개 제한이 다른 대상을 막지 않게 한다. Discord에는 역할 TTL이 없으므로 장애 중 즉시 회수를 보장하지 않는다.

v1 링크 생성/웹 확인은 유지한다. v1 role claim/ack는 legacy 학교 인증 역할 하나만 처리하며 새 회원·학기·닉네임 작업을 받지 못한다. v2는 필수 `contractVersion:2`를 검증하고 v1 payload를 받지 않는다.

## 사용자 및 개별 운영 상태

`/me.discordConnection`과 관리자 회원 목록은 기존 `{discordId,username,displayName,linkedAt,roleStatus,roleUpdatedAt}`를 유지한다. roleStatus는 학교 인증 역할의 마지막 상태다. 다음 항목이 추가된다.

```text
managementConsentRequired:boolean
membershipSemesters:string[]
roles:{verification:statusDTO|null,member:statusDTO|null,
       semesters:[{semester,...statusDTO}]}
nickname:null|{desired:string|null,status:'pending'|'applied'|'failed'|'disabled',updatedAt,lastError}
statusDTO:{status:'pending'|'granted'|'revoked'|'failed',updatedAt,lastError}
```

`applied`는 현재 desired와 같은 version의 성공 ack를 받은 경우다. null 닉네임이 적용 완료되고 nicknameEnabled=false이면 disabled다. 학기 역할 상태는 현재 설정에 매핑된 role ID만 반환하므로 같은 학기의 과거 회수 대상과 중복되지 않는다. 누적 이력은 membershipSemesters로 별도 보존한다. 기록된 상태는 외부 Discord의 실시간 원자적 조회를 뜻하지 않는다.

## 배포

기존 봇 중지 → `20261001080000_discord_management` migration → API → v2 경로를 전달하는 웹 프록시 → v2 봇 순서로 배포한다. 기존 역할 상태는 verification kind로 보존하며 현재 회원/학기 설정과 nicknameEnabled는 비활성 기본값으로 시작한다. 실 운영 설정, 동의 갱신 및 실제 역할/닉네임 검증은 별도로 진행한다.
