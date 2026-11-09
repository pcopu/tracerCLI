# JavaScript report performance

These measurements describe the 0.1.3 performance release at commit `9d38d2030d70501461c7e50f86196793290f58b1`. The later 0.2.0 [blank-line change](blank-lines.md) intentionally changes manual totals. The byte-identity statement below applies only to the 0.1.2-to-0.1.3 comparison.

Tracer 0.1.3 keeps the shared JavaScript implementation and version-1 sidecars. Updating a shared installation changes the implementation used by every project that invokes it. There is no per-project version pin.

## What changed

- Group valid links by source file once rather than scanning every link for every file.
- Count exact ordered action sequences at interval boundaries rather than filtering links and serializing actions for every physical line. Separate occurrence counts preserve overlapping duplicate sequences and their current-witness subset.
- Reuse the inventory, sidecar and full integrity inspection within `check --require-minimum`.
- Reuse exact snippet hashes and non-source witness reads only inside one inventory snapshot. There is no persistent timestamp/size cache; later commands reread current bytes.

All links are still validated globally before a selector is applied. A narrow lookup must still expose unrelated malformed or stale entries. Source bytes, BOM, CRLF, action order/repetitions, link ordering, invalid diagnostics, minimum semantics, sidecar hashes and deterministic output are preserved. This release retains the existing physical-line denominator; it does not change measured LCOV evidence or claim that manual links prove execution.

## Measurement

The comparison used the actual public CLI at baseline commit `9ec1a152967a5935bf767c6e3831fd5fab40e468` and this release, with `TRACER_NO_UPDATE=1`. Every case first compared stdout, stderr and exit status byte-for-byte. Timing then used fresh processes, two warm-ups and seven measured runs, alternating before/after order with stdout discarded and a warm filesystem cache. Results are medians on a Linux x86-64 AMD EPYC 9V74 machine with Node v24.22.1. They are not Mac, cold-disk or application execution benchmarks, and other machine activity was not controlled.

The small synthetic fixture has 52 source files, 10,100 physical lines and 200 links. The large fixture has 2,050 source files, 1,002,500 physical lines and 20,000 links. Both use exact SHA-256 source/witness snapshots. All links pass integrity checking. Minimum checking intentionally exits 1 because the synthetic witness-source lines are unlinked.

| Fixture | Operation | Before (ms) | After (ms) | Speedup |
| --- | --- | ---: | ---: | ---: |
| small | integrity | 87 | 88 | 0.99x |
| small | narrow_report | 89 | 86 | 1.03x |
| small | full_report | 148 | 110 | 1.35x |
| small | minimum_check | 161 | 107 | 1.51x |
| small | existing_link | 101 | 100 | 1.02x |
| large | integrity | 640 | 630 | 1.02x |
| large | narrow_report | 655 | 633 | 1.04x |
| large | full_report | 2185 | 632 | 3.46x |
| large | minimum_check | 2527 | 591 | 4.28x |
| large | existing_link | 616 | 655 | 0.94x |

The full report and minimum gate benefit most. Integrity checking and narrow lookups still read and validate the repository; process startup and hashing impose a floor. These numbers describe Tracer overhead, not the speed of an application launched through `tracer app`.

## Regression evidence

The Tracer-driven CLI journeys compare report results against an independent per-line oracle, including overlapping identical sequences, alternate witnesses, repeated/reordered actions, adjacent ranges, clipping, all selector types, empty sources, persisted row ordering and byte-deterministic output. Additional journeys retain global stale/malformed diagnostics under narrow selectors and verify BOM/UTF-8/CRLF hashes and freshness after on-disk edits between commands.

Run the aggregate checks through the self-hosted project connection:

```sh
npm run check
```

The checks validate syntax, execute the real CLI E2E journeys and check the reviewed manual map. Timing is not a pass/fail test; no wall-clock thresholds are added to the suite.
