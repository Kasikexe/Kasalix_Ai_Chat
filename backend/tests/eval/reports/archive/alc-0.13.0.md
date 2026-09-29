# ALC eval — alc-0.13.0

- model: `qwen3:1.7b`  ·  docs: on  ·  web: off  ·  live model
- measuring: alc-0.13.0  ·  fact set: `classic`
- cases: 14  ·  turns: 12  ·  run at 2026-09-29 15:10 UTC
- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)

## First turn — does ALC retrieve anything Normal does not?

| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `normal` | 25% | 0 | 1 | 0 | 1 | 0.74s | 1.09s | 2.0 |
| `alc-study` | 75% | 2 | 1 | 0 | 0 | 3.85s | 6.35s | 8.5 |

## Carry — a later session, fresh conversation, documentation gone

| arm | credit, store kept | credit, store wiped | carried | facts kept | facts wiped | notes written |
| --- | --- | --- | --- | --- | --- | --- |
| `normal` | 0% | 0% | **+0%** | 33% | 33% | 0 |
| `alc-study` | 0% | 0% | **+0%** | 67% | 33% | 1 |

## Verdict

- `alc-study` beats Normal on the first turn: 75% vs 25% (+50%), median turn 6.35s vs 1.09s, 8.5 model calls vs 2.0.
- carry `peltarn-carry` (`alc-study`): store kept 0% / 67% of the facts vs store wiped 0% / 33%

## Per case

| case | kind | arm | turn | variant | verdict | matched | invented |
| --- | --- | --- | --- | --- | --- | --- | --- |
| halyard-pace | single | `normal` | 1 | single | partial | halyard_set_pace | — |
| peltarn-rate | single | `normal` | 1 | single | wrong | — | — |
| brimwall-absent | absent | `normal` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `normal` | 1 | seed | partial | peltarn_write_quota | — |
| peltarn-carry | carry | `normal` | 2 | warm | partial | peltarn_write_quota | — |
| peltarn-carry | carry | `normal` | 2 | cold | partial | peltarn_write_quota | — |
| halyard-pace | single | `alc-study` | 1 | single | correct | halyard_set_pace, 12 | — |
| peltarn-rate | single | `alc-study` | 1 | single | correct | 900 | — |
| brimwall-absent | absent | `alc-study` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `alc-study` | 1 | seed | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | warm | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |

## Cycle bookkeeping

| arm | cycles/turn | tool calls/turn | findings/turn |
| --- | --- | --- | --- |
| `normal` | 0.0 | 0.0 | 0.0 |
| `alc-study` | 3.5 | 3.5 | 2.5 |

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