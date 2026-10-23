# Classes on remote machines

Aula Lab can execute class notebooks on machines registered by the instance owner. The home server remains authoritative for the class, notebook, participants, rules, and files; remote machines provide compute capacity. The code is the source of truth when implementation details differ from this overview.

## Execution modes

A class can run locally in the home server's Docker environment or on eligible remote machines. Class settings choose whether remote execution is available. Personal notebooks can be assigned to remote machines independently of the shared class notebook. The home server reports the selected mode and machine readiness before work is submitted.

For a council using a worker pool, each attempt runs in an isolated worker created from a snapshot of the notebook kernel. Independent attempts can run in parallel without sharing their mutable process state. A snapshot may not carry open files, database connections, or other external resources; those attempts fall back to the shared notebook kernel with a visible reason. The notebook's normal queue remains responsible for work that uses that shared kernel.

## Snapshot and worker lifecycle

The home server identifies a snapshot by epoch and content seed, and distributes only the artifacts needed to create a worker. A worker starts from the class's environment and restores the snapshot before executing an attempt. Each attempt receives personal copies of mutable namespace values; after execution, the shared namespace is restored to its previous state. One attempt cannot overwrite another attempt's notebook variables.

Workers are started lazily and reused only while their machine, environment revision, and snapshot are compatible. If the runner disappears, its worker state is lost. The home server can start another worker from a still-valid snapshot; it cannot recover unsaved in-memory state from a lost machine. Attempts queued on a pool can be cancelled by participant and cell, and cancellation is reconciled with both the worker and the home queue.

## Machine selection and readiness

The home server chooses from machines that are connected, accepting class work, and capable of the requested environment and resources. GPU classes also require the right GPU and runtime. Machine capacity is bounded by memory, CPU, and configured concurrency. Readiness checks verify the environment image and required class data before a worker is offered.

A machine can be drained for maintenance. It receives no new work while existing work completes. A revoked, stale, or quarantined machine cannot receive new leases. When a machine loses contact during execution, the attempt is reported as interrupted or retried only when the operation is safe to repeat.

## Files and data

Class files remain owned by the home server. A remote worker receives the class snapshot and explicitly staged inputs needed for its attempt. Files created by one attempt are not silently published as class files. Personal notebook storage is separate from the shared class notebook. Transfers are bounded, authenticated, and tied to a current lease; revocation closes active streams.

The design does not treat a remote machine as trusted merely because it is registered. Hidden competition data requires an explicit trust decision. Remote class execution receives only the data and permissions required by the selected mode. All student code remains isolated in per-room or per-attempt containers, with network policy and resource limits enforced by the execution host.

## Failure behavior

The home server tracks each attempt from acceptance through queueing, lease assignment, execution, scoring, and final result. If pool preparation is still in progress, an attempt may use the shared notebook kernel only when the class policy allows that fallback. The user sees where it ran and why it could not use the pool.

A pool startup timeout, missing snapshot, lost machine, rejected upload, or incompatible environment produces an explicit state rather than a false success. A retry uses the accepted submission and its pinned environment revision. Server restart reconciles leases and pool state from durable records; in-memory workers are recreated as needed.

## Code and operations

The class/runner contracts are in `shared/remote-runner.ts` and related shared protocol modules. Server policy and scheduling live in `server/src/kernel/`, `server/src/competitions/remote/`, and the runner agent under `server/src/runner-agent/`. See [`Remote execution machines`](remote-runners.md), [`runners`](../../docs/pages/en/runners.html), and [`security`](../../docs/pages/en/security.html) for operator guidance.

Before enabling remote execution, verify the machine build, environment image, GPU runtime if required, storage capacity, and isolation health. Keep backups of the home server's durable data and the artifacts that pinned submissions depend on. Do not remove a referenced environment image or dependency bundle while its classes or submissions still need it.
