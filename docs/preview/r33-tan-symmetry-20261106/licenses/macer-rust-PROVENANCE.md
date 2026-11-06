# Provenance

## MatterSim 1M

The browser's MatterSim 1M weights are a converted representation of the
`MatterSim-v1.0.0-1M` checkpoint. The source checkpoint SHA-256 recorded in the
converted model metadata is
`28b0b0b0f13efefee06b47ea4c9105a26bd3e2c8396da193430da96b3b49a8be`.
Upstream source and the model card are pinned to the `v1.0.0` release:
[MatterSim repository](https://github.com/microsoft/mattersim/tree/v1.0.0),
[model card](https://github.com/microsoft/mattersim/blob/v1.0.0/MODEL_CARD.md),
[MIT license](https://github.com/microsoft/mattersim/blob/v1.0.0/LICENSE.txt),
and [MatterSim paper](https://arxiv.org/abs/2405.04967). The upstream model card
identifies the 1M checkpoint and declares MIT licensing. This attribution does
not replace the separate review of this converted artifact and complete browser
package before any public redistribution.

The browser's NEP89 checkpoint is an unmodified copy from GPUMD v5.0, commit
`05982941c85b257fdf5a5c69fb7922ce7d7a5c80`, path
`potentials/nep/nep89_20250409/nep89_20250409.txt` (15,622,195 bytes;
SHA-256 `75168ece02e840e4a32644f982b78d43cba697f5b64b4c8134ab66c7a8c28be1`).
The same exact model bytes are included in the authors' Zenodo record,
[Dataset and models supporting NEP89, version 2](https://zenodo.org/records/19536370),
DOI [10.5281/zenodo.19536370](https://doi.org/10.5281/zenodo.19536370), whose
record metadata declares [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
The official `GPUMD-5.0-NEP89-Demos.zip` has MD5
`1f37b08eb334d60f4bd2338a6607751d`; its embedded model member has the same
SHA-256 as the bundled checkpoint. The record citation, license, archive hash,
member path and byte-level verification are retained in
`third_party/licenses/nep89/NOTICE.txt` and `provenance.json`. The pinned GPUMD
v5.0 README separately declares GPLv3 for GPUMD software, whose notice and
license are retained as software provenance; that declaration is not used as
the model-file license basis. The app license does not relicense the model.

The first three-body indexing kernel was copied from the private development
worktree of `soungmin-bae/macer`, commit `25670445` (`codex/rust-core`). It was
validated there against MatterSim's active NumPy host graph implementation.
The copied CPU benchmark reports are historical observations, not evidence of
standalone MatterSim evaluation or whole-MD acceleration in this repository.

The MatterSim 5M checkpoint is not included. The current reference SHA-256 is
`e3df9fa708725e3d453140646c7d1838324b347a3d1214cf1440522146f872b5`.

`vendor/candle-kernels` is the `candle-kernels` 0.11.0 crates.io source
(`MIT OR Apache-2.0`, [upstream](https://github.com/huggingface/candle)).
`src/indexing.cu` has one local change: the f32/u32 `index_add` CUDA kernel
uses a parallel atomic scatter. The original generic kernels remain in place
for other index and value types. This patch is evaluated against the pinned
MatterSim numerical fixtures and the full MD performance gate before use in
any release.

`vendor/candle-core` is the `candle-core` 0.11.0 crates.io source with one
backpropagation change in `src/backprop.rs`: matrix multiplication computes a
gradient only for an input whose branch reaches a variable. This avoids
calculating unused model-weight gradients during energy differentiation.
The CPU and CUDA numerical and throughput gates must be rerun with this fork.

2026-10-25 empty-view correction: `candle-core/src/backprop.rs` skips zero-element
in-place gradient additions before constructing storage slices. `src/layout.rs`
returns the physical slice `(0, 0)` for empty views while preserving their logical
start offset. This prevents native CPU panics for cutoff-adjacent nonperiodic
MatterSim graphs and empty narrow reductions. Regression and direct native/GPU
same-geometry evidence: `evidence/webgpu_errors_2026-10-25/`. Existing nonempty
arithmetic and numerical thresholds are unchanged. Other prior local CPU/CUDA
optimizations remain subject to their existing evidence and release gates.

## Connected browser phonon preview (2026-10-29)

The Phonons input and computation flow use the existing same-origin MatterSim 1M/NEP89 evaluator workers and Moyo 0.21.0 WASM symmetry operations. `web/design/phonon-engine.js` constructs periodic diagonal supercells, lifts valid primitive operations and lattice translations, selects spanning site-symmetry displacement directions, and calls the local Rust/WASM force-constant/dynamical-matrix/eigenpair kernels. Atomic masses in `atomic-masses.js` are copied from phonopy 4.4.0 `atomic_data`; BSD-3-Clause license: `third_party/licenses/phonopy-4.4.0-LICENSE`. Rust numerical kernel attribution and phonors 0.3.0 licensing remain in `crates/phonon-kernel/src/lib.rs` and `third_party/licenses/phonors-v0.3.0-LICENSE`.

This is an integrated preview. Primitive standardization uses Moyo's idealized standard cell. Auto currently selects diagonal repeats meeting periodic-height minima; automatic and manual q paths are supported as described below. Full integer supercell matrices, PB symmetry-preserving relaxation, full phonopy output bundles and final multi-browser/offline qualification remain tracked in the phonon acceptance ledger. Existing numerical failures, including the relaxed source-order MatterSim FC2 fixture, remain unresolved. Evidence for connected CPU Chrome Si/NaCl runs is in `evidence/phonon_connected_preview_2026-10-29/`.


## Browser automatic q-path and NAC (2026-10-29)

`seekpath-data.js` contains the official 29 extended-Bravais HPKOT tables and
primitive transformation matrices exported from SeeK-path 2.2.2. Its MIT license
is `third_party/licenses/seekpath-LICENSE`. `phonon-path.js` ports the metric
case selection and expression evaluation and converts q coordinates into the
actual calculation primitive basis. Moyo 0.21.0 supplies space-group analysis
and reciprocal Niggli reduction (the latter compiled into the phonon WASM).
Moyo's standardized Cartesian frame can differ from spglib's by a crystal
symmetry operation; q coordinates are transformed explicitly. Official 60
examples and their rotated versions validate the tables and basis conversion.

`phonon-nac.js` ports phonopy 4.4.0 independent-atom BORN expansion, tensor
symmetrization/neutrality, Wang's FC correction, and Gonze–Lee reciprocal-only
(default phonopy) preparation. Gonze preparation subtracts the commensurate
long-range dynamical matrices by inverse transform before interpolation and
re-adds the reciprocal sum at band q points. `crates/phonon-kernel/src/nac.rs`
is the sequential reciprocal dipole code from phonors 0.3.0 commit
`ca6eac4464cea519fef1d6d8018b4d13c20fa84d`, BSD-3-Clause; its license is bundled.
No Python, NumPy, native phonopy library or calculation server runs in the app.

The bundled NaCl BORN example uses illustrative dielectric 2.434 and charges
±1.1 for demonstrating the workflow. These are supplied example parameters,
not predictions by MatterSim/NEP or a newly verified ab-initio dataset.
Real-material NAC requires an appropriate user-supplied BORN file for the
standardized calculation primitive and its Cartesian axes. Source hashes,
phonopy comparisons, browser results and remaining gates are recorded under
`evidence/phonon_qpath_nac_2026-10-29/`.

## WebGPU phonon force path (2026-10-29)

The Phonons controller now forwards and checks the existing model Worker's
`evaluationBackend` for every displacement. WebGPU selection must prepare the
WebGPU evaluator; CPU results cannot silently enter a GPU force queue. Completed
force records retain GPU timing, requested-buffer accounting, stress and source
backend. Project/results/YAML retain model/runtime asset hashes, adapter/preparation
metadata and a separate 128 MiB requested-buffer resource verdict. Old GPU
checkpoints lacking backend provenance require fresh force evaluation; their
saved result remains viewable. CPU checkpoints remain supported.

On the tested Apple M4/macOS 15.5, Chrome 156 and headed Firefox 158 execute actual
MatterSim/NEP GPU forces, followed by the shared Rust/WASM harmonic kernels.
Initial Relax keeps its existing GPU path and final CPU convergence audit.
The same GPU-prepared structures/displacements are evaluated independently by
CPU/WASM and native Rust; GPU-produced force constants/bands are checked against
phonopy 4.4.0 / phonors 0.3.0. This is numerical/functional qualification of the
specified fixtures, not a speedup or full resource/offline qualification.
MatterSim Si128 computes correctly but exceeds the fixed 128 MiB requested-buffer
criterion (about 487 MiB); this resource row remains FAIL, with no size/tolerance
relaxation or silent CPU substitution. See evidence/phonon_webgpu_2026-10-29/.
