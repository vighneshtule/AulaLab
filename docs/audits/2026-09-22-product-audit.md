# Product audit — 22 September 2026

**Audited commit:** `797218e5a1b3afc72fca75cd0932a5a188dea77e`
**Status:** Historical report. Findings were subsequently addressed in later changes; check the current code and CI before treating any item as open.

## Summary

The audit reproduced 23 defects and separately recorded delivery constraints, ambiguous settings behavior, and hypotheses for later review. The highest-impact findings involved revoking privileges on already-open connections, preserving edits across disconnections and write failures, execution-attempt lifecycle, and leaderboard correctness.

The audited commit's GitHub CI failed: Linux exposed a long-filename issue and the documentation check found stale generated pages. The production Docker image, Python package, and typecheck passed in that run.

The audit changed no source code and did not modify live classes, competitions, or settings. State checks used temporary directories, a separate SQLite database, and fake services. Its only real-container check created two small temporary files under `/tmp` without network access. It did not stop active Docker or Kubernetes workloads.

## Scope and confidence

The review covered authentication and teacher roles; HTTP and WebSocket access; classes and collaborative editing; councils, lectures, and history; Docker and Kubernetes execution; AI tools and undo; file safety; course publication; competitions and scoring; dependency preparation; competition UI; CLI and local startup; release, update, and restore flows; performance and operations.

Most findings were reproduced against real application functions and handlers, Svelte SSR, temporary databases, controlled I/O failures, and fake Docker/Kubernetes responses. The review did not include a third-party penetration test, full browser end-to-end coverage of every screen, a live Kubernetes cluster, soak/load testing, GPU testing, or multi-node high availability testing.

Priority labels in the original review meant: **P1**, fix before operating the affected scenario with a real class; **P2**, significant behavior or recovery defect; **P3**, localized inconsistency with limited impact.

## Follow-up

The 23 reproduction cases and recommended fixes were tracked in the audit work and subsequent remediation. A later remediation report records the follow-up test and build results. This summary preserves the audit's scope and limitations without presenting its old findings as current defects.
