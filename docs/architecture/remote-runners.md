# Remote execution machines

A *runner* is a remote Docker host that executes work for an Aula Lab instance. This document summarizes the implemented architecture; the application code and current English guides are authoritative when they differ.

## Responsibilities and trust boundaries

- The Aula Lab home server owns classes, participants, submissions, scoring, and the authoritative database.
- A runner executes only work leased to it. It connects to the home server over an outbound authenticated channel; the home server does not open an inbound connection to the runner.
- Each runner has its own Docker daemon. Workloads run in separate containers with the resource, network, filesystem, and image constraints selected by the home server.
- Runner identity, lease state, machine capability, and the home server's current build are checked before new work is assigned. A runner on an incompatible or outdated build receives no new leases.
- Hidden competition inputs are sent only to a machine explicitly trusted by the owner. Trust is disabled by default.

## Assignment and execution

The home server selects a runner from the current inventory of connected machines, matching the job's CPU, memory, environment revision, and GPU requirements. Capacity advertised by a runner is bounded by its configured limits and the number of concurrent jobs it can actually host. A job lease pins the exact environment revision and resource limits accepted with that job.

Submissions use the pinned base image and, where configured, the participant's immutable dependency bundle. The runner fetches only the artifacts named by the lease, verifies their hashes, and runs notebook execution without general network access. The metric/scoring workload uses its own controlled environment and does not inherit participant packages or hidden inputs unnecessarily.

The home server tracks queued, leased, running, scoring, completed, failed, and cancelled work. A submission's own runtime begins when its container starts; dependency preparation and queue waiting do not consume that execution interval. Re-running or rescoring an old submission uses the image and dependency bundle recorded when it was accepted.

## Liveness, failure, and revocation

Runners report state through periodic synchronization. The home server uses recent path evidence and a silence threshold to decide when a machine is unavailable. It quarantines repeated losses, avoids penalizing an intentional drain, and does not assign work to a machine that has stopped accepting leases.

Revoking or removing a runner ends its leases and access. Open artifact streams are closed on revocation or leave; bounded upload size, duration, and idle time limit resource exposure. Orphaned queue rows are reconciled after restart, and old runner records are pruned after their retention period.

A job may fail over only when its inputs and execution state make that safe. A lost worker does not silently turn into a successful result. The home server records the outcome and exposes a reason to the participant or teacher.

## Operations

The teacher panel reports connectivity, capacity, GPU inventory, readiness for open competitions, and current runner build. Owners can add machines, trust them for hidden tests, drain them before maintenance, revoke them, and update their agent. Drain stops new assignments while allowing in-flight work to finish; a forced leave cancels remaining leases.

Use the runner CLI and deployment scripts documented in [`docs/pages/en/runners.html`](../pages/en/runners.html) and [`deploy/vast/README.md`](../../deploy/vast/README.md). Check the health endpoint, machine synchronization, Docker capacity, image availability, network isolation, and backup state before publishing a class or competition workload.

## Source of truth

The contract is in `shared/remote-runner.ts`; HTTP and lease handling live under `server/src/competitions/remote/`; the runner agent lives under `server/src/runner-agent/`; machine operations live in `cli/` and `scripts/`. The detailed implementation and regression tests are maintained alongside those files. This guide intentionally avoids preserving superseded planning notes and old interface labels.
