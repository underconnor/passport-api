# 개인정보 안내·동의와 스킨

`GET /v1/privacy`는 `src/privacy.ts`의 고정 버전 안내를 반환한다. 현재 버전은 `2026-10-01.2`이며 purpose/items/retention/withdrawal을 함께 제공한다. 내용이나 목적이 달라지면 버전도 바꿔야 한다. 학번 원문은 회원 확인에 일시 사용하고 HMAC 식별 키로 보관한다. 학교 비밀번호는 받지 않는다.

사용자 포털의 학교 로그인 시작과 로그인 후 Minecraft 웹 연결 확인에는 `{consent:{accepted:true,version}}`가 필요하다. 동의 없음/false는400 `consent_required`, 이전 안내 버전은409 `consent_version_mismatch`다. 관리자 학교 로그인은 별도 운영자 인증 흐름을 유지하며 일반 사용자의 동의 기록을 임의로 만들지 않는다.

학교 인증 요청에는 안내 버전과 서버가 기록한 수신 시각을 저장한다. 콜백은 브라우저에 묶인 기존 인증 요청의 동의를 다시 검증한다. 이후 `ConsentReceipt`에 사용자·버전·목적(`portal_login`, `minecraft_link`, `discord_link`)·요청 문맥·동의 시각을 삽입한다. 이 레코드를 수정하는 API는 없다. 원문 학번·학교 토큰·브라우저 쿠키·게임 연결 토큰은 영수증에 저장하지 않는다. `/me`의 `privacyConsent`는 `{version,accepted,acceptedAt}`이며 현재 버전의 기록 존재를 보여준다.

학교 로그인과 자동 게임 연결은 두 단계 트랜잭션이다. 첫 단계는 검증된 학교 사용자, 새 브라우저 세션, 로그인 목적 동의 기록을 커밋하고 쿠키를 회전한다. 두 번째 단계는 새 세션과 동행한 연결 토큰으로 pending 상태·5분 TTL·회원 자격을 다시 검증한 뒤 게임 연결 목적의 동의를 기록하고 웹 확인을 완료한다. 게임 측 확인까지 있으면 동일 트랜잭션에서 연결·정책 버전·outbox를 확정한다.

두 번째 단계가 취소·만료·회원 상태·DB 오류로 실패해도 학교 로그인은 유지한다. `/link/:id?link_error=<안전한 코드>#token=...`로 돌아가 현재 상태를 표시한다. SQL 오류 원문을 query에 넣지 않는다. 연결 문맥 자체를 읽을 수 없을 때는 `/?link_error=link_confirmation_failed`로 돌아간다. DB 오류를 첫 트랜잭션 안에서 삼켜 부분 커밋하는 구조를 사용하지 않는다.

새 연결의 최종 확정은 현재 버전의 `minecraft_link` 영수증이 해당 사용자와 해당 link ID에 정확히 존재해야 한다. 과거 버전에서 웹 확인만 찍힌 pending 요청, 다른 사용자/연결의 동의는 재사용할 수 없다. 이미 완료된 기존 연결을 이번 배포가 자동 해제하지는 않으며 다음 사용자 포털 로그인부터 새 안내에 동의한다.

스킨 경로는 다음과 같다.

- `POST /v1/link-sessions/:id/skin`: 익명 또는 로그인 세션, Origin/CSRF, 올바른 링크 토큰과 TTL을 확인한다.
- `GET /v1/me/minecraft-skin`: 로그인한 자신의 연결된 Minecraft UUID만 조회한다. 요청 query로 다른 사용자를 선택할 수 없다.

두 응답은 `{dataUrl:string|null,model:"classic"|"slim"|null}`이다. Mojang의 정확한 HTTPS profile endpoint에서 동일 UUID의 texture 정보를 확인하고, `textures.minecraft.net/texture/<64hex>`의 PNG만 서버가 가져온다. redirect·다른 호스트·임의 포트·query·credentials를 거부한다. profile은64KiB, PNG는256KiB와64×64/64×32 헤더 제한을 적용한다. 각 상류 요청의 제한시간은5초이며, 최대64개 동시 조회와256개 cache를 사용한다. 성공10분/실패30초 cache로 상류 장애의 반복 요청을 제한한다. 스킨 실패는 null이며 회원 확인이나 연결을 막지 않는다. 브라우저가 타사 이미지 URL로 사용자의 접속 정보를 보내지 않도록 같은 origin의 JSON으로 반환한다.

계정과 동의 기록은 삭제 요청 처리까지 보관하며, 운영 감사90일·웹 세션8시간·연결 만료 후24시간 정리와 암호화 백업의 별도 보관 가능성을 안내한다. 자동 계정 삭제 기능을 제공한다고 약속하지 않는다. 소모임 운영자가 계정 삭제·동의 철회 요청을 확인해 처리한다.

배포에는 `20261001050000_privacy_consent` migration이 필요하다. 이전 학교 인증 요청에 동의 필드를 억지로 채우지 않는다. 진행 중이던 사용자 인증은 새 안내로 다시 시작해야 한다.

Discord 검증 연결과 역할 관리는 [Discord 문서](discord-integration.md)를 따른다. 이전 수동 ID는 검증된 계정으로 승격하지 않는다.
