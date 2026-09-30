# 구현할 모듈

아래는 예정 경계입니다. 실행 소스는 아직 없습니다.

| 모듈 | 책임 |
|---|---|
| auth | 단회 학교 인증 시도, 학교 신원→내부 사용자, host별 서버 세션, CSRF, 재인증 |
| university | 허용된 학교 endpoint·cookie jar·최소 HTML 파서·검증 DTO |
| memberships | Sheets 읽기 계정, 스냅샷 검증·diff·신선도·회원 매칭 |
| links | 5분 단회 URL, 웹/게임 확인, 중복 연결 방지 |
| profiles | 본인 표시 설정, 소유 미확인 Discord ID와 변경 기록 |
| policies | deny 우선, 서버 scope, 확인/명부/lease 만료 |
| servers | 승인된 server ID와 운영 대상 매핑 |
| admin | 명시적 RBAC·MFA·정지·기간제 예외 |
| audit | 민감자료를 제외한 변경·복구 감사 |
| worker | 스케줄·outbox·재시도·주기적 대조 |

DTO는 contracts의 고정 버전에서 생성/검증합니다. 포털 세션·관리 세션·서버 서비스 자격증명을 서로 구분합니다. 학교 원본 응답과 토큰, 시트 전체 내용은 로그로 출력하지 않습니다.
