# 서버 발견과 접근 설정

`ServerRecord`는 학교 사용자에게 허용할 서버와 화면 이름, 이동 명령 이름, 운영 상태를 PostgreSQL에 보관한다. 첫 초기화 때만 `SERVER_REGISTRY_JSON`의 서버를 `enabled=true`, `accessMode=members`, `commandName=id`로 복사한다. 레코드가 이미 있으면 앱 재시작이나 환경 변수 변경으로 관리자 설정을 덮어쓰지 않는다. 활성 소모임 회원 여부는 시트 동기화 결과를 사용하며 명부에 저장된 서버 ID 목록은 접근 허용 여부를 결정하지 않는다. 학교 전체·선택한 회원 모드는 관리자가 개별 서버에 설정한다. 아래 3모드 전환 migration은 기존 roster 서버만 members로 바꾸며 서버를 새로 만들지 않는다.

Velocity와 Paper는 서비스 Bearer 인증으로 `POST /v1/minecraft/servers/heartbeat`에 `{source:"velocity"|"paper",servers:[{id,label}]}`를 보낸다. 요청당 최대64개이며 ID 중복과 제어문자 label을 거절한다. 새 서버는 `enabled=false`, `accessMode=members`, `commandName=id`로 발견한다. 새 ID가 다른 서버의 이동 명령 이름과 충돌하면 전체 heartbeat를409 `server_command_conflict`로 거절한다. 기존 서버는 해당 source의 seen 시각만 갱신하고 표시명·명령 이름·권한·설정 버전은 바꾸지 않는다. 전체 등록 수64개를 초과하면 한 트랜잭션 전체가409 `registry_full`로 실패한다. 응답은 `{received,registered}`이며 입장 허가를 뜻하지 않는다.

`GET /v1/admin/servers`는 모든 등록 서버를 반환한다. `online`은 Paper heartbeat가90초 이내인지, `proxyAvailable`은 Velocity heartbeat가90초 이내인지를 각각 표시한다. heartbeat는 프로세스의 발견 신호이며 실클라이언트 접속 성공을 보증하지 않는다. 실제 게임 목적지 주소는 Velocity 운영 설정에 계속 존재해야 한다.

관리자는 `PUT /v1/admin/servers/:id`에 `{label,commandName?,discordRequirement?,enabled,sensitive,accessMode,allowedSubjectIds,expectedUpdatedAt}`를 전송한다. 학교 인증·등록 관리자 권한·설정상 필요한 MFA·CSRF를 모두 검증한다. `expectedUpdatedAt`이 현재 설정 시각과 다르면409 `server_changed`를 반환하므로 다시 조회해 변경을 검토한다. heartbeat는 이 설정 시각을 바꾸지 않는다. 응답은 `{server}`이며 단일 서버의 전체 DTO를 담는다.

| accessMode | 기본 허용 범위 |
|---|---|
| members | 모든 활성 소모임 회원 |
| selected | `allowedSubjectIds`에 명시한 유효한 학교 인증 사용자. 소모임 비회원도 포함 |
| university | 유효한 u-SAINT 인증 사용자 전체. 소모임 비회원과 명부 만료 사용자도 포함 |

선택 ID는 기존 학교 사용자여야 한다. 모든 모드는 유효한 학교 인증과 활성 서버를 요구하며 `accessSuspended` 또는 회원 상태 `suspended`이면 차단한다. `members`는 활성 소모임 회원과 유효한 명부를 계속 요구한다. `selected`, `university`는 명부 자격을 요구하지 않는다. 선택한 회원도 학교 인증이 만료되면 접근할 수 없다. 기본 범위를 계산한 뒤 개인 서버 범위 제한을 적용하며 UUID 정책과 사용자 서버 목록에 같은 함수를 사용한다. 개발용 가상 신원은 명시적인 비운영 개발 인증 모드의 기존 회원 정책에만 사용할 수 있고 `selected`와 `university`에는 사용할 수 없다.

