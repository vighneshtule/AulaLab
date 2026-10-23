# Competition dependency manager — design v1

**Status:** Implemented and verified on 22 September 2026. Additional package preparation is enabled for `pvz-demand-geo`; verification notes are at the end of this document.

Design mockups: https://app.paper.design/file/01M0WXJVWBZB3MY0SN1X97S0AH/p-G-0

- P5 — participant packages.
- P6 — package preparation and conflicts.
- P7 — submissions with a pinned package bundle.
- P8 — mobile dependency manager.
- A4 — competition dependency policy.

Package versions and sizes in the mockups are illustrative states. In production they come from actual preparation results.

## Decision

Each competition has a base environment, and each participant may add private dependencies. The server prepares dependencies before execution. Every submission points to an immutable bundle. Notebook execution and metric calculation run without general network access.

The current `kaggle-base` is Aula Lab's lightweight CPU environment, not an official Kaggle image. This choice followed a check of official image sizes: 8.51 / 21.45 GiB compressed for CPU/GPU, with the CPU image using linux/amd64. The local Docker host was ARM64 with 6.1 GiB free. The official images were not downloaded and the local VM was not restarted.

Options considered:

1. A single shared image, which already worked but required teachers to maintain every new package.
2. Private wheel bundles layered over a pinned base, selected because it matches the current executor and avoids a large image per participant.
3. A separate Docker image for each bundle, which could be considered later but adds storage, layer builds, a remote registry, and another image queue.

## Participant flow

1. The **Packages** tab shows the base environment, Python version, and a link to the complete installed inventory.
2. A participant enters dependencies one per line or uploads a `requirements.txt` into the manager. This is not a shared competition data file.
3. **Check and prepare** queues compatibility checks, download, installation verification, and readiness.
4. Errors identify the package, request line, and corrective action. The last ready bundle remains available.
5. A ready bundle records exact direct and transitive versions, sizes, and its base environment. Participants can download its pinned package list.
6. **Use bundle** selects a bundle for the next submission. Existing submissions do not change.
7. In the **Submissions** tab, selecting a file no longer uploads it immediately. The participant reviews the file and selected bundle, then submits the notebook.
8. Each submission row shows its bundle. Re-running uses that bundle regardless of the participant's current selection.
9. With no extra packages, **Base environment** works without preparation or an extra action.

On mobile, controls use one column without clipping package names or buttons. Technical logs are in a separate disclosure. Main text is 16 px; labels are 14–15 px.

## Version 1 rules

- Extra packages come from public PyPI and must have wheels compatible with the base image's Python, ABI, and platform.
- Package names, extras, version constraints, and valid environment markers are parsed with `packaging.Requirement`.
- Arbitrary shell commands, pip options, Git/URL/local-path requirements, and source distribution builds are not supported. Rejections include a specific reason; the request is never silently changed.
- Base packages are fully pinned. If an installed version satisfies a request, it is reused without a download. A participant bundle cannot replace base NumPy or the system `ipykernel`; conflicts are rejected before notebook execution.
- New base images are separate revisions. A teacher explicitly selects a revision for a competition. Old submissions and their images remain available.
- Preparation does not consume the daily submission limit. Installing a bundle during execution counts toward the submission's time/memory limit. A system installation failure before the first cell does not consume the daily quota, consistent with other pre-execution failures.
- Disabling the manager prevents new preparations. Accepted submissions and ready bundles continue working to preserve reproducibility.
- Draft requirements and bundles are private to the participant. Teachers can view them for troubleshooting; another participant cannot use someone else's `bundleId`.

## Data model

`environment_revision` stores an ID, environment name, image digest, Python version, Python ABI, platform, full installed inventory, base constraints hash, and creation time.

`dependency_draft` stores the competition ID, entrant ID, requirements text, selected bundle ID, and update time.

`dependency_bundle` stores its ID, competition and entrant IDs, environment revision, original and normalized requirements, lock manifest, content hash, Docker image ID, state, preparation log, sizes, and timestamps.

A submission stores `environmentRevisionId` and nullable `dependencyBundleId` at acceptance. Migrations bind old submissions to an available image ID where possible; otherwise they mark them as legacy/unpinned rather than inventing reproducibility.

The sequential bundle number shown in the UI is scoped to a participant within a competition. It is neither an internal UUID nor a hash.

## Preparation pipeline

Preparation has its own queue, separate from submission execution; a slow package download must not occupy the only worker slot for queued models.

1. The server checks identity, competition access, policy, request size, and rate limits.
2. Requirements are parsed; forbidden sources/options are rejected; names and markers are normalized.
3. The manager resolves the immutable base image and its complete constraints snapshot.
4. An isolated downloader, with no competition data, secrets, or notebooks, resolves dependencies. Network access is limited to PyPI and `files.pythonhosted.org`. This is not execution of participant notebook code.
5. Compatible wheels are saved and checked for package names, versions, hashes, and limits. Version ranges become exact versions with SHA-256 hashes.
6. A fresh container with no network, the same base, and the same platform performs an offline installation and `pip check`. The check does not import arbitrary modules just to infer Python import names.
7. The bundle becomes ready atomically only after every file passes verification. A partial download can never be used by a submission.

The reuse key includes the base digest, Python ABI, platform, and normalized request. A ready bundle is immutable. Explicit re-preparation creates another revision; it does not replace the old one.

Initial policy limits are 32 lines / 8 KiB per request, 500 MiB of downloaded wheels, 512 MiB installed size, 10 minutes of preparation, one active request per participant, one global preparation job, and at most 10 preparations per hour per participant. Free disk space is checked before downloads. When space is low, existing bundles are not deleted.

