# Performance baseline

Informational baseline recorded for Phase 0. These numbers are **not gates**;
they exist so that later changes (Phases 3–5) can be compared against a
reproducible starting point. Re-record with `npm run bench`.

## How to reproduce

```bash
npm ci
npm run build
# Real installed index (preferred), or the synthetic corpus if none is installed:
NODE_OPTIONS=--max-old-space-size=4096 npm run bench
# Force the deterministic synthetic corpus:
npm run bench -- --synthetic
```

The script never triggers a rebuild: it only loads a version whose persisted
cache already exists (`data/versions/<version>`). With no installed index it
builds a 15,000-record synthetic corpus, so it runs in CI without a download.

## Recorded baseline — installed Bevy 0.20.0 index

Environment: Linux x64, Node v22.23.2, `--max-old-space-size=4096`, recorded
2026-10-12. Corpus: 252,761 records, 653,264 symbols.

| measurement | ms | detail |
|---|---:|---|
| startup:cold | 16,524.93 | 252,761 records |
| startup:warm | 0.37 | in-process cache |
| lookup:App::add_systems | 0.6 | 3 hits |
| lookup:Query | 0.48 | 15 hits |
| lookup:Camera2d | 0.08 | 3 hits |
| lookup:Transform | 0.12 | 21 hits |
| lookup:World | 0.13 | 27 hits |
| search:system ordering | 257.04 | `bevy::ecs::prelude::System` |
| search:2d camera | 187.4 | `bevy::core_pipeline::core_2d::extract_core_2d_camera_phases` |
| search:spawn ui text | 198.58 | `bevy::prelude::Text` |
| search:change detection | 117.04 | `bevy::asset::AssetMut::bypass_change_detection` |
| search:play sound | 9.19 | `bevy::animation::prelude::AnimationPlayer::play` |

"cold" is the first `VersionRegistry.get()` in a fresh process; "warm" is the
second call, served from the in-process map. Concept queries are averaged over
three runs.

## Recorded baseline — synthetic corpus

Environment: same machine. Corpus: 15,010 records, 45,020 symbols.

| measurement | ms | detail |
|---|---:|---|
| startup:build | 1,223.52 | 15,010 records |
| lookup:App::add_systems | 0.29 | 0 hits |
| lookup:Query | 0.14 | 1 hit |
| lookup:Camera2d | 0.03 | 1 hit |
| lookup:Transform | 0.02 | 1 hit |
| lookup:World | 0.02 | 1 hit |
| search:system ordering | 2.35 | (none) |
| search:2d camera | 32.23 | `bevy::fixture::Camera2d::method_8` |
| search:spawn ui text | 0.25 | (none) |
| search:change detection | 0.1 | (none) |
| search:play sound | 0.05 | (none) |

## Reading the numbers

- Cold startup is dominated by deserialising `records.ndjson` and restoring the
  text index. It is ~16.5 s at ~253k records; the plan's Phase 5 measures where
  that time goes before any optimization.
- Exact symbol lookup is effectively free (<1 ms) because it is a hash lookup.
- Concept search is the visible cost (100–260 ms at this corpus size). It is
  the baseline for the Phase 4 search-quality work.
- Timings depend on disk speed, heap setting and corpus size, so compare a new
  run against a re-recorded one on the same machine, not against these absolute
  values.
