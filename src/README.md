# 소스 구성

| 파일 | 역할 |
|---|---|
| app.ts | Nest 라우팅, 비밀을 출력하지 않는 오류 응답, 요청 제한 |
| config.ts | 환경 검증, 개발 인증의 운영 모드 실행 차단 |
| passport.service.ts | DB 세션·CSRF, Discord, 양쪽 계정 연결, 정책 lease, TTL 정리 |
| database.ts | 직렬화 트랜잭션과 충돌 재시도 |
| security.ts | 입력 schema, opaque token, hash, CSRF HMAC |
| seed-development.ts | 명시적으로 요청한 합성 개발 fixture |
| integrations/sheets.ts | 읽기 전용 Google Sheets 수신·검증 |
| sheets-check.ts | 회원 자료를 출력하거나 DB를 바꾸지 않는 검증 CLI |

실제 학교 로그인, 관리자 MFA, 명부 snapshot 반영과 event 전달은 후속 구현입니다. 현재 학교 로그인 callback은 임의의 응답을 인증 성공으로 처리하지 않습니다.
