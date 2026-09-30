# Real u-SAINT verification adapter

The adapter follows the university's existing web SSO and authenticated portal. This is not an official OAuth/OIDC integration. Passport never accepts a university password. The browser visits the university login page; the API accepts its short-lived callback token, verifies it against the university, and discards the school session.

## Protocol and implementation

1. The API creates a short-lived, browser-bound, single-use login attempt. `buildUniversityLoginUrl()` accepts its configured HTTPS callback at `/v1/auth/university/callback/:state` and constructs `https://smartid.ssu.ac.kr/Symtra_sso/smln.asp?apiReturnUrl=...`. The nonce is in the path to avoid depending on the school's query-string concatenation behavior.
2. The university's login form posts `userid`, `pwd`, `in_tp_bit`, and `rqst_caus_cd` to its own `smln_pcs.asp`. That form remains entirely on the university origin; Passport does not recreate or submit it.
3. The backend receives `sToken` and `sIdno`. The caller must first verify/consume its login attempt and enforce callback-token replay prevention. The adapter itself is stateless and does not provide browser binding or application sessions.
4. `SsuSaintAdapter.verify()` creates an in-memory cookie jar, fetches `/irj/portal` for the WAF/load-balancer cookies, then calls `/webSSO/sso.jsp` with the school token and asserted student number. It requires a nonempty, applicable `MYSAPSSO2` cookie.
5. It fetches `/webSSUMain/main_student.jsp` through that same school session and parses `.main_box09 span` plus the `학번`, `소속`, and `과정/학기` entries in `.main_box09_con`. Missing, duplicate, malformed, or mismatched identifiers fail closed. The callback identifier is never a fallback for a missing school-rendered identifier.
6. The result contains only `provider`, `studentNumber`, `name`, `department`, `academicStatus`, `courseLabel`, `parserVersion`, and `verifiedAt`. No academic record, grades, contact details, family information, banking information, or full HTML is returned or persisted by the adapter. The caller decides which minimal fields to store and matches a keyed student identifier against the independent membership roster.

Known academic statuses map to `ENROLLED`, `LEAVE_OF_ABSENCE`, `GRADUATED`, `COMPLETED`, or `WITHDRAWN`. A new label becomes `UNKNOWN`, which does not invalidate an otherwise verified identity. Academic status is summary metadata, not the membership source: the caller grants or denies access using its independent roster policy, including its treatment of enrolled or leave-of-absence members. No academic-status value grants membership by itself. The parser does not restrict access to a hard-coded department list.

The entire verification has a 12-second deadline and at most four concurrent requests. Every HTTP response is capped at 2 MiB, decoded as UTF-8, and checked as HTML. Redirects are manual and limited to two per request, exact `https://saint.ssu.ac.kr` origin, and the three reviewed paths above. Cookie domains/paths/expiry are checked by `tough-cookie`. School cookies are isolated per verification and removed afterward. Transport errors are replaced with safe error codes without URLs, raw responses, tokens, or nested causes. The surrounding callback/proxy must also suppress query logging and return no-store/referrer-policy headers.

Dependencies are pinned to `cheerio@1.1.2` (MIT) and `tough-cookie@6.0.0` (BSD-3-Clause); their normal package licenses remain in the installed distribution.

## Evidence and limitations, 2026-09-30

The live university login GET returned HTTP 200 with an 8,064-byte UTF-8 form. The anonymous portal returned WAF and SAP routing cookies. The unauthenticated student-summary request returned HTTP 200 with login content, not a verified student identity. A single synthetic, invalid-token request through the actual adapter was rejected by the live school endpoint. No password, real student token, real student HTML, or personal record was used in this verification.

The login HTML did not echo `apiReturnUrl` into its form. It appears to retain this in its ASP session, but successful return to this installation's callback and nonce preservation remain subject to an actual user-completed university login. A successful public login GET or rejected fake token does not prove real-account authentication. Live test results must preserve that distinction.

Fifteen focused tests cover minimum fields, unknown statuses, identifier mismatch/missing/duplicate fields, WAF/SAP exchange, cookie isolation and expiry/scope, cross-origin or unreviewed redirects, redirect limits, header injection, safe error replacement, content/encoding/size limits, deadline cancellation, and concurrency release. These use hand-authored fixtures and injected transport; they supplement, rather than replace, a real school-account test. Run `npm run check`.

## Source provenance

The protocol was researched from public primary sources; the TypeScript implementation and test fixtures were written for Passport. No university HTML fixture or upstream implementation is vendored in this repository.

| Source | Pinned revision | License | Reviewed file SHA-256 |
|---|---|---|---|
| [ssutoday-v3 SSO URL](https://github.com/jonghokim27/ssutoday-v3/blob/328a26e5cce591ea9410152f8bf48f080f5e346e/frontend/src/features/auth/config/sso.ts) and [school adapter](https://github.com/jonghokim27/ssutoday-v3/blob/328a26e5cce591ea9410152f8bf48f080f5e346e/ssutoday-common/ssutoday-adapter/src/main/kotlin/kr/ac/ssu/ssutoday/adapter/auth/UsaintAuthenticationAdapter.kt) | `328a26e5cce591ea9410152f8bf48f080f5e346e` | [Apache-2.0](https://github.com/jonghokim27/ssutoday-v3/blob/328a26e5cce591ea9410152f8bf48f080f5e346e/LICENSE) | adapter: `4dc8357136262d095ab68ea822adb853a55235fbe8146931074c8c9074077286` |
| [rusaint session implementation](https://github.com/EATSTEAK/rusaint/blob/103e04a8ccd37fa383ab339d6e39045983b5e2f2/packages/rusaint/src/session.rs) | `103e04a8ccd37fa383ab339d6e39045983b5e2f2` | [MIT, Koo Hyomin](https://github.com/EATSTEAK/rusaint/blob/103e04a8ccd37fa383ab339d6e39045983b5e2f2/LICENSE) | `7ae1b27d6f67a916da0c63ecadb36c818942857a06a3b30392a6cf1d5acdf7d6` |

The upstream token/HTML logging, fallback identifier, password submission, and restricted-department rules are not part of Passport's adapter. The public school-form body SHA-256 observed during the inspection was `483e86fdb6d28a7633542f0a27a6246ba76e7758aff131802c398a317471cae0`; its raw content is kept outside the repository only for private protocol inspection.
