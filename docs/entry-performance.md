# Uncached join performance

The first appearance of the join form and room readiness are different measurements. A complete join check must cover asset loading, form submission, both WebSocket connections, document receipt, and the notebook appearing. If the notebook's first screen contains text, waiting for a code editor creates a false timeout.

`scripts/entry-perf.mjs` opens a fresh browser context. It requires Chrome and `playwright-core`. Use `ENTRY_PLAYWRIGHT` to set the library path and `ENTRY_CHROME` to set the browser path when Chrome is not at its usual macOS location.

```bash
ENTRY_URL=http://localhost:3000/s/disposable-room \
ENTRY_JOIN=1 ENTRY_READY=notebook \
ENTRY_OUTPUT=/tmp/entry.json \
node scripts/entry-perf.mjs
```

For a join test, use a separate class: the script creates a test participant. It does not post to chat, change cells, or run code. Without `ENTRY_JOIN=1`, it measures only the form. The report contains join phases, resource sizes and load times, long browser tasks, and connection state. WebSocket URL authentication parameters are not written to the report.

- `ENTRY_READY=editor` waits for an available editor, suitable when the first screen contains code.
- `ENTRY_READY=notebook` accepts a first screen containing Markdown.
- `ENTRY_CHECK_SCROLL=1` checks deep scrolling, returning to a visited cell, and moving to a cell that has not yet been created.
- `ENTRY_DELAY_MS` adds the same delay to each HTTP request.
- `ENTRY_DWELL_MS` sets how long the name is typed before submission.
- `ENTRY_PROFILE` sets the Chrome CPU profile file.

## Stage 1: notebook, 11 September 2026

A real class with 279 cells created about 30,000 DOM nodes. Deferring the internal editor did not defer creation of the cell components themselves. In one measurement from a public link, the notebook appeared after 45.35 seconds. That result includes network time and is not a stable measure of server performance.

For comparison, the same notebook was copied to an isolated local class and opened in sequence in two fresh browsers:

| Phase | Before | After |
| --- | ---: | ---: |
| Join form | 3.01 s | 3.18 s |
| Notebook visible | 15.43 s | 11.39 s |
| Room ready | 19.95 s | 16.93 s |
| Initial DOM nodes | 30,157 | 9,058 |

The changes defer creation of unseen cells and their insert buttons, retain a component after its first visit, preload room bundles after the form renders and in parallel with the join request, and create selected and executing cells regardless of their position.

This is a local comparison on one machine, not a promise of the same timing over the internet. To measure network effects separately, repeat the same scenario through a public link and through loopback, without concurrent builds or load tests.

## Stage 2: first application screen

A separate request to speed up the application shell reduced its startup dependency graph. The full dictionaries load before the relevant screen; at that time, the first screen needed 164 of 2,568 message keys. Reading the class card from `localStorage` was separated from the Yjs collaboration library. The server began sending the interface language in HTML, so the first join no longer waited for a separate `/api/instance` request. **The current product interface is English-only.**

| Startup JavaScript | Before | After |
| --- | ---: | ---: |
| Source bytes | 564,328 | 131,066 |
| Brotli | 139,977 | 42,711 |
| gzip | 169,062 | 48,740 |

The early code-font download for a new visitor was also deferred: its 31 KB no longer competes with the form assets. Returning participants retain early preloading. With 256 kbit/s and 150 ms latency simulated, the first screen appeared in **4.39 s instead of 8.78 s**. This is a comparison under identical conditions, not a guarantee for an arbitrary connection. The join form was checked in English, including name selection, refusal handling, and subsequent loading of the admin and activity-history catalogs.
