# ALC eval — selftest-oracle

- model: `qwen3:1.7b`  ·  docs: on  ·  web: off  ·  SCRIPTED model (self-test)
- cases: 14  ·  turns: 6  ·  run at 2026-09-29 13:29 UTC
- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)

## First turn — does ALC retrieve anything Normal does not?

| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `normal` | 0% | 0 | 0 | 0 | 2 | 0.0s | 0.0s | 2.0 |
| `alc-none` | 100% | 3 | 0 | 0 | 0 | 0.01s | 0.01s | 5.0 |

## Carry — a later session, fresh conversation, documentation gone

| arm | store, warm | store, wiped | carried | notes written |
| --- | --- | --- | --- | --- |

## Verdict

- `alc-none` beats Normal on the first turn: 100% vs 0% (+100%), median turn 0.01s vs 0.0s, 5.0 model calls vs 2.0.

## Per case

| case | kind | arm | turn | variant | verdict | matched | invented |
| --- | --- | --- | --- | --- | --- | --- | --- |
| halyard-pace | single | `normal` | 1 | single | partial | halyard_set_pace | — |
| halyard-mode | single | `normal` | 1 | single | wrong | — | — |
| halyard-drift | single | `normal` | 1 | single | wrong | — | — |
| halyard-pace | single | `alc-none` | 1 | single | correct | halyard_set_pace, 12 | — |
| halyard-mode | single | `alc-none` | 1 | single | correct | halyardmode.glide | — |
| halyard-drift | single | `alc-none` | 1 | single | correct | loose | — |

## Cycle bookkeeping

| arm | cycles/turn | tool calls/turn | findings/turn |
| --- | --- | --- | --- |
| `normal` | 0.0 | 0.0 | 0.0 |
| `alc-none` | 2.0 | 1.0 | 4.0 |

## Corpus self-check

| case | kind | expected token present in its sources? |
| --- | --- | --- |
| halyard-pace | single | ✅ |
| halyard-mode | single | ✅ |
| halyard-drift | single | ✅ |
| halyard-retry | single | ✅ |
| halyard-max | single | ✅ |
| quorvex-4513 | single | ✅ |
| quorvex-version | single | ✅ |
| quorvex-path | single | ✅ |
| peltarn-rate | single | ✅ |
| quorvex-lease-floor | multi_hop | ✅ |
| vintra-pace | conflict | ✅ |
| brimwall-absent | absent | n/a (must stay unanswered) |
| peltarn-carry | carry | ✅ |
| halyard-carry | carry | ✅ |

_A ❌ means the fixture is wrong, not the arm: the harness would be asking for something its own sources do not say._