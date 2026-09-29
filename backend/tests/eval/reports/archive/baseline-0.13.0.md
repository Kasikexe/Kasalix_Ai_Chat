# ALC eval — baseline-0.13.0

- model: `qwen3:1.7b`  ·  docs: on  ·  web: off  ·  live model
- measuring: (untagged)  ·  fact set: `classic`
- cases: 14  ·  turns: 54  ·  run at 2026-09-29 13:32 UTC  ·  verdicts re-scored with the current scorer
- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)

## First turn — does ALC retrieve anything Normal does not?

| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `normal` | 7% | 0 | 1 | 1 | 7 | 0.72s | 1.09s | 2.0 |
| `alc-none` | 86% | 11 | 1 | 0 | 0 | 3.04s | 3.2s | 5.0 |
| `alc-heuristic` | 93% | 12 | 1 | 0 | 1 | 0.36s | 0.49s | 1.0 |

## Carry — a later session, fresh conversation, documentation gone

| arm | credit, store kept | credit, store wiped | carried | facts kept | facts wiped | notes written |
| --- | --- | --- | --- | --- | --- | --- |
| `normal` | 0% | 0% | **+0%** | 17% | 17% | 0 |
| `alc-none` | 0% | 0% | **+0%** | 17% | 17% | 0 |
| `alc-heuristic` | 0% | 0% | **+0%** | 17% | 17% | 0 |

## Verdict

- `alc-none` beats Normal on the first turn: 86% vs 7% (+79%), median turn 3.2s vs 1.09s, 5.0 model calls vs 2.0.
- `alc-heuristic` beats Normal on the first turn: 93% vs 7% (+86%), median turn 0.49s vs 1.09s, 1.0 model calls vs 2.0.
- carry `peltarn-carry` (`alc-heuristic`): store kept 0% / 33% of the facts vs store wiped 0% / 33%
- carry `halyard-carry` (`alc-heuristic`): store kept 0% / 0% of the facts vs store wiped 0% / 0%

## Per case

| case | kind | arm | turn | variant | verdict | matched | invented |
| --- | --- | --- | --- | --- | --- | --- | --- |
| halyard-pace | single | `normal` | 1 | single | partial | halyard_set_pace | — |
| halyard-mode | single | `normal` | 1 | single | wrong | — | — |
| halyard-drift | single | `normal` | 1 | single | wrong | — | — |
| halyard-retry | single | `normal` | 1 | single | wrong | — | — |
| halyard-max | single | `normal` | 1 | single | partial | halyard_max_frames | — |
| quorvex-4513 | single | `normal` | 1 | single | partial | quorvex-4513 | — |
| quorvex-version | single | `normal` | 1 | single | wrong | — | — |
| quorvex-path | single | `normal` | 1 | single | wrong | — | — |
| peltarn-rate | single | `normal` | 1 | single | wrong | — | — |
| quorvex-lease-floor | multi_hop | `normal` | 1 | single | partial | quorvex_lease_floor | — |
| vintra-pace | conflict | `normal` | 1 | single | wrong | — | — |
| brimwall-absent | absent | `normal` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `normal` | 1 | seed | partial | peltarn_write_quota | — |
| peltarn-carry | carry | `normal` | 2 | warm | partial | peltarn_write_quota | — |
| peltarn-carry | carry | `normal` | 2 | cold | partial | peltarn_write_quota | — |
| halyard-carry | carry | `normal` | 1 | seed | ⚠️ invented | — | 100, 200 |
| halyard-carry | carry | `normal` | 2 | warm | wrong | — | — |
| halyard-carry | carry | `normal` | 2 | cold | wrong | — | — |
| halyard-pace | single | `alc-none` | 1 | single | correct | halyard_set_pace, 12 | — |
| halyard-mode | single | `alc-none` | 1 | single | correct | halyardmode.glide | — |
| halyard-drift | single | `alc-none` | 1 | single | correct | loose | — |
| halyard-retry | single | `alc-none` | 1 | single | correct | 45 | — |
| halyard-max | single | `alc-none` | 1 | single | correct | halyard_max_frames, 240, clamp | — |
| quorvex-4513 | single | `alc-none` | 1 | single | correct | quorvex-4513, lease | — |
| quorvex-version | single | `alc-none` | 1 | single | correct | 3.14.2 | — |
| quorvex-path | single | `alc-none` | 1 | single | correct | pkg/quorvex/adapters/tide.py | — |
| peltarn-rate | single | `alc-none` | 1 | single | correct | 900 | — |
| quorvex-lease-floor | multi_hop | `alc-none` | 1 | single | correct | quorvex_lease_floor, 9 | — |
| vintra-pace | conflict | `alc-none` | 1 | single | correct | 16 | — |
| brimwall-absent | absent | `alc-none` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `alc-none` | 1 | seed | partial | peltarn_write_quota, 7 | — |
| peltarn-carry | carry | `alc-none` | 2 | warm | ⚠️ invented | peltarn_write_quota | 1000 |
| peltarn-carry | carry | `alc-none` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |
| halyard-carry | carry | `alc-none` | 1 | seed | partial | 12 | — |
| halyard-carry | carry | `alc-none` | 2 | warm | ⚠️ invented | — | 1000 |
| halyard-carry | carry | `alc-none` | 2 | cold | ⚠️ invented | — | 100, 255 |
| halyard-pace | single | `alc-heuristic` | 1 | single | correct | halyard_set_pace, 12 | — |
| halyard-mode | single | `alc-heuristic` | 1 | single | correct | halyardmode.glide | — |
| halyard-drift | single | `alc-heuristic` | 1 | single | correct | loose | — |
| halyard-retry | single | `alc-heuristic` | 1 | single | correct | 45 | — |
| halyard-max | single | `alc-heuristic` | 1 | single | correct | halyard_max_frames, 240, clamp | — |
| quorvex-4513 | single | `alc-heuristic` | 1 | single | correct | quorvex-4513, lease | — |
| quorvex-version | single | `alc-heuristic` | 1 | single | correct | 3.14.2 | — |
| quorvex-path | single | `alc-heuristic` | 1 | single | correct | pkg/quorvex/adapters/tide.py | — |
| peltarn-rate | single | `alc-heuristic` | 1 | single | correct | 900 | — |
| quorvex-lease-floor | multi_hop | `alc-heuristic` | 1 | single | correct | quorvex_lease_floor, 9 | — |
| vintra-pace | conflict | `alc-heuristic` | 1 | single | wrong | — | — |
| brimwall-absent | absent | `alc-heuristic` | 1 | single | admitted | — | — |
| peltarn-carry | carry | `alc-heuristic` | 1 | seed | correct | peltarn_write_quota, 7, 900 | — |
| peltarn-carry | carry | `alc-heuristic` | 2 | warm | ⚠️ invented | peltarn_write_quota | 1000 |
| peltarn-carry | carry | `alc-heuristic` | 2 | cold | ⚠️ invented | peltarn_write_quota | 1000 |
| halyard-carry | carry | `alc-heuristic` | 1 | seed | correct | 12, 240 | — |
| halyard-carry | carry | `alc-heuristic` | 2 | warm | ⚠️ invented | — | 100, 255 |
| halyard-carry | carry | `alc-heuristic` | 2 | cold | ⚠️ invented | — | 1000 |

## Cycle bookkeeping

| arm | cycles/turn | tool calls/turn | findings/turn |
| --- | --- | --- | --- |
| `normal` | 0.0 | 0.0 | 0.0 |
| `alc-none` | 2.0 | 1.0 | 2.0 |
| `alc-heuristic` | 2.0 | 1.0 | 4.0 |

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