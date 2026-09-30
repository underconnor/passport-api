# Google Sheets 읽기 전용 연결

현재는 실제 읽기·검증을 수행하는 어댑터와 CLI까지 구현했습니다. 자동 polling·snapshot 저장·회원 정책 반영은 아직 활성화하지 않았습니다. 실제 학교 학번을 검증하는 어댑터와 명부 매칭을 함께 완성한 뒤 연결합니다.

Google Cloud에서 Sheets API를 활성화한 서비스 계정이 필요합니다. 별도의 연동용 스프레드시트를 만들고 그 계정 이메일에 Viewer 권한만 부여합니다. 다른 민감한 탭이 있는 원본 문서 전체를 공유하는 대신 필요한 네 열만 내보내는 문서를 권장합니다. 범위 지정은 읽는 자료를 제한하지만 서비스 계정의 문서 접근권 자체를 탭별로 제한하지는 않습니다.

연동용 범위의 첫 행은 다음 네 열이며 순서도 동일해야 합니다.

| student_id | status | role_label | server_ids |
|---|---|---|---|
| 99990001 | active | 개발회원 | lobby,survival |
| 99990002 | inactive | | |

위 학번은 테스트용입니다. 학번 열은 텍스트로 저장합니다. status는 active/inactive/suspended만 허용하고 inactive/suspended에는 server_ids를 비웁니다. role_label은 24자 이하이며 태그·제어문자를 허용하지 않습니다. 중복 학번·알 수 없는 서버·빈 명부·5,000명 초과는 snapshot 전체를 거부합니다. 실제 시트의 열 이름이 다르면 원본을 바꾸기 전에 별도 뷰 또는 명시적인 매핑을 정합니다.

```sh
# .env에 다음 항목을 로컬로만 설정
# SHEETS_SPREADSHEET_ID=<연동용 문서 ID>
# SHEETS_RANGE=Passport!A1:D5001
# GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/google-service-account.json
# ROSTER_MATCHING_SECRET=<32자 이상의 별도 임의 키>
node --env-file=.env dist/sheets-check.js
```

성공 시 출력은 `status:validated_only`, 총 인원·active 인원, `databaseChanged:false`뿐입니다. 서비스 계정, 학번, 회원 행, 응답 오류 원문을 출력하지 않습니다. 명부 매칭 결과는 HMAC 키로 변환하나 메모리의 원본 HTTP 응답까지 완전히 제거한다는 보장은 하지 않습니다. 실제 자료는 파일로 저장하지 않습니다. 매칭 키를 변경하면 모든 키가 달라지므로 향후 전환 절차가 필요합니다.

명부 자동 반영을 추가할 때에는 이전 active 인원의 20%를 넘는 일괄 회수를 수동 검토 대상으로 처리하는 검사 함수를 사용합니다. 이 함수가 현재 운영 회원 정책에 적용되고 있다는 뜻은 아닙니다. 오류 시 마지막 검증 snapshot을 보존하고 그 freshness를 넘는 허가를 발급하지 않는 transaction과 scheduler가 후속 작업입니다.

- [Google Sheets values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)
- [Google 공식 Node 인증 라이브러리](https://docs.cloud.google.com/nodejs/docs/reference/google-auth-library/latest)
