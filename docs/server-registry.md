# 서버 발견과 접근 설정

`ServerRecord`는 학교 회원에게 허용할 서버와 화면 이름, 운영 상태를 PostgreSQL에 보관한다. 첫 초기화 때만 `SERVER_REGISTRY_JSON`의 서버를 `enabled=true`, `accessMode=roster`로 복사한다. 레코드가 이미 있으면 앱 재시작이나 환경 변수 변경으로 관리자 설정을 덮어쓰지 않는다. 기존 명부의 네 서버 범위도 자동으로 확대하지 않는다.

Velocity와 Paper는 서비스 Bearer 인증으로 `POST /v1/minecraft/servers/heartbeat`에 `{source:"velocity"|"paper",servers:[{id,label}]}`를 보낸다. 요청당 최대64개이며 ID 중복과 제어문자 label을 거절한다. 새 서버는 `enabled=false`, `accessMode=roster`로 발견한다. 기존 서버는 해당 source의 seen 시각만 갱신하고 이름·권한·설정 버전은 바꾸지 않는다. 전체 등록 수64개를 초과하면 한 트랜잭션 전체가409 `registry_full`로 실패한다. 응답은 `{received,registered}`이며 입장 허가를 뜻하지 않는다.

`GET /v1/admin/servers`는 모든 등록 서버를 반환한다. `online`은 Paper heartbeat가90초 이내인지, `proxyAvailable`은 Velocity heartbeat가90초 이내인지를 각각 표시한다. heartbeat는 프로세스의 발견 신호이며 실클라이언트 접속 성공을 보증하지 않는다. 실제 게임 목적지 주소는 Velocity 운영 설정에 계속 존재해야 한다.

관리자는 `PUT /v1/admin/servers/:id`에 `{label,enabled,sensitive,accessMode,allowedSubjectIds,expectedUpdatedAt}`를 전송한다. 학교 인증·등록 관리자 권한·설정상 필요한 MFA·CSRF를 모두 검증한다. `expectedUpdatedAt`이 현재 설정 시각과 다르면409 `server_changed`를 반환하므로 다시 조회해 변경을 검토한다. heartbeat는 이 설정 시각을 바꾸지 않는다. 응답은 `{server}`이며 단일 서버의 전체 DTO를 담는다.

| accessMode | 활성 회원의 기본 허용 범위 |
|---|---|
| roster | 명부가 해당 서버를 허용한 회원 |
| members | 모든 활성 학교 회원 |
| selected | `allowedSubjectIds`에 명시한 활성 학교 회원 |

선택 ID는 기존 학교 사용자여야 한다. 비활성 서버, 만료된 학교 인증·명부, 비회원·회원 정지는 어떤 모드에서도 허용되지 않는다. 기본 범위를 계산한 뒤 관리자가 설정한 개인 접근 정지와 서버 범위 제한을 적용한다. 동일 함수를 UUID 정책과 사용자 서버 목록에 사용한다.

관리자 회원 응답의 `eligibleServerIds`는 개인 정지·범위 제한을 적용하기 전의 유효한 기본 범위다. 회원/학교 자격이 만료된 경우에는 비어 있다. 이를 사용하므로 개인 정지 상태에서도 기존 범위를 검토하고 복구할 수 있다. 개인 제한 편집은 이 기본 범위를 확대할 수 없다.

설정 변경은 기존 정책 writer lock을 획득하고, 연결된 UUID 정책 버전 증가·outbox·감사를 함께 커밋한다. heartbeat만으로는 접근 정책을 바꾸거나 이벤트를 발생시키지 않는다. `sensitive`는 운영 분류로 전달되며 개별 서버 접근 허용은 `enabled`, 회원 범위, 개인 제한으로 결정한다. 현재 게임 플러그인은 보호 서버 이동 때 최신 정책을 다시 검증한다.

새 배포에는 `20261001040000_server_registry` migration이 필요하다. 서버 테이블을 자동으로 삭제하거나 기존 월드·프록시 목적지를 수정하는 동작은 없다. `test/registry.test.cjs`는 전용 `_test` DB의 별도 schema에서 초기화 보존, 자동 발견, 권한 교집합, 낙관적 동시 편집, 감사·outbox, 전체64개 상한과 heartbeat freshness를 검사한다.
