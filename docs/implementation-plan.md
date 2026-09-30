# 후속 구현

첫 개발 단계의 DB·세션·Discord·Minecraft 양쪽 확인·정책 API·개발 fixture·Sheets 읽기 검증까지 구현하고 검사했습니다. 실행 계약과 환경은 [runtime-api.md](runtime-api.md)에 기록했습니다.

## 실제 인증 연결 전 필요한 항목

1. HTTPS 개발/운영 도메인과 학교 로그인 return URL 정책을 확정합니다.
2. 사용자가 직접 학교에 로그인하는 흐름에서 nonce·state·세션 결합·학번 수신을 실측합니다. 현재 callback에 임의 학번을 보내서 인증 성공으로 처리하는 우회 경로는 없습니다.
3. 테스트에 동의한 학교 계정으로 최소 학적정보 파서를 검증합니다. 계정 비밀번호·학교 쿠키·전체 응답은 저장하지 않습니다.
4. 실제 Google Sheets 문서 ID, 연동 범위와 읽기 서비스 계정을 설정하고 dry-run 결과를 확인합니다.
5. 검증된 학교 학번과 roster HMAC 키를 매칭하고, 검증 시각·학적 유효기간·snapshot을 DB transaction으로 반영합니다. 동기화 실패 때 신규 승인과 freshness 연장을 중단합니다.

## 운영 전 남은 항목

- 관리자 최초 등록·RBAC·추가 인증·복구·감사 조회. 현재 관리 API는 닫혀 있습니다.
- 명부 scheduler와 원자적 snapshot 적용, 대량 변경 승인, 학교 재인증 주기
- outbox 소비·SSE cursor 재연결. 현재는 정책 polling이며 5초 회수 목표는 아직 달성 검증 전입니다.
- 관리자 승인에 따른 연결 해제·재연결 및 UUID policyVersion 보존 검증
- 운영 ingress의 공통 rate limit, TLS, 정확한 프록시 헤더 설정, secret 회전
- DB 백업·복구 시험, 만료 정리 실패/DB 연결/정책 조회 지연 관측
- 실제 정품 Minecraft 클라이언트·NanoLimbo·Velocity·Paper 전체 통합과 서버 직접 접근 차단 검증

각 단계는 합성 fixture 검증, 실제 외부 연동, 공개 배포를 구분해서 기록합니다.
