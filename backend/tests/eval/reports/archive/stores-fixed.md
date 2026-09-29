# ALC eval — stores-fixed

- model: `qwen3:1.7b`  ·  docs: on  ·  web: off  ·  live model
- cases: 14  ·  turns: 3  ·  run at 2026-09-29 14:05 UTC
- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)

## First turn — does ALC retrieve anything Normal does not?

| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `alc-study` | 0% | 0 | 0 | 0 | 0 | 6.57s | 7.41s | 7.0 |

## Carry — a later session, fresh conversation, documentation gone

| arm | credit, store kept | credit, store wiped | carried | facts kept | facts wiped | notes written |
| --- | --- | --- | --- | --- | --- | --- |
| `alc-study` | 0% | 0% | **+0%** | 67% | 33% | 1 |

## Verdict

- `alc-study` is level with Normal on the first turn: 0% vs 0% (+0%), median turn 7.41s vs 0.0s, 7.0 model calls vs 0.0.
- carry `peltarn-carry` (`alc-study`): store kept 0% / 67% of the facts vs store wiped 0% / 33%

## Per case

| case | kind | arm | turn | variant | verdict | matched | invented |
| --- | --- | --- | --- | --- | --- | --- | --- |
| peltarn-carry | carry | `alc-study` | 1 | seed | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | warm | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |

## Cycle bookkeeping

| arm | cycles/turn | tool calls/turn | findings/turn |
| --- | --- | --- | --- |
| `alc-study` | 3.0 | 3.0 | 1.0 |

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