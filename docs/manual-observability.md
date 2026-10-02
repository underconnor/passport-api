# 매뉴얼 등록과 운영 관측

## Notion 매뉴얼

- `GET /v1/manual`: 로그인 전에도 볼 수 있는 등록된 제목·Notion 주소·선택한 임베드 주소·변경 시각. 등록 전에는 `configured: false`, 주소는 `null`이다.
- `GET /v1/admin/manual`: 학교 로그인과 등록된 관리자 권한을 확인하고 위 정보에 `revision`을 더한다.
- `PUT /v1/admin/manual`: owner/operator, 관리자 전용 host, 동일 출처 CSRF, 유효한 학교 로그인이 필요하다. `{ title, notionUrl, embedUrl?, expectedRevision }`를 받는다. 미등록 revision은 0이며 변경 충돌은 `409 manual_settings_changed`다.
- 삭제는 `notionUrl: null, embedUrl: null`로 저장한다. audit에는 변경자와 revision, 등록 여부만 남기며 외부 URL을 남기지 않는다.

문서 공개와 편집은 Notion에서 관리한다. Notion의 공식 절차는 **공유 → 게시 → Embed this page → Copy code**다. 공개된 Notion 사이트 주소를 등록하고, 페이지 안에 보여주려면 복사한 코드의 `src` 주소를 임베드 주소에 넣는다. HTML 코드는 실행하거나 저장하지 않는다. [Notion 공식 게시·임베드 안내](https://www.notion.com/help/public-pages-and-web-publishing)

일반 주소는 HTTPS `notion.site`와 한 단계 하위 도메인, 또는 페이지 ID가 있는 `notion.so`/`www.notion.so`만 허용한다. 임베드는 등록한 Notion 사이트와 같은 host의 `/ebd/<32자리 페이지 ID>`만 허용한다. 일반 주소에도 페이지 ID가 있으면 같은 ID여야 한다. 사용자 정보가 있는 URL, 비표준 포트, 외부 도메인, 중첩 경로는 거절한다. 추적 query와 fragment는 제거하고 유효한 데이터베이스 view ID만 보존한다.

API는 해당 URL을 가져오거나 공개 권한을 변경하지 않는다. 비공개·게시 해제된 문서는 Notion이 접근을 제어하며, 페이지에는 원문을 여는 링크를 함께 제공한다. 커스텀 도메인이나 `notion.so` 편집 링크를 임베드하지 않으므로 게시된 `notion.site` 링크를 사용한다.

## 개인정보 없는 운영 집계

`GET /v1/admin/observability`는 활성 owner/operator/viewer의 관리자 세션에서만 조회할 수 있다. 일반 회원·익명·서비스 Bearer는 사용할 수 없다. 응답에는 학교 파서 버전, 명부 유효기간, 네 작업의 카운터와 지연 구간만 포함한다.

| 작업 | 수집 위치 |
| --- | --- |
| `university` | 학교 인증 callback 처리 |
| `roster_sync` | 주기/수동 명부 적용 |
| `policy` | 게임 정책 조회 |
| `events` | 정책 변경 events 조회 |

각 작업은 성공, 정상 거절, 운영 실패를 구분한다. 학교의 명시적 로그인 거절, 잘못된 요청, 변경 승인 대기는 정상 거절이며 파서 변경·학교 응답 장애·명부 읽기 장애는 실패다. 비회원의 정상 학교 인증은 성공이며 회원 접근 권한 판정과 혼동하지 않는다.

작업 이름 4개와 고정 오류 코드만 허용한다. 지연 구간은 25/100/500/2000/10000ms 이하와 초과의 **상호 배타적** 6개 구간이다. 학생 번호·이름·UUID·IP·query·URL·학교 HTML·예외 메시지를 label이나 데이터에 보관하지 않는다. 누적값은 안전한 정수 범위, 단건 지연은 180초로 제한한다. 관측 코드가 실패해도 원래 인증 결과와 오류를 바꾸지 않는다.

`window: process`와 `startedAt`은 **현재 API 프로세스가 시작된 이후의 집계**를 뜻한다. 재시작하면 집계가 초기화된다. 이 인터페이스를 영구 시계열 저장소나 장기 실패율 그래프로 표시하면 안 된다. 명부 `fetchedAt/expiresAt/fresh`는 별도로 DB에서 조회하며 프로세스 재시작에 의존하지 않는다. 외부 수집기는 `startedAt` 변경을 카운터 재시작으로 처리해야 한다.