관리자 회원 응답의 `eligibleServerIds`는 개인 `accessSuspended`·범위 제한을 적용하기 전의 유효한 기본 범위다. 명부가 만료되어도 학교 인증이 유효하면 `selected` 또는 `university` 서버만 남을 수 있다. 학교 인증 만료 또는 회원 상태 `suspended`이면 비어 있다. 이를 사용하므로 개인 정지 상태에서도 기존 범위를 검토하고 복구할 수 있다. 개인 제한 편집은 이 기본 범위를 확대할 수 없다.

`GET /v1/me/servers`는 실제 허용된 `{id,label,commandName,sensitive}`만 반환한다. 권한 없는 서버의 ID·이름을 비활성 목록으로 노출하지 않는다. `/me.membership.effectiveStatus`는 명부의 상태·유효기간·전체 정지만 반영하며 학교 인증 만료는 별도의 `universityVerifiedUntil`로 표시한다. 학교 인증만 만료된 활성 회원을 명부 갱신 대기로 잘못 표시하지 않지만, 게임 접근은 차단한다. 게임 정책의 `status=active`는 현재 허용 서버가 하나 이상이라는 뜻이므로 학교 전체 서버에 접근 가능한 비회원의 회원 상태와 다를 수 있다. 허용 범위가 빈 활성 회원의 게임 정책은 `revoked`다. 비회원·명부 만료 사용자에게는 회원 prefix를 전달하지 않는다.

게임 연결 웹 확인과 최종 양쪽 확인 완료는 각각 현재 허용 서버가 하나 이상인지 다시 검증한다. 없으면 기존403 `membership_required`를 반환하며, 중간에 서버 비활성화나 정지가 발생하면 최종 확인 기록도 롤백한다. 동의·게임 접속 증명·일대일 연결 조건은 그대로다.

정책 lease는 최대60초이며 항상 학교 인증 유효기간 안에 있다. 반환된 허용 범위에 회원 전용 서버가 있거나 회원 표시(`display.member` 또는 prefix)를 내보내면 명부 유효기간에도 맞춘다. 학교 전체·선택한 회원 서버만 허용되고 회원 표시도 없다면 사용하지 않는 명부 TTL은 lease를 줄이지 않는다. 명부가 만료되면 정책을 다시 계산해 학교 전체·선택한 회원 서버만 남기고 회원 prefix를 비우며 버전을 증가시킨다. Discord의 회원 인증 역할은 여전히 활성 소모임 회원 자격을 요구한다.

설정 변경은 기존 정책 writer lock을 획득하고, 연결된 UUID 정책 버전 증가·outbox·감사를 함께 커밋한다. heartbeat만으로는 접근 정책을 바꾸거나 이벤트를 발생시키지 않는다. `sensitive`는 운영 분류로 전달되며 개별 서버 접근 허용은 `enabled`, 회원 범위, 개인 제한으로 결정한다. 현재 게임 플러그인은 보호 서버 이동 때 최신 정책을 다시 검증한다.

새 배포에는 `20261001040000_server_registry` migration이 필요하다. 서버 테이블을 자동으로 삭제하거나 기존 월드·프록시 목적지를 수정하는 동작은 없다. `test/registry.test.cjs`는 전용 `_test` DB의 별도 schema에서 초기화 보존, 자동 발견, 권한 교집합, 낙관적 동시 편집, 감사·outbox, 전체64개 상한과 heartbeat freshness를 검사한다.

`university` 추가 배포에는 `20261001070000_university_server_access` migration이 필요하다. 기존 CHECK 제약에 새 값만 허용하며 기존 migration을 수정하거나 모드·활성화·멤버 범위 데이터를 변경하지 않는다. API 교체 전에 migration을 적용한다. 같은 학교/회원 정보로 기존 Minecraft 접속 권한 관리 목적을 수행하며 수집·보관 범위를 추가하지 않아 개인정보 안내 버전은 변경하지 않는다. 실서버의 학교 전체 모드 적용은 별도 운영 설정과 실제 접속 QA가 필요하다.

