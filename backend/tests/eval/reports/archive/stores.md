# ALC eval — stores

- model: `qwen3:1.7b`  ·  docs: on  ·  web: off  ·  live model
- cases: 14  ·  turns: 12  ·  run at 2026-09-29 14:00 UTC
- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)

## First turn — does ALC retrieve anything Normal does not?

| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `alc-raw` | 100% | 2 | 0 | 0 | 0 | 6.53s | 6.75s | 7.0 |
| `alc-study` | 0% | 0 | 0 | 0 | 0 | 3.95s | 5.32s | 7.5 |

## Carry — a later session, fresh conversation, documentation gone

| arm | credit, store kept | credit, store wiped | carried | facts kept | facts wiped | notes written |
| --- | --- | --- | --- | --- | --- | --- |
| `alc-raw` | 0% | 0% | **+0%** | 42% | 17% | 5 |
| `alc-study` | 0% | 0% | **+0%** | 58% | 17% | 2 |

## Verdict

- `alc-raw` beats Normal on the first turn: 100% vs 0% (+100%), median turn 6.75s vs 0.0s, 7.0 model calls vs 0.0.
- `alc-study` is level with Normal on the first turn: 0% vs 0% (+0%), median turn 5.32s vs 0.0s, 7.5 model calls vs 0.0.
- carry `peltarn-carry` (`alc-raw`): store kept 0% / 33% of the facts vs store wiped 0% / 33%
- carry `halyard-carry` (`alc-raw`): store kept 0% / 50% of the facts vs store wiped 0% / 0%
- carry `peltarn-carry` (`alc-study`): store kept 0% / 67% of the facts vs store wiped 0% / 33%
- carry `halyard-carry` (`alc-study`): store kept 0% / 50% of the facts vs store wiped 0% / 0%

## Per case

| case | kind | arm | turn | variant | verdict | matched | invented |
| --- | --- | --- | --- | --- | --- | --- | --- |
| peltarn-carry | carry | `alc-raw` | 1 | seed | correct | peltarn_write_quota, 7, 900 | — |
| peltarn-carry | carry | `alc-raw` | 2 | warm | ⚠️ invented | peltarn_write_quota | 1000 |
| peltarn-carry | carry | `alc-raw` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |
| halyard-carry | carry | `alc-raw` | 1 | seed | correct | 12, 240 | — |
| halyard-carry | carry | `alc-raw` | 2 | warm | partial | 12 | — |
| halyard-carry | carry | `alc-raw` | 2 | cold | ⚠️ invented | — | 60 |
| peltarn-carry | carry | `alc-study` | 1 | seed | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | warm | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-study` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |
| halyard-carry | carry | `alc-study` | 1 | seed | partial | 12 | — |
| halyard-carry | carry | `alc-study` | 2 | warm | partial | 12 | — |
| halyard-carry | carry | `alc-study` | 2 | cold | ⚠️ invented | — | 16, 255 |

## Cycle bookkeeping

| arm | cycles/turn | tool calls/turn | findings/turn |
| --- | --- | --- | --- |
| `alc-raw` | 4.0 | 4.0 | 2.5 |
| `alc-study` | 3.5 | 3.5 | 1.0 |

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