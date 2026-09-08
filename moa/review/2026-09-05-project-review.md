# Orca MoA 프로젝트 리뷰 (2026-09-05)

외주 IT 리뷰어 관점의 상세 점검. 대상은 `feat/moa-deliberation-ledger` 브랜치(커밋 2개, 23파일), 코디네이터 스킬(`.claude/skills/moa/`), 설계 문서(`moa/design/`), 도그푸드 산출물(`moa/ledger-storage/`), 그리고 저장소 위생.

## 0. 검증 방법 (실제로 실행한 것)

| 항목 | 결과 |
|---|---|
| `vitest` — 신규 테스트 4파일 (store 9 + RPC 4 + CLI 4 + registry) | 35/35 통과 |
| `vitest` — CLI parity/vocabulary/manifest/index 4파일 | 49/49 통과 |
| `tsc -p config/tsconfig.node.json` | **실패: 8 errors**, 전부 `moa-ledger-store.ts` |
| `tsc -p config/tsconfig.cli.json` | 통과 |
| `oxlint` (변경 파일) | 통과 |
| `git merge-tree upstream/main HEAD` (드라이런) | **6개 파일 충돌** |
| SQLite NULL 정렬 재현 스크립트 (node:sqlite) | P1-1 재현됨 |
| `ajv`로 `ledger.json` ↔ `ledger.schema.json` 검증 | valid=true 이지만 구조 이탈 존재 (S-3) |

## 1. 요약 — 심각도별

| 등급 | 항목 | 한 줄 |
|---|---|---|
| **P0** | P0-1 | `pnpm typecheck` 실패. `typeof moa` 타입 캡처가 흐름 좁힘(null)을 물고 들어가 `never`가 됨. 테스트는 타입을 벗겨서 통과했을 뿐 |
| **P0** | P0-2 | upstream이 이미 **schema v30**을 다른 용도(dispatch `depth` 컬럼)로 사용 중. 로컬 main은 upstream보다 1,114커밋 뒤. v31로 재번호 + 리베이스 필수 |
| **P1** | P1-1 | `authored_at` NULL 행이 라운드 안에서 항상 맨 앞으로 정렬됨 → "누가 먼저 말했나" 오표시 |
| **P1** | P1-2 | `payload.moa` ingest는 발신자↔seat 결속이 없음. 어떤 참가자든 다른 seat 이름으로 verdict를 쓸 수 있음 |
| **P1** | P1-3 | 스킬(v2)이 새 store를 전혀 안 씀 → PR1의 "end-to-end 검증" 증거가 생길 경로가 없음 |
| **P1** | P1-4 | `moa-log`가 삽입된 entry id를 안 돌려줌 → verdict의 `--target`에 쓸 proposal id를 얻으려면 `moa-show`를 다시 파싱해야 함 |
| **P1** | P1-5 | `moa_deliberations.id`가 **전역** PK → 다른 Run에서 같은 슬러그(`design`, `ledger-storage`)를 못 씀 |
| **P2** | P2-1 ~ P2-9 | seatCount drift 무시, RPC 숫자 검증 누락, ingest 무음 실패, 주석 과장, rowid 커서, `--payload` 모순, 문서/가이드 누락, 테스트 공백 |
| **S** | S-1 ~ S-7 | 스킬 프로토콜 논리: 수렴 규칙 약함, merge 베이스 미표현, 스키마가 구조 이탈을 못 잡음, tabs 모드에서 집계가 비는 규칙 버그 등 |
| **D/H** | D-1 ~ H-3 | 설계문서↔구현 불일치, 저장소 위생(`.debate-war/`, `moa/` 미추적) |

---

## 2. 코드 — P0

### P0-1. typecheck 실패 (CI 블로커)

