# 서비스별 API 자격증명

소유자(owner)는 `/v1/admin/service-credentials`에서 키 목록(GET), 발급(POST), 개별 회수(DELETE `/:id`)를 수행합니다. 발급·회수에는 학교 관리자 세션과 CSRF가 필요합니다. operator/viewer와 일반 사용자·서비스 키는 키를 발급할 수 없습니다.

발급 입력은 `serviceId`, `audience`(minecraft/discord), `scopes`, `serverIds`, `expiresAt`입니다. 최대 100개 활성 키, 1분 이상 366일 이내 만료이며 같은 serviceId로 두 키를 발급해 중첩 회전합니다. 발급 응답에서 원문을 한 번 전달하며 DB에는 SHA-256만 저장합니다. 목록과 감사에는 원문·해시를 넣지 않습니다. 새 키를 소비자에 적용하고 정상 요청을 확인한 다음 이전 키를 회수합니다. 회수/만료는 다음 요청부터 거절하며 이미 인증된 진행 중 요청은 완료될 수 있습니다.

Minecraft 쓰기 대상 서버(`serverIds`)는 presence·통계·heartbeat에 적용됩니다. Paper는 자신의 서버 ID만 지정합니다. 정책과 이벤트는 네트워크의 신원별 권한 갱신 정보이므로 읽기 scope가 있는 Paper도 공유 스트림을 사용합니다. proxy 전용 링크·서버 목록·플레이어 검색·통계 조회는 `*` 범위가 필요합니다. Discord audience는 Minecraft API를 호출할 수 없고 반대도 거절됩니다. 현재 허용 scope 목록은 `src/service-credentials.ts`에 있습니다. 알려지지 않은 API는 기본 거절입니다.

`PASSPORT_LEGACY_SERVICE_AUTH_ENABLED=true`는 기존 소비자를 이전하기 위한 호환 설정이며, 환경 변수를 생략해도 업그레이드 호환을 위해 기본값은 true입니다. 새 키를 모두 적용한 후 `false`로 바꾸면 기존 게임·Discord 공유 Bearer를 둘 다 거절합니다. 장애 때 조용히 기존 키를 다시 허용하지 않습니다. 원래 환경 변수들은 호환 설정을 위한 로딩만 유지되며 false 상태에서는 인증에 사용할 수 없습니다.

Paper·Velocity의 `PASSPORT_TELEPORT_SECRET`은 서비스별 API 키와 별개인 공유 서명 비밀입니다. API 키를 바꾸면서 이 값까지 바꾸지 않습니다. 봇 토큰은 Discord API용이며 Passport 서비스 키와 별개입니다. API 자격증명 기능은 범용 OIDC 로그인이나 다른 서비스의 사용자 인증을 구현한 것이 아닙니다.
