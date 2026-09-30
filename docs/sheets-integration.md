# Google Sheets 명부 동기화

학교 인증은 신원을 확인하고, 명부는 소모임 활동 자격과 접속 가능한 서버를 결정합니다. 이름·Discord ID가 같다는 이유로 회원을 연결하지 않습니다. 학교에서 검증한 학번과 시트 학번에 동일한 `ROSTER_MATCHING_SECRET`으로 HMAC-SHA256을 적용해 일치하는 항목만 연결합니다. 원본 학번, 전화번호, Google 응답 본문은 로그나 명부 테이블에 저장하지 않습니다.

현재 회원 정책은 **명부에 등재된 재학생과 휴학생 모두 허용**입니다. 공개 열 매핑 모드에서는 이름·학과·전화번호·비고를 요청하지 않고 학번과 재학 여부 두 열만 요청합니다. `재학`, `휴학`을 명시적으로 허용하고 그 외 값은 동기화 전체를 보류합니다. `졸업` 같은 새 값이 생겼을 때 자동으로 허가하지 않습니다. 학교 학적 자체로 소모임 활동 상태를 추정하지 않습니다.

## 원자적 반영과 만료

검증된 전체 명부를 `RosterSnapshot`과 `RosterMembership`에 저장하고, 기존 u-SAINT 사용자의 상태·역할·서버 목록을 같은 PostgreSQL 직렬화 트랜잭션에서 갱신합니다. 실제 회원이 아직 가입하지 않았어도 HMAC 항목을 보관하므로 첫 학교 로그인에서 명부를 조회할 수 있습니다. 개발 가상 사용자와 관리자 개별 정지·서버 제한은 이 작업으로 덮어쓰지 않습니다.

회원 삭제, 정지, 허용 서버 축소 및 만료 후 복구 시 연결된 Minecraft UUID의 정책 버전 증가, 감사 기록, 정책 이벤트 저장까지 함께 커밋합니다. 어떤 쓰기라도 실패하면 명부와 정책을 모두 되돌립니다. 부분 반영은 없습니다. 원본 읽기 시작 시간을 기록해 늦게 도착한 예전 요청이 새 snapshot을 덮어쓰지 못하게 합니다.

기본 동기화 간격은 60초이고 snapshot의 유효기간은 읽기 시작 후 **15분**입니다. Google 장애·권한 변경·잘못된 행·승인 보류는 기존 snapshot을 유지하며 만료 시각을 연장하지 않습니다. 따라서 15분 동안 정상 읽기를 못 하면 접속 허가가 만료됩니다. Minecraft 정책 응답의 유효기간도 명부 만료를 넘지 않아야 합니다. 학교 신원 검증의 유효기간은 별도로 적용합니다.

다음 변경은 자동 반영을 보류합니다.

- 헤더만 남은 정상 빈 명부: 전체 회수 의도로 명시 승인해야 합니다. 헤더 자체가 없거나 HTML 로그인 페이지가 오면 승인으로 우회할 수 없는 읽기 오류입니다.
- 이전 활성 인원의 20%를 초과하는 삭제·정지·서버 범위 축소
- 문서, 열 매핑, 허용 학적 상태, 기본 서버 또는 HMAC 키 등 소스 설정 변경

관리자는 preview의 전체 내용에 대응하는 digest를 확인하고 그 digest로만 apply를 승인합니다. 적용 직전에 원본을 다시 읽으며 내용이 바뀌었으면 `approval_mismatch`로 거부합니다. HMAC 키 교체는 모든 학번 키를 바꾸므로 일반적인 설정 변경으로 처리하지 말고 별도의 신원 이전 계획을 세워야 합니다.

## 현재 명부처럼 학번·재학 여부 열을 사용하는 경우

`public-query`는 이미 공유된 문서를 Google Visualization query로 읽습니다. 애플리케이션이 Google 공유 설정을 변경하지 않습니다. 이 모드는 현재 익명 조회가 가능한 경우에만 동작하며 문서를 비공개로 바꾸면 동기화가 실패합니다. 서버는 고정된 Google HTTPS 주소에 요청하고 다른 주소로 리다이렉트하지 않습니다. 10초 timeout, 2MiB/5,000행 제한, 정확한 헤더·중복 학번·상태 검증을 적용합니다.