- 위치: `src/main/runtime/orchestration/db/moa-ledger/moa-ledger-store.ts` `ingestMoaMessagePayload` (tsc 보고: 190, 194, 209–211행).
- 증상: `Property 'deliberation' does not exist on type 'never'` ×8.
- 원인:
  ```ts
  let moa: { deliberation?: unknown; ... } | null = null      // 초기화로 null로 좁혀짐
  const parsed = JSON.parse(payload) as { moa?: typeof moa }  // 타입 위치의 typeof는 "좁혀진" 타입(null)을 잡음
  moa = parsed?.moa ?? null                                   // 따라서 moa는 여전히 null
  if (!moa || ...) return 0                                   // 이후 moa는 never
  ```
  TypeScript의 타입 쿼리 `typeof x`는 그 지점의 흐름 좁힘 결과를 사용한다. 격리 재현(`scratchpad/narrowing-repro.ts`)에서 동일 에러 확인, 아래 수정으로 클린 컴파일 확인.
- 수정:
  ```ts
  type MoaMessagePayload = { deliberation?: unknown; taskId?: unknown; seatCount?: unknown; entries?: unknown }
  let moa: MoaMessagePayload | null = null
  const parsed = JSON.parse(message.payload) as { moa?: MoaMessagePayload | null }
  ```
- 왜 테스트가 못 잡았나: vitest(esbuild)는 타입을 검사하지 않고 벗겨낸다. PR 전 체크리스트에 `pnpm typecheck`를 반드시 넣을 것 (CONTRIBUTING은 `pnpm test`만 언급).

### P0-2. upstream schema v30 충돌 + 1,114커밋 drift

- 사실: `upstream/main`의 `SCHEMA_VERSION = 30`(dispatch_contexts/remote_dispatch_attachments에 `depth` 컬럼), 파일도 `migrate-v13-v29.ts` → `migrate-v13-v30.ts`로 개명됨. 로컬 `main`은 2026-08-23 동기화 이후 1,114커밋 뒤.
- 실제 피해 시나리오: 이 브랜치로 DB가 v30이 된 사용자가 나중에 upstream 빌드로 올라가면 `current(30) >= SCHEMA_VERSION(30)` → 마이그레이션 스킵 → `depth` 컬럼 없는 채로 "v30"이라 주장 → upstream 코드가 `depth`를 읽는 순간 SQL 에러. (반대 방향은 `createTables`의 `CREATE TABLE IF NOT EXISTS`가 moa 테이블을 만들어 주므로 우연히 살아남음.)
- 충돌 파일 6개: `src/cli/handlers/orchestration.ts`, `src/cli/help.ts`, `db/contract-constants.ts`, `db/schema/migrate.ts`, `rpc/methods/orchestration-runs.test.ts`, `rpc/methods/orchestration.ts`.
- 수정 절차:
  1. `git fetch upstream && git push origin upstream/main:main` (gh 토큰에 workflow scope가 없어 `gh repo sync`는 불가 — 로컬 git으로).
  2. 브랜치를 `upstream/main` 위로 리베이스.
  3. `migrate-v30-moa-ledger.ts` → `migrate-v31-moa-ledger.ts`, `SCHEMA_VERSION = 31`, 주석에 `v31 MoA deliberation ledger`, 마이그레이션 테스트도 "pre-v31" (29→30 대신 30→31, 필요하면 `depth` 컬럼 존재까지 함께 assert).
  4. CLI 헬퍼 위치가 바뀜: `resolveCoordinatorTerminalHandle`은 `src/cli/handlers/orchestration/terminal-identity.ts`, `callMutation`은 `orchestration/mutation-request.ts`의 `callOrchestrationMutation`. upstream은 핸들러를 `src/cli/handlers/orchestration/*-handlers.ts`로 분할했고 handler group은 `orchestration` 하나뿐이므로, 별도 `orchestration-moa` 그룹 대신 `orchestration/moa-handlers.ts`로 옮겨 `gate-handlers.ts`와 같은 import 패턴을 따를 것. `orchestration.ts`의 `export` 추가 두 줄은 불필요해짐.
  5. registry 개수 테스트: upstream 39 → 41.
