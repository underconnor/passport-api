# Passport API

Passport의 학교 로그인·회원 확인·Minecraft 연결·서버 접근 정책을 관리하는 백엔드입니다.

**현재는 개발 준비 단계입니다.** 구현 계획과 소스 경계를 준비했으며 실행 API·DB migration·Docker image는 아직 없습니다.

## 책임

- 학교 로그인 응답을 검증하고 사용자/관리자 웹에 각각 서버 세션을 발급합니다.
- Google Sheets를 읽기 전용으로 동기화해 검증된 학번과 회원 자격을 대조합니다.
- 웹 확인과 정품 Minecraft 접속 세션의 확인을 모두 거쳐 계정을 연결합니다.
- Discord 숫자 사용자 ID를 문자열로 입력받고 `self_reported`로 저장합니다. 소유 확인·로그인·역할 부여에 사용하지 않습니다.
- 서버별 scope·정지·기간제 허가·prefix 정보를 계산하고 짧은 정책 lease를 제공합니다.
- 관리 RBAC·추가 인증·감사와 계정 복구를 제공합니다.
- worker 프로세스는 명부 동기화·만료·outbox 재시도를 처리합니다.

## 예정 스택

Node.js 24 LTS, NestJS, PostgreSQL 17, Prisma. API와 worker는 같은 저장소에서 각각 실행합니다. 초기 학교 파서는 내부 HTTP/HTML 어댑터이며 추가 런타임은 필요할 때 분리합니다.

학교 비밀번호를 받는 로그인 폼, Discord OAuth, 봇, 자동 역할 동기화, 자체 OIDC 제공자는 첫 버전에 포함하지 않습니다. 학교 callback 동작은 실제 PoC로 검증해야 합니다.

## 다음 작업

1. [계약 저장소](https://github.com/underconnor/passport-contracts)의 초안을 확정합니다.
2. Nest/DB/worker 기본 빌드와 가상 school/member provider를 구성합니다.
3. 학교 콜백·학교 신원 매핑·host별 세션과 CSRF 처리를 구현합니다.
4. Sheets 검증·동기화, 연결 트랜잭션, 정책 API를 구현합니다.
5. 사용자 웹·Velocity와 최초 연결을 검증하고 관리 기능을 확장합니다.

[구현 계획](docs/implementation-plan.md) · [소스 모듈](src/README.md)

사용자 화면은 [passport-web](https://github.com/underconnor/passport-web), 관리 화면은 [passport-admin](https://github.com/underconnor/passport-admin), 게임 접속은 [passport-velocity](https://github.com/underconnor/passport-velocity)와 [passport-paper](https://github.com/underconnor/passport-paper)가 담당합니다. 각 저장소는 고정 계약 버전으로 연결합니다.