## 표시명과 이동 명령 이름

`id`는 Velocity 목적지·권한·통계가 참조하는 변경 불가능한 식별자다. `label`은 화면 표시명이고 `commandName`은 게임에서 목적지를 선택하는 이름으로 서로 독립적이다. label만 바꿔도 commandName은 유지되고, commandName만 바꿔도 label·id·서버별 통계·학번/회원 정보는 유지된다. 기존 관리자 요청이 commandName을 생략하면 저장된 값을 그대로 쓴다.

명령 이름은 NFC 정규화와 소문자 변환 후 `[a-z0-9가-힣_-]`의1–64자로 제한한다. 앞뒤 공백도 자동으로 제거하지 않고 거절하며 슬래시·제어문자·단독 자모·emoji는 허용하지 않는다. 완성형으로 조합되는 NFD 한글은 NFC로 정규화된다. 정규화한 이름이 다른 서버의 commandName 또는 변경 불가능한 id와 같으면409 `server_command_conflict`다. 동시 변경과 heartbeat 등록도 동일 writer lock 아래 충돌을 검사하며 DB unique/check 제약을 함께 적용한다. 자기 id를 자기 commandName으로 쓰는 것은 허용한다.

관리자 서버 DTO·overview, 사용자 허용 서버·서비스 서버 목록, Minecraft 정책의 `allowedServers:[{id,label,commandName}]`에 이름을 포함한다. commandName은 정책 fingerprint와 버전 변경·outbox·감사에 반영된다. 접근 권한과 통계의 key는 계속 id이며 alias를 새 권한 ID로 취급하지 않는다. 새 정책을 받는 게임 소비자는 commandName으로 검색하고 실제 연결은 id로 수행한다. commandName이 없는 과거 정책의 id 대체 처리는 소비자의 하위 호환 경로에서만 수행한다.

배포 전 `20261002030000_server_command_name` migration을 적용한다. 기존 행은 commandName=id로 채우고 unique·nonnull·문자 범위 제약을 추가하며 기존 id·label·설정 revision·허용 사용자·통계는 바꾸지 않는다. 롤링 배포·이전 API로의 rollback 중에도 새 서버 등록이 동작하도록 BEFORE INSERT 트리거가 commandName을 전달하지 않은 구API INSERT에만 id 기본값을 채운다. UPDATE에는 적용하지 않으며 null로 지우는 변경은 NOT NULL 제약이 거절한다. 새API의 명시적인 null 입력은400이다. 명령 이름을 한글로 바꾸는 작업은 배포 뒤 관리자가 별도로 수행한다. heartbeat payload는 기존 `{id,label}` 그대로이며 관리자 명령 이름을 받거나 덮어쓰지 않는다.

## 학교 전체 서버의 Discord 연동 조건

관리자 서버 DTO는 `discordRequirement: any|linked|unlinked`를 반환한다. `any`는 무관, `linked`는 실제 Discord 계정 연동자, `unlinked`는 미연동자다. 이 조건은 `accessMode=university`에만 적용하며 다른 모드의 설정 저장 시 `any`로 정규화한다. PUT에서 생략하면 university 모드는 저장된 값을 보존하며 그 외 모드는 `any`가 된다. enum 밖 값이나 null은400 `invalid_request`다.

판정은 현재 Subject에 연결된 `DiscordIdentity.subjectId` 관계만 사용한다. 과거 직접 입력한 `Subject.discordId`는 연동 증거가 아니며 역할 부여 성공 여부도 연동 조건을 바꾸지 않는다. 실제 관계가 없는 경우만 미연동으로 판단하고 관계를 읽지 못한 값은 조건을 충족하지 않는다. 학교 만료·전체 정지·개인 서버 제한은 조건보다 먼저/함께 적용한다.