- 프로세스 교훈: PR 직전마다 `git merge-tree --write-tree upstream/main HEAD`로 드라이런. 스키마 번호는 리베이스 직후에 확정.

---

## 3. 코드 — P1

### P1-1. `authored_at` NULL 정렬 왜곡

- `listMoaEntries`는 `ORDER BY round, authored_at, id`. SQLite는 ASC에서 NULL을 맨 앞에 둔다. `--authored-at`을 생략한 CLI 단일 entry(기본 경로)는 라운드 내에서 **항상 첫 발언자**로 표시된다.
- 재현(node:sqlite): `cli-note-later(NULL, 나중 기록)`, `seat-A(10:01)`, `seat-B(10:05)` → 현재 정렬 `cli-note-later, seat-A, seat-B`; `COALESCE(authored_at, recorded_at)`이면 `seat-A, seat-B, cli-note-later`.
- 이는 설계의 핵심 주장("federation에서도 작성 순서로 표시")을 정면으로 깨뜨린다.
- 수정(권장): store가 삽입 시 `authoredAt ?? <UTC now>`로 채운다 — 스키마/인덱스 무변경. 대안은 `ORDER BY ... COALESCE(authored_at, recorded_at)` + 표현식 인덱스.
- 추가: `authored_at`은 형식 검증이 없다. `+09:00` 오프셋과 `Z`가 섞이면 문자열 정렬이 틀어진다. `assertValidEntry`에서 파싱 실패 시 거부하고 UTC ISO로 정규화(기존 `db/utc-timestamp.ts` 재사용).

### P1-2. seat 스푸핑 — 발신자와 seat 라벨의 결속 없음

- `insertMessage` → `ingestMoaMessagePayload`: `status` 메시지면 `payload.moa.entries[].seat`를 그대로 저장. federation relay import도 같은 경로. `seat_id`는 발신자가 주장하는 임의 문자열.
- 결과: 한 seat가 `seat: "seat-B"`로 verdict를 써넣어도 구분 불가. 설계문서의 "anonymized seat_id"는 프라이버시 목적이지 무결성 장치가 아니다.
- PR1 범위의 현실적 수정: (a) 신뢰 모델을 문서화("home runtime은 Run 참가자를 신뢰; seat 귀속은 코디네이터가 단언"), (b) `moa-show --json`에 `message_id` JOIN으로 `from_handle`을 노출해 사후 감사 가능하게, (c) 서버측 seat↔dispatch 결속은 블루프린트 PR3에 명시. 지금 코드는 (b)조차 없어서 감사가 안 된다.

### P1-3. 스킬이 새 store를 쓰지 않음 (도그푸드 공백)

- `SKILL.md` v2는 여전히 `moa/<slug>/ledger.json`만 쓰고 `moa-log`/`moa-show`를 한 번도 호출하지 않는다. PR1을 "end-to-end 검증 후 재제출"로 내렸는데, 검증이 생길 경로가 코드에도 스킬에도 없다.
- 수정: 스킬을 **dual-write**로 — ledger.json에 append할 때마다 `orca orchestration moa-log --deliberation <slug> --entries-file moa/<slug>/entries-<phase>.json --json`, Phase 4에서 `moa-show --deliberation <slug> --json`과 ledger.json을 대조해 차이를 `protocol_note`로 기록. 매핑:

  | 스킬 ledger | store entry |
  |---|---|
  | proposal `p-A` | `kind=proposal, round=1, seat=seat-A, rationale=idea, payload={key_points,confidence,report}` |
  | round r verdict from A on B | `kind=verdict, round=r, seat=seat-A, subjectEntryId=<p-B의 moae id>, verdict, rationale, payload={merge_with}` |
  | rankings/concessions | `kind=note, round=r, seat, payload={ranking, concede_own, derived}` |
  | resolution.adopted / rejected[] | `kind=outcome, verdict=adopted|rejected, subjectEntryId, rationale, payload={votes,unanimous}` |
  | 종료 | `kind=close, payload={resolution_forced_by, dissent, chair_additions}` |

  이 매핑을 해보면 P1-4(id 반환)와 P1-5(슬러그 전역 유일성)가 즉시 걸린다 — 즉 도그푸드가 필요한 이유 그 자체.

