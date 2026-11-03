# macer web preview r24 — Rust/WASM response preview

Static browser app for structure/Relax/phonon and approximate response previews.
Fitted bond-polarizability regression and expanded CGCNN can be selected or
compared using the same analytic Gamma phonons, linewidth and curve scale.
Both response calculations run in Rust/F64 WebAssembly Workers. No Python or
localhost inference service is required. Phonon forces/frequencies remain the
selected force model's predictions; reusing saved example phonons is not a new
force-to-spectrum accuracy test.

CGCNN Raman/Born/electronic dielectric models are experimental and not
independently accuracy qualified. ASR/SPD constraints and implementation parity
do not establish scientific accuracy. Unsupported elements fail explicitly.
Raman curves show relative activities, not absolute experimental intensities.
See licenses/index.html and the per-model manifests for attribution and identity.

This distribution passed scoped browser NaCl comparison and Si Stop/retry
checks, together with numerical port parity and static package/hash review.
It does not claim full scientific, platform or project-file-flow qualification.
The original development package was built from a dirty working tree; the exact
selected app files are hashed in package-manifest.json. Local implementation
commit 956f97d is associated with this artifact, not asserted to be the sole
clean source of all bundled preexisting runtimes. Existing source
archives are retained byte-for-byte as historical releases, not as source for
the new Rust/WASM response kernels. No new source archive or raw training data
is included. Existing downloads/install UI is available to users; restricted
agent save/download/reopen/offline tests have not been performed.

Rollback uses a new deployment restoring a prior distribution commit; history
is preserved. Existing calculation tabs are never force-refreshed.
