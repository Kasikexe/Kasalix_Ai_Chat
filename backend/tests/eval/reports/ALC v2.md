# ALC eval — ALC v2

- model: `qwen3:1.7b`  ·  docs: on  ·  web: off  ·  live model
- measuring: ALC v2  ·  fact set: `classic`
- cases: 14  ·  turns: 36  ·  run at 2026-09-29 15:14 UTC
- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)

## First turn — does ALC retrieve anything Normal does not?

| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `normal` | 7% | 0 | 1 | 3 | 6 | 0.71s | 1.06s | 2.0 |
| `alc-study` | 86% | 11 | 1 | 0 | 1 | 3.93s | 5.88s | 8.5 |

## Carry — a later session, fresh conversation, documentation gone

| arm | credit, store kept | credit, store wiped | carried | facts kept | facts wiped | notes written |
| --- | --- | --- | --- | --- | --- | --- |
| `normal` | 0% | 0% | **+0%** | 17% | 17% | 0 |
| `alc-study` | 50% | 0% | **+50%** | 83% | 17% | 3 |

## Verdict

- `alc-study` beats Normal on the first turn: 86% vs 7% (+79%), median turn 5.88s vs 1.06s, 8.5 model calls vs 2.0.
- carry `peltarn-carry` (`alc-study`): store kept 0% / 67% of the facts vs store wiped 0% / 33%
- carry `halyard-carry` (`alc-study`): store kept 100% / 100% of the facts vs store wiped 0% / 0%

## Per case

| case | kind | arm | turn | variant | verdict | matched | invented |
| --- | --- | --- | --- | --- | --- | --- | --- |
| halyard-pace | single | `normal` | 1 | single | partial | halyard_set_pace | — |
| halyard-mode | single | `normal` | 1 | single | wrong | — | — |
| halyard-drift | single | `normal` | 1 | single | wrong | — | — |
| halyard-retry | single | `normal` | 1 | single | ⚠️ invented | — | 60, 10 |
| halyard-max | single | `normal` | 1 | single | partial | halyard_max_frames | — |
| quorvex-4513 | single | `normal` | 1 | single | partial | quorvex-4513 | — |
| quorvex-version | single | `normal` | 1 | single | wrong | — | — |
| quorvex-path | single | `normal` | 1 | single | wrong | — | — |
| peltarn-rate | single | `normal` | 1 | single | wrong | — | — |
| quorvex-lease-floor | multi_hop | `normal` | 1 | single | partial | quorvex_lease_floor | — |
| vintra-pace | conflict | `normal` | 1 | single | wrong | — | — |
| brimwall-absent | absent | `normal` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `normal` | 1 | seed | ⚠️ invented | peltarn_write_quota | 1000 |
| peltarn-carry | carry | `normal` | 2 | warm | partial | peltarn_write_quota | — |
| peltarn-carry | carry | `normal` | 2 | cold | partial | peltarn_write_quota | — |
| halyard-carry | carry | `normal` | 1 | seed | ⚠️ invented | — | 100, 255 |
| halyard-carry | carry | `normal` | 2 | warm | wrong | — | — |
| halyard-carry | carry | `normal` | 2 | cold | wrong | — | — |
| halyard-pace | single | `alc-study` | 1 | single | correct | halyard_set_pace, 12 | — |
| halyard-mode | single | `alc-study` | 1 | single | correct | halyardmode.glide | — |
| halyard-drift | single | `alc-study` | 1 | single | correct | loose | — |
| halyard-retry | single | `alc-study` | 1 | single | correct | 45 | — |
| halyard-max | single | `alc-study` | 1 | single | correct | halyard_max_frames, 240, clamp | — |
| quorvex-4513 | single | `alc-study` | 1 | single | correct | quorvex-4513, lease | — |
| quorvex-version | single | `alc-study` | 1 | single | correct | 3.14.2 | — |
| quorvex-path | single | `alc-study` | 1 | single | correct | pkg/quorvex/adapters/tide.py | — |
| peltarn-rate | single | `alc-study` | 1 | single | correct | 900 | — |
| quorvex-lease-floor | multi_hop | `alc-study` | 1 | single | correct | quorvex_lease_floor, 9 | — |
| vintra-pace | conflict | `alc-study` | 1 | single | wrong | — | — |
| brimwall-absent | absent | `alc-study` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `alc-study` | 1 | seed | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | warm | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |
| halyard-carry | carry | `alc-study` | 1 | seed | correct | 12, 240 | — |
| halyard-carry | carry | `alc-study` | 2 | warm | correct | 12, 240 | — |
| halyard-carry | carry | `alc-study` | 2 | cold | ⚠️ invented | — | 60 |

## Cycle bookkeeping

| arm | cycles/turn | tool calls/turn | findings/turn |
| --- | --- | --- | --- |
| `normal` | 0.0 | 0.0 | 0.0 |
| `alc-study` | 4.0 | 3.5 | 2.0 |

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