### P1-4. `moa-log`가 entry id를 반환하지 않음

- `logMoaEntries`는 `{inserted, duplicates}` 개수만 반환. verdict/outcome은 `subjectEntryId`로 proposal 행을 가리켜야 하는데, id는 서버가 해시로 만들기 때문에 클라이언트는 `moa-show`를 다시 호출해 필드 조합으로 찾아야 한다.
- 수정: `entries: { id, inserted: boolean }[]`를 입력 순서대로 반환. 해시는 결정적이므로 이미 계산돼 있다. CLI 텍스트 출력에도 id를 찍을 것.

### P1-5. deliberation id의 전역 유일성

- `moa_deliberations.id TEXT PRIMARY KEY` + `openMoaDeliberation`의 "belongs to another Run" 예외. 테스트 `refuses to reuse a deliberation id from another run`이 이 동작을 고정하고 있다.
- 실제 사용에서는 슬러그가 자연어(`ledger-storage`, `auth-design`)라서 두 번째 Run부터 충돌한다. 설계문서는 "content-addressed"라고 적었지만 구현은 호출자 지정 id다(D-1).
- 수정: PK를 `(run_id, id)`로 하거나, 저장 키를 `run_id:id` 형태로 합성하고 조회는 run 범위에서. 어느 쪽이든 `getMoaDeliberation(id)`는 `(runId, id)`로 시그니처를 바꿔야 하고, `moaShow`의 "foreign run은 not found" 로직이 자연스럽게 정리된다.

---

## 4. 코드 — P2/P3

- **P2-1 seatCount/taskId drift 무시**: `INSERT OR IGNORE`라 두 번째 호출의 다른 `seatCount`는 조용히 버려진다. 엄격 경로(RPC)에서는 기존 행과 다르면 `invalid_argument`로 거부, ingest 경로에서만 무시.
- **P2-2 RPC 숫자 검증**: `MoaShowParams.round`, `MoaLogParams.seatCount`가 `OptionalFiniteNumber` — 0/음수/소수 허용. CLI는 걸러도 RPC는 UI 등 다른 클라이언트가 직접 부른다. `z.number().int().positive().optional()`로.
- **P2-3 에러 타입**: `moaShow`는 plain `Error`, `moaLog`는 `OrchestrationError('invalid_argument')`. 이웃(gates)도 plain Error를 쓰니 관례 위반은 아니지만 `--json` 호출자가 안정적인 `code`를 못 받는다. 가능하면 `OrchestrationError`로 통일.
- **P2-4 ingest 무음 실패**: `ingestMoaMessagePayload`는 모든 실패를 `0`으로 삼킨다(다른 Run 소속, SQL 오류 포함). "전달은 절대 실패시키지 않는다"는 옳지만 진단 불가. `{inserted, skipped: 'not_status'|'malformed'|'invalid_entry'|'store_error'}`를 반환하고, `send` RPC의 기존 warnings 채널(`SendRecipientWarning`)에 실어 보낼 것. db/ 계층에는 로깅 선례가 없으니 로그는 넣지 말 것.
- **P2-5 주석 과장**: "same transaction scope as its provenance row" — `insertMessage` 단독 호출은 savepoint가 없어 메시지 INSERT가 먼저 autocommit된다. ingest가 throw하지 않아 실해는 없지만, 주석을 고치거나 `insertMessage` 전체를 savepoint로 감쌀 것.
- **P2-6 `rowid AS recorded_seq`**: INTEGER PRIMARY KEY가 아닌 테이블의 rowid는 `VACUUM`에서 재번호될 수 있다. 현재 Orca는 VACUUM을 안 하므로(정규식 한 줄뿐) 당장 안전. "커서 전용, VACUUM 도입 시 컬럼화" 주석 추가.
- **P2-7 CLI `--payload <json>`**: 파일 헤더 주석("PowerShell이 JSON을 망가뜨리니 셸 JSON 금지")과 모순. 단일 entry 모드에서 `--payload`를 빼거나 `--payload-file`로.
- **P2-8 문서/가이드 누락**: 에이전트가 실제로 읽는 `skill-guides/orchestration.md`에 gate 동사는 있고 moa 동사는 없다 → 코디네이터가 `moa-log`를 발견할 수 없다. 섹션 추가 후 bundled-skill-guides 재생성 — 안 하면 `verify:bundled-skill-guides`가 lint에서 실패.
- **P2-9 테스트 공백**: (1) NULL `authored_at` 정렬(P1-1을 잡았을 테스트), (2) federation relay import 경로를 통한 materialize — "모든 경로가 여기로 모인다"는 주석의 증거, (3) `insertMessages` 배치 중 뒤쪽 메시지 실패 시 앞쪽 ledger 행이 롤백되는지(savepoint 중첩), (4) `moaLog --run <타 Run>` → `consumer_fenced`, (5) CLI `--entries-file` 테스트가 entries 내용을 assert하지 않음.

