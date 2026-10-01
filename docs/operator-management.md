# 운영자 관리

`owner`는 운영자 초대·역할 변경·회수를 포함한 전체 권한, `operator`는 기존 회원·서버·Discord·명부 일상 운영, `viewer`는 조회만 허용한다. 관리자 호스트의 유효한 학교 로그인과 현재 활성 권한은 매 요청 확인한다. 운영에서는 `ADMIN_MFA_REQUIRED=false`를 유지한다.

최고관리자는 이미 학교 인증한 회원을 검색해 역할을 선택하고 초대한다. 초대는 해당 subject에 결합하며 24시간 동안 한 번만 수락할 수 있다. 비밀 링크/토큰을 전달하지 않는다. 대상자는 관리자 페이지에서 학교 로그인 후 본인에게 온 초대를 수락한다. 역할이 이미 있는 계정은 새 초대 대신 역할 변경을 쓴다. 초대 수락 전 학교 인증이 만료되면 다시 학교 인증해야 한다. 초대자의 최고관리자 권한이 없어지면 그가 발급한 대기 초대도 취소된다.

| API | 조건 |
| --- | --- |
| `GET /v1/admin/session` | `subjectId`, `role`, `permissions:{read,write,manageOperators}` 포함 |
| `GET /v1/admin/operators` | owner. 운영자 및 최근 초대 100개 |
| `POST /v1/admin/operator-invitations` | owner + CSRF. `{subjectId,role}` |
| `GET /v1/admin/operator-invitations/pending` | 학교 로그인. 본인 대기 초대만 |
| `POST /v1/admin/operator-invitations/:id/accept` | 해당 학교 계정 + CSRF. `{}` |
| `DELETE /v1/admin/operator-invitations/:id` | owner + CSRF |
| `PUT /v1/admin/operators/:subjectId` | owner + CSRF. `{role}` |
| `DELETE /v1/admin/operators/:subjectId` | owner + CSRF |

초대·권한 변경·회수·수락은 정책 writer lock과 SERIALIZABLE 트랜잭션을 사용한다. 자신을 강등/회수하거나 자기 접속을 정지할 수 없고, 마지막 owner의 삭제도 거절한다. 기존 회원 삭제·접속 변경·연동 해제 경로에서 활성 운영자를 대상으로 하려면 owner가 필요하다. viewer는 기존의 모든 변경 API와 게임 관리 권한에서 제외한다.

역할 변경/회수는 대상의 관리자 호스트 세션을 삭제하고 MFA 확인을 지운다. 회수된 TOTP와 과거 bootstrap 코드로 재활성화할 수 없다. 사용자 포털 세션은 유지한다. 수락 시 수락한 세션만 유지하고 과거 관리자 세션은 삭제한다. Minecraft 정책 버전과 outbox를 같은 트랜잭션에서 갱신한다. 게임 서버의 적용은 기존 이벤트 수신과 정책 임대 만료 시간 안에 반영되며 웹 권한 회수와 별개로 검증해야 한다. 이미 시작된 명부 네트워크 읽기도 DB 적용 시 현재 운영자 권한을 다시 확인한다.

마이그레이션 `20261002000100_operator_roles`는 기존 관리자 행을 owner로 보존하고 신규 행 기본값을 viewer로 둔다. 초대 테이블 1개와 역할/회수 시각 열을 추가한다. 운영 계정에 새 권한을 자동 부여하지 않는다. 배포 전 전체 암호화 백업을 확보하고 배포 후 기존 owner 수, 계정 수, 학교 로그인/권한, 새 테이블 복원을 확인한다. 복원 테이블 수는 기존 25개에서 26개가 된다.

MFA 분실 전용 복구와 초대 계정의 새 TOTP 등록은 별도 보류한다. `ADMIN_MFA_REQUIRED=true`인 배포에서 초대 수락은 `mfa_enrollment_unavailable`로 차단해 설정된 MFA를 우회하지 않는다. 기존 bootstrap/TOTP 로그인 검증은 유지한다.

주요 오류: `owner_required`, `admin_write_required`, `self_admin_change_forbidden`, `last_owner`, `operator_not_found`, `operator_already_enrolled`, `target_university_login_required`, `invitation_pending`, `invitation_not_found`, `invitation_expired`, `invitation_unavailable`. 인증/CSRF 오류는 기존 규칙을 유지한다. 감사에는 역할·대상 내부 ID·초대 ID만 남기고 전체 학번, 학교 토큰, TOTP 키, 세션 토큰, 암호문은 포함하지 않는다.