정책, 웹 허용 서버, 게임 연결 양쪽 확인, 관리자 기본 자격, 개인 통계 조회·수집·현재 접속 보고에 같은 판단을 사용한다. 실제 연동·해제 트랜잭션은 Minecraft 정책 버전과 outbox를 갱신하고 통계 epoch를 교체한다. 변경 전 epoch의 지연 전송은 무시하며 이미 저장된 통계는 보존한다. 관리자 서버의 Discord 조건이 실제 바뀔 때도 연결된 UUID의 epoch를 교체하므로 다른 서버의 아직 전송하지 않은 이전 epoch 배치가 함께 제외될 수 있다. 조건을 유지한 표시명 변경은 epoch를 바꾸지 않는다.

`20261003010000_server_discord_requirement` migration은 기본값 `any`와 enum CHECK를 추가한다. 기존 행의 모드·선택 ID·설정 revision은 유지되고 구API의 열 생략 INSERT도 `any`가 된다. 다만 구API는 새 조건을 해석하지 않으므로 linked/unlinked 설정을 사용한 뒤에는 구API만 단독으로 되돌리면 안 된다. 같은 목적의 기존 학교·Discord 연동 정보를 이용하며 새 개인정보는 수집하지 않는다.

## 명부 서버 범위 제거와 3모드 전환

지원하는 접근 모드는 `members`, `selected`, `university` 세 가지다. 신규 공개 PUT은 `accessMode=roster`를400 `invalid_request`로 거절한다. 기존 화면의 편집 버전으로 `members`를 저장하면 낙관적 잠금이409 `server_changed`를 반환하므로 최신 서버를 다시 조회한다. `Subject.allowedServerIds`와 시트의 기존 `serverIds`는 동기화 호환 데이터로 남지만 게임 접근을 허용하거나 제한하지 않는다. 시트의 회원 상태·freshness와 사용자 개인 `scopeRestricted`/`scopeLimit`, 정지·학교 인증 만료는 계속 적용된다.

API 교체 전 `20261003020000_members_server_access` migration을 실행한다. 명시적인 트랜잭션에서 정책 writer advisory lock을 가장 먼저 잡고, 기존 `roster` 행만 `members`로 바꾸며 해당 서버의 `updatedAt`을 최소1ms 증가시킨다. 변환 행이 있으면 연결된 Minecraft UUID의 정책 버전을 올리고 fingerprint를 비운 뒤 같은 트랜잭션에 outbox를 생성한다. 변환할 행이 없으면 정책 버전·이벤트를 건드리지 않는다. 선택 목록·Discord 조건·활성화·통계 설정·개인 제한은 그대로이며, 접근 범위가 동일하거나 확대되는 전환이므로 telemetry epoch와 통계 이력은 유지한다.

DB 기본값은 `members`이며 CHECK에는 세 모드만 남긴다. 구API가 명시적으로 `roster`를 INSERT/UPDATE하는 경우에만 BEFORE 트리거가 `members`로 정규화하여 이전 값이 되살아나지 않도록 한다. 이 DB 호환은 새 HTTP 요청에서 roster를 허용한다는 뜻이 아니다. members를 지원하는 직전 API 이미지와의 교체·rollback은 가능하지만 Discord 조건을 지원하지 않는 더 오래된 이미지에 대한 앞 절의 rollback 제한은 여전하다.

초기 설정 서버는 기존 bootstrap 방식대로 `enabled=true`, 자동 발견 서버는 `enabled=false`로 유지하면서 둘 다 `members`로 시작한다. 저장된 설정이 있으면 seed와 heartbeat는 모드·선택 회원·Discord 조건·통계 설정을 덮어쓰지 않는다. 전환 후 활성 회원은 별도의 명부 서버 ID가 없어도 활성 `members` 서버에 접근하며, 비회원은 명시적으로 선택된 서버나 조건을 충족하는 학교 전체 서버에만 접근한다.