---

## 5. 스킬 프로토콜 논리 (`SKILL.md` v2, `ledger.schema.json`)

- **S-1 수렴 규칙이 약함**: "verified seat 중 challenge 0 → 수렴". 전원이 `merge`인데 서로 다른 베이스를 가리키면 베이스 없이 "수렴"한다. 규칙을 "challenge 0 **이고** 어떤 proposal이 strict majority(support 또는 merge-with-base)를 가짐"으로. 아니면 challenge 0이어도 rebuttal 라운드.
- **S-2 merge verdict에 `base`가 없음**: Phase 3 집계는 "merge-as-base"를 세지만 seat JSON(`merge_with: []`)은 무엇이 베이스인지 표현할 수 없다. 도그푸드 ledger에서 "B merge-as-base"는 chair가 ranking에서 추론한 것. verdict 계약에 `"base": "seat-X"` 추가.
- **S-3 스키마가 구조 이탈을 못 잡음**: 도그푸드 `ledger.json` round 1은 `verdicts`(2개) + `verdicts_seat_B`(2개) + `verdicts_seat_C`(2개)로 쪼개져 있다. LLM이 계약을 벗어났는데 `additionalProperties`가 열려 있어 ajv가 valid를 냈다. round/proposal/resolution 객체에 `additionalProperties: false`, Phase 4에 검증 단계 추가(의존성 없는 `validate-ledger.mjs`를 SKILL.md 옆에 두기 — 임의 프로젝트에는 ajv가 없다).
- **S-4 tabs 모드 집계가 빈다**: tabs 모드는 `verified: null`인데 Phase 3은 "verified seat만 집계". 그대로면 tabs 모드에서 집계 대상이 0명. `verified: 'self'` 3상태를 도입하고 self는 집계에 포함, `unanimous` 주장에서만 제외.
- **S-5 축퇴 케이스 미정의**: verified seat < 2이면 strict majority가 성립 불가. `resolution_forced_by`에 `insufficient_verified` 추가하고 chair 결정으로 명시.
- **S-6 rebuttal 라운드 스펙 템플릿 없음**: Phase 1/round 템플릿은 있으나 rebuttal("defend/amend/concede, challengers confirm/withdraw")은 산문뿐 → 코디네이터가 즉흥. JSON 계약 포함 템플릿 추가.
- **S-7 스킬 사본 2개**: 프로젝트 `.claude/skills/moa`(gitignored)와 `~/.claude/skills/moa`가 현재 동일하지만 동기화 장치가 없다. 프로젝트 쪽을 원본으로 두고 복사 스크립트 한 줄 또는 심링크.
- 소소: `seat` 패턴 `^seat-[A-Z]$`는 26석 한계(실용 상한 8이라 무해). `check --wait 540000` 반복에 전체 예산 상한이 없음 — 비용 안내 정도.