## Submission execution

1. On acceptance, the server verifies the bundle owner, ready state, and exact revision match with the competition environment.
2. Competition data and the wheel bundle are mounted read-only in the notebook container. Network access is disabled and existing resource limits remain in force.
3. A temporary virtual environment is created in writable workspace storage with access to the base image's system packages.
4. Extra wheels are installed with `--no-index --no-deps --require-hashes` from a lock file. Execution neither resolves new versions nor downloads packages.
5. A temporary kernelspec points `argv` to **the virtual environment's Python**. Changing `PATH` is not sufficient because an existing kernelspec may use an absolute path to the base Python.
6. The progress sequence is **Queue → Install packages → Notebook → Check CSV → Score**. The participant sees the current phase; the cell number appears when notebook execution begins.
7. The metric container uses a separate pinned teacher environment. Participant packages and virtual environments are not mounted into it.

The accepted submission records the exact Docker image ID and bundle. Re-runs and rescoring use the same references. Submissions from before the manager are marked legacy because the original value of a mutable image tag cannot be reconstructed reliably.

## API surface

- `GET /api/k/competitions/:slug/dependencies` returns the draft, selected bundle, and ready bundles for the current participant.
- `PUT /api/k/competitions/:slug/dependencies/draft` saves requirements and the selected bundle.
- `POST /api/k/competitions/:slug/dependencies/prepare` returns a bundle ID and queues preparation.
- `GET /api/k/competitions/:slug/dependencies/:bundleId` returns state, pinned versions, sizes, and a readable error.
- `GET /api/k/competitions/:slug/dependencies/:bundleId/stream` provides SSE during preparation, with polling as a fallback.
- `POST /api/k/competitions/:slug/dependencies/:bundleId/cancel` cancels the participant's own preparation.
- `GET /api/k/competitions/:slug/dependencies/:bundleId/lock` downloads a lock file without server paths or tokens.
- The existing `POST /submissions` accepts a multipart notebook and `bundleId`; clients cannot upload arbitrary wheel bytes through this endpoint.
- Admin controls configure preparation policy and expose queues, statuses, and logs with secret filtering.

## Storage and recovery

Bundles referenced by submissions and the required image digest are retained with the competition. Unused drafts and unselected bundles may be removed by retention policy; garbage collection never deletes referenced artifacts. After restart, incomplete preparation is retried safely or reported as failed. Partial files never make a bundle ready. Backups must include manifests and artifacts, or document a verifiable method to restore them by hash.

Bundles live under `data/dependencies`; references and queue state live in SQLite. Backups include wheels, manifests, locks, and competition files. Docker layers are stored separately: rebuilding from requirements cannot recover the old image ID. Keep `aulalab-revision:*` images while referenced submissions need them. Preparation and its queue run in the server process; incomplete jobs receive a clear failure after restart, while ready bundles are retained.

## Acceptance checks

- Prepare a clean Python package and one with a transitive dependency, then run a real notebook with `network=none`.
- A package already present in the base is not downloaded or upgraded.
- Base conflicts, unknown packages, missing wheels, bad hashes, full disk, and timeout produce distinct understandable reasons.
- Changing the selected bundle does not change a re-run of an old submission.
- Updating the base does not change old submission revisions; an incompatible old bundle is rejected for a new submission.
- Participants cannot read each other's bundles. The downloader cannot access notebooks or hidden answers; the scorer cannot see participant packages.
- Check cancellation and restart in every phase, parallel request deduplication, expanded size limits, and garbage collection of referenced artifacts.
- Browser QA covers an empty bundle, preparation, success, conflicts, submission with a ready bundle, 390 px mobile width, keyboard use, and status announcements.

## Verification recorded for the implementation

Preparation requires Docker Engine 28+ with an isolated internal-network gateway. The downloader exits only through a CONNECT proxy to `pypi.org` and `files.pythonhosted.org:443`; direct internet, internal services, and arbitrary domains are blocked. If isolation is unavailable, preparation fails closed. Notebook and scorer containers use `--network=none`.

Verified on local `kaggle-base`, Python 3.11.16, linux/arm64:

- Prepared `python-slugify==8.0.4` and transitive dependency `text-unidecode==1.3`: 88,205 bytes of wheels and 347,372 bytes installed, with a hashed lock file.
- Submitted `ku3vwzjw`: installed from the wheel bundle, checked imports and versions, used a kernelspec for the temporary virtual environment, verified no network access, created a CSV, and calculated public/private metrics in a separate container.
- After switching the draft to the base bundle, re-running the same submission still used its original bundle #1. All four phases of both runs returned `ok`; the test submission was excluded from scoring.
- UI checks covered a `numpy==1.26.4` base conflict with its request line, selecting a ready bundle, submission history bindings, saving teacher policy, desktop, and 390 px mobile without horizontal overflow.
- The recorded `npm test` run reported 3,648 passed, 24 skipped, and 0 failed (3,672 total). Typecheck and build passed; eight existing Svelte warnings remained.
- Separate Docker checks covered real downloads, base-package reuse, egress limits, cancellation, timeout, size limits, missing wheels, cleanup, and suppressing `.pth` processing in the verification virtual environment.

Chrome's local-file chooser extension could not be tested because it did not have file-URL access. Multipart file receipt, bundle selection, and full submission were checked through the real API; the form's initial state was covered by component tests. File selection and submission are separate in the code, but that transition was not verified in a browser. This is a browser-automation limitation, not an application restriction on uploads.