```dotenv
SHEETS_SYNC_ENABLED=true
SHEETS_ACCESS_MODE=public-query
SHEETS_SPREADSHEET_ID=<private runtime configuration>
SHEETS_TAB=Sheet1
SHEETS_STUDENT_ID_COLUMN=B
SHEETS_ACADEMIC_STATUS_COLUMN=E
SHEETS_STUDENT_ID_HEADER=학번
SHEETS_ACADEMIC_STATUS_HEADER=26-2 재학여부
ROSTER_ACTIVE_ACADEMIC_STATUSES_JSON=["재학","휴학"]
ROSTER_DEFAULT_SERVER_IDS_JSON=["lobby"]
ROSTER_ROLE_LABEL=회원
ROSTER_MATCHING_SECRET=<separate random secret; same key as school matching>
SHEETS_SYNC_INTERVAL_SECONDS=60
ROSTER_MAX_AGE_SECONDS=900
```

서버 목록은 반드시 명시합니다. 새 서버를 등록했다고 모든 회원에게 자동으로 허가하지 않습니다. 환경 파일에서 JSON 배열·공백이 있는 값은 해당 로더의 문법에 맞게 인용합니다. 실제 문서 ID와 키는 공개 저장소에 넣지 않습니다.

## 비공개 연동용 문서를 사용하는 경우

Sheets API를 활성화한 Google 서비스 계정과 Viewer 권한이 필요합니다. 읽기 범위는 서비스 계정의 문서 접근권을 탭 단위로 제한하지 않으므로 필요한 네 열만 담은 별도 연동 문서를 사용합니다.

| student_id | status | role_label | server_ids |
|---|---|---|---|
| 99990001 | active | 회원 | lobby |
| 99990002 | inactive | | |

위 학번은 테스트용입니다. 첫 행은 정확히 네 열이어야 하며 학번은 텍스트로 저장합니다. `status`는 `active`, `inactive`, `suspended`입니다. 활성 상태가 아닌 행은 서버 목록을 비웁니다. `role_label`은 24자 이하이며 제어문자·태그·Minecraft 색상 문자를 허용하지 않습니다.

```dotenv
SHEETS_SYNC_ENABLED=true
SHEETS_ACCESS_MODE=service-account
SHEETS_SPREADSHEET_ID=<private runtime configuration>
SHEETS_RANGE=Passport!A1:D5001
GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-service-account.json
ROSTER_MATCHING_SECRET=<same random matching secret>
```

## 확인 및 운영

```sh
# 소스 파싱 확인: DB 변경 없음
node --env-file=.env dist/sheets-check.js
# 변경 요약·위험·digest 확인: DB 변경 없음
node --env-file=.env dist/sheets-sync.js preview
# 안전한 변경 적용; 위험 변경은 approval_required
node --env-file=.env dist/sheets-sync.js apply
# 검토한 digest와 원본 내용이 같을 때만 위험 변경 적용
node --env-file=.env dist/sheets-sync.js apply <preview-digest>
```

API 수명주기에서는 `startMembershipSync(db)`를 연결하고 종료 시 `stop()`을 호출합니다. `status()`는 활성화 여부·최근 성공 시각·정제된 오류 코드만 반환합니다. 관리 페이지에서는 `preview()`와 `approve(digest)`를 관리자 인증·MFA·CSRF 검사를 거친 뒤 사용합니다. 설정이 없으면 동기화를 시작하지 않고 `configuration_error`를 기록합니다. 실패 이유에 Google 요청·인증 헤더·원본 회원 행을 포함하지 않습니다.

## 확인 범위

2026-09-30 실제 공유 명부에서 두 열만 읽어 36개 항목을 파싱하고 HMAC으로 변환했습니다. 재학·휴학 허용 정책과 `lobby` 한 개 범위 적용을 확인했습니다. 이 읽기 검사는 실제 이름·학번을 출력하거나 저장하지 않았고 DB를 변경하지 않았습니다. 파서 단위 검사 4개와 별도 PostgreSQL `membership_test` 스키마에서 수행한 통합 검사 10개가 통과했습니다. 통합 검사는 원자 롤백, UUID 정책 이벤트, 대량·빈 명부 승인, 만료, 동시 요청 순서, 관리자 제한 보존을 확인합니다. 운영 배포와 실제 학교 로그인 결과는 배포 기록에서 별도로 확인합니다.

- [Google query language: 열은 레이블 대신 A/B 같은 식별자로 선택](https://developers.google.com/chart/interactive/docs/querylanguage)
- [Google 데이터 소스 프로토콜과 CSV 출력](https://developers.google.com/chart/interactive/docs/dev/implementing_data_source)
- [Google Sheets values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)
- [Google Sheets 인증 scope와 문서 단위 접근권](https://developers.google.com/workspace/sheets/api/scopes)
