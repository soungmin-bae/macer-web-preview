# Local browser Relax and Phonons preview

## Run locally

Keep this package in its own versioned directory; do not merge it into an older
package. Serve this directory as the static document root and open /web/design/.
For a local smoke check only, run: python3 -m http.server 8768 --bind 127.0.0.1
from this directory and open http://127.0.0.1:8768/web/design/. Opening a
file:// URL is unsupported. For other static hosts, serve .wasm as
application/wasm and .js as text/javascript. No calculation server,
Python/PyTorch runtime, CDN or remote model API is needed; Python's server is
only a static-file development server.

## Phonons preview

Open /web/design/#phonons. NaCl + BORN example demonstrates NAC using clearly
marked illustrative dielectric/charge parameters; supply suitable real-material
BORN data for scientific use. Paste a periodic POSCAR/CIF or open a structure file,
choose a model and Run Phonons. Initial full-cell FIRE Relax is enabled by default.
Auto uses a 12 Å minimum periodic height; Manual specifies primitive-cell repeats.
Bands default to the symmetry-derived SeeK-path/HPKOT path; Manual remains editable.
Optional BORN input enables Gonze–Lee or Wang NAC, including segment-specific Γ limits.
Preview the primitive and its independent-atom order before preparing Cartesian BORN tensors. Select a band/mode to
animate it; download band.yaml or save a project/checkpoint. Stop preserves completed
force evaluations; Restore last checkpoint or Open project enables Resume.
For GPU force evaluations, choose the model option marked WebGPU. Actual GPU
force/NAC band paths are checked on Chrome and headed Firefox on Apple M4.
Unsupported browsers require an explicit CPU selection; no silent fallback.
Initial GPU Relax retains its CPU convergence audit. Harmonic kernels remain
local Rust/WASM. The tested MatterSim Si128 exceeds the fixed 128 MiB requested
GPU buffer budget despite numerical correctness; its resource gate remains failed.
See the repository evidence/phonon_webgpu_2026-10-29/ for precise tested scope.
This preview does not yet include full integer supercells or every phonopy export. Numerical and browser qualification is ongoing.

## Estimated Raman preview

When analytic Gamma phonons without directional NAC are available, the optional
FERE mode differentiates a compact bond-polarizability model fitted to
RamanDB tensors. It produces relative powder activities and a displayed
spectrum; it does not predict absolute experimental cross sections, resonance,
temperature or anharmonic effects. Its one-time frozen qualitative screen
passed 98 scoreable structures from 100 selected records (cosine median 0.898,
major-peak recall 0.854); individual materials can differ and unseen elements
are not qualified. See third_party/licenses/ramandb/NOTICE.md and the FERE
bundle/evidence recorded in package-manifest.json. The RamanDB data license and
attribution notice are included. This is a local evaluation candidate, not a
public release.

## Upgrade and rollback

Build or copy each version into a new, separate directory and retain the
previous directory and its package-manifest.json. Verify the package before
changing the static host's document root. Switch the document root to the new
directory as one host configuration change; to roll back, point it to the
retained previous directory. For the local smoke server above, stop it with
Ctrl-C and start it again from the selected version directory. A fresh page
load starts with the built-in example; open a saved project explicitly to
restore prior work. The current page keeps edits in memory. Verified model
cache entries remain available across reloads when the browser retains them.
Tabs keep their loaded JavaScript until reload; no reload is forced by the
package. Re-prepare a model if its verified browser cache was evicted. A
server-off calculation test does not establish OS-wide network isolation.

Select MatterSim 1M or NEP89, with CPU/WASM or experimental WebGPU, then Run. GPU availability
depends on the browser/device. CPU selection is explicit. NEP89 uses its bundled,
SHA-256-pinned checkpoint automatically on Run, just like MatterSim. No model
file selection is required. Upstream license/provenance is provided under
third_party/licenses/nep89/. The NEP89 checkpoint is an unmodified model file
also present byte-for-byte in the authors' Zenodo v2 record under CC BY 4.0;
the record citation, archive checksum and matching model hash are recorded in
the notice. The retained GPUMD GPLv3 file describes the upstream software
snapshot. The VESTA
display preset follows phononwebsite's viewer style and carries its BSD-3-Clause
notice and the vendored Three.js MIT license under third_party/licenses/phononwebsite/.
The local band.yaml viewer uses js-yaml 4.1.0; its MIT license is included under
third_party/licenses/js-yaml-LICENSE. Crystal symmetry uses the local Moyo
0.21.0 WASM package; its MIT/Apache notices are under third_party/licenses/moyo/.
Rust/WASM dependency license texts and the locked component inventory are
included under third_party/licenses/browser-rust/.

The first selected-model Run downloads same-origin assets, checks SHA-256 and
stores verified bytes in browser Cache API when allowed. After preparing that
model, the already-open page can calculate NEW inputs without a server. An
unprepared model, browser cache eviction or a page reload may require the static
origin again. No service worker or offline page reload guarantee is supplied.

POSCAR/CIF are periodic; ordinary XYZ is nonperiodic. Invalid drafts preserve the
last valid view and block Run. Stop preserves the last complete snapshot. Choose
the result/history step to download POSCAR/CIF/XYZ or full trajectory JSON.

Known limits: experimental WebGPU, no universal structure-size guarantee, and
Raman/IR physical accuracy is not qualified for arbitrary inputs. MatterSim
large-structure GPU jobs can exceed the 128 MiB requested-buffer gate. GPU final
convergence is checked on CPU; rejected GPU convergence continues as explicitly
labelled CPU refinement. See the acceptance ledger for fixture-specific scope.

INTERNAL EVALUATION CANDIDATE ONLY. This package is not a release or a permission
to redistribute model/third-party components. The repository license does not
establish model or dependency rights. Complete dependency/checkpoint notices,
source obligations, platform/resource validation and publication review remain
open. Provenance/model hashes are in package-manifest.json and the model catalog.
No private/user structure is packaged.