## 6. 설계 문서 ↔ 구현 불일치 (`moa/design/upstream-design.md`)

- **D-1** DDL 주석 `id -- content-addressed`(deliberations)는 구현과 다름(호출자 지정 슬러그). P1-5와 함께 정리.
- **D-2** DDL의 `recorded_seq INTEGER` 컬럼은 구현에서 `rowid` alias. 문서 갱신.
- **D-3** "Reset semantics: cleared by resetAll/resetTasks, untouched by resetMessages" — 구현·테스트 일치. 좋음.
- **D-4** 열린 질문 "run vs task 스코프" — 구현은 run 스코프 + 선택 task_id. 문서에 "결정됨"으로 표시.

## 7. 저장소 위생 / 프로세스

- **H-1** `.debate-war/state.db(+-wal,-shm)`가 Orca 클론 루트에 미추적으로 존재 — llm-debate-war MCP 서버가 cwd에 쓴 상태 DB. `moa/`와 함께 `.git/info/exclude`에 추가(로컬 전용; upstream `.gitignore`에는 넣지 말 것). WAL 파일이 남아 있어 실수로 `git add -A` 시 바이너리 3개가 커밋된다.
- **H-2** `moa/README.md` 표에 이 리뷰 경로 추가(반영함).
- **H-3** PR 재제출 전 게이트: 리베이스+v31 → typecheck 클린 → 스킬 dual-write로 1회 실제 컨소시엄 → `moa-show` 결과를 PR 본문 증거로. CONTRIBUTING §Pull Requests가 요구하는 "AI 코드리뷰 요약(크로스플랫폼·SSH·에이전트 호환·성능·보안)"은 이 문서의 P1-2(보안), P0-2(호환), P1-1(SSH/federation 순서)을 그대로 쓰면 된다.

## 8. 잘 된 점 (유지할 것)

- 저장소 관례를 정확히 따름: `attach*Store` 프로토타입 믹스인, savepoint 패턴, `resolveRunScope`/gateList와 동일한 read posture, 전용 create-sql 모듈, `CREATE TABLE IF NOT EXISTS`.
- 설계 결정이 근거와 함께 기록됨(왜 CHECK enum이 아닌지, 왜 messages를 WAL로 안 쓰는지, 왜 새 message type을 안 만드는지). wire-compat Rule 1 준수 확인.
- 도그푸드 산출물이 실제 실행에서 나왔고(3석, 1라운드 수렴), 프로토콜 마찰이 upstream primitive의 근거로 정리됨.
- 테스트가 행복 경로만 아니라 거부/롤백/리셋 범위/마이그레이션까지 다룸.

## 9. 권장 작업 순서

1. P0-1 타입 수정 (5분) → `pnpm typecheck`.
2. fork main 동기화 → 리베이스 → v31 재번호 → 충돌 6개 해소 → 핸들러를 `orchestration/moa-handlers.ts`로 이동 (반나절).
3. P1-5 (run 스코프 키) + P1-4 (id 반환) + P1-1 (authored_at 기본값·정규화) — 셋 다 스키마/API에 닿으므로 PR 제출 전에 한꺼번에.
4. P2-8 skill-guide 섹션 + 재생성, P2-9 테스트 보강.
5. 스킬 dual-write(P1-3) + S-1/S-2/S-4 규칙 수정 → 실제 컨소시엄 1회 → 증거 확보 → 이슈/PR 재제출 (사용자 최종 OK 후).
