# Audit remediation — 23 September 2026

This is a historical summary of remediation performed after the product audit on 22 September 2026. It describes that verification run, not the current state of the branch.

## Implemented changes

- Server-side results and state revisions became authoritative; event-feed pagination no longer changes ranking.
- Execution attempts, permissions, routes, and inputs received separate generations or revisions.
- Server-side file writes and AI undo confirm only changes that were actually persisted.
- The shared local resource budget accounts for class rooms, personal kernels, dependency preparation, and competitions, including the interval before a new census.
- `/api/health` reports executor capabilities. Staff-only `/api/instance/operations` reports queues, reservations, artifacts, retries, cleanup, and save latency/errors.
- Nightly/manual real-Docker tests were added for dependency preparation and restore; Linux CI gained a browser reconnect smoke test.
- Socket authorization, background worker startup, operational status, and work-budget code were split into focused modules rather than rewritten wholesale.

## Decisions and verification recorded at the time

For the standard production k3s/broker setup, unavailable competition execution and package preparation were made explicit in UI, API, and startup checks until each capability was ready. A later change added separate Pods for notebooks, metrics, and dependency preparation while retaining explicit unavailability where a capability is not ready.

The reported final run had **3,771 tests: 3,746 passed, 25 skipped, 0 failed**. Two Chromium scenarios and one real Docker restore-and-run scenario passed. Typecheck and build passed. Eight pre-existing Svelte warnings remained in five untouched screens/components; no new warnings were reported in the interfaces changed by that remediation.

The report did not include GitHub-hosted nightly results or real Kubernetes/GPU trials. Kubernetes races and errors were exercised with controlled test responses.
