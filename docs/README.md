# macer web preview

Static browser-only structure editing, MatterSim1M/NEP89 Relax and harmonic phonon preview.
Open index.html through HTTP(S), not file://. No calculation server, Python, PyTorch,
analytics or CDN is used. The selected model is fetched from the same static origin.
CPU/WASM is the default; WebGPU is experimental and device dependent.

## Use
Paste POSCAR/CIF in Phonons, check structure, choose model/supercell and Run.
Initial Relax is enabled; BORN/NAC is off by default. Preview the supercell before Run.
Stop retains completed records. Save project to export or resume. The result includes
bands and eigenvectors; choose a mode and Play. Structure & Relax also supports XYZ.
Large supercells can exceed browser memory. Numerical qualification is incomplete.

## Sources, licenses and rollback
Open licenses/index.html for component notices and the downloadable source archive.
This repository contains only the selected distribution, not private development history.
Republish a reviewed package to update. Revert the distribution commit to roll back.
Existing tabs keep their loaded code until manually reloaded; do not refresh during a run.
Downloaded/IndexedDB calculations are user-local and not stored in this repository.

## r15.2: NEP-first menus, explicit input and geometry continuation

Model menus in both workspaces list NEP CPU, NEP WebGPU, MatterSim CPU, then
MatterSim WebGPU; NEP CPU is the initial selection. New pages start with the Si example. Previous inputs/results never restore
automatically; Open project explicitly imports a saved Relax session or phonon
checkpoint. Model/WASM caches remain reusable. After Relax use the final-result
action, then Run Relax to start a fresh optimizer; this is geometry reuse, not
optimizer-state Resume. Earlier runs remain available in the current-page Run
selector and Save Relax project. Selected-step export filenames identify run
and step. NEP downloads use a lossless 3.60MB transport and restore the original
15.62MB text/hash before calculation; original source model and licenses remain.
Chrome/Firefox scoped checks passed; Safari WebDriver is blocked by disabled
remote automation. Full Browser Relax/Phonons qualification remains incomplete.

## r16.1: Alexandria PBE search
Search structures in either workspace; preview and explicitly Use structure.
Applying is undoable, including unfinished phonon input drafts, and never starts a calculation. Search sends query/ID only
to Alexandria PBE; computation remains in your browser. Dataset: CC BY 4.0,
https://alexandria.icams.rub.de/about.html . Provenance and attribution accompany
projects and structure/band exports. No new symmetry or computation kernel ships
in this overlay. Existing scientific/resource qualification remains incomplete.
Rollback: deploy frozen r15.2 commit 5a5ff84148fcc1422d36ae2acebb43f5bb9cec73.

## r17: phonon dimensions and rectangle zoom
Calculated phonon results default to the actual supercell dimensions (Manual or
Auto). Display repeats remain independent from force calculations and support
1–12 per axis. Saved project display overrides take precedence; legacy projects
without saved display settings derive dimensions from their calculation.
Drag a rectangle on DISPERSION to zoom; click selects a mode, Reset zoom or
double-click restores the range. DOS shares the frequency range. No model,
force evaluator, WASM or phonon numerical kernel changes are included.
Known cold-model/source-archive network qualification failures remain open.
Rollback: frozen r16.1 commit b8b12001b285e84e42ea1362ca4a870f5c33150d.

## r18: open structures with any file name
Both structure choosers allow arbitrary names/extensions (0.0, SPOSCAR, CONTCAR,
Unicode names). POSCAR, CIF and XYZ are recognized from content using existing
strict parsers. Relax keeps XYZ nonperiodic; Phonons explain why XYZ has no
periodic cell and retain the current input. Files never start calculations on
import. Reopening the same file works; stale reads/errors cannot overwrite newer
files or edits. Existing numerical engines, model/WASM assets and old failures
remain unchanged. Rollback: frozen r17 commit
5aab586032cc5befdbad2e8f9ea89be9bae1cb88.

## r19: consistent repeated phonons and independent arrows
Selected upstream Ball-and-stick/VESTA style is retained above 1000 displayed atoms.
Repeat changes fit the display while preserving orientation. Atom amplitude and
animated mode arrows are independent; zero atom amplitude keeps animated arrows.
Model/Worker/WASM/calculation data unchanged. Rollback: r18 dc781c4497ad3d2ebb97c098b02521acb7702646.

## r20: visible Alexandria search
Search Alexandria is expanded by default in both workspaces. Opening a page or
switching tabs does not run a search; use Search, preview, then Use structure.
Models, computation and existing search request/validation policies unchanged.
Rollback: r19 e2b9507ebd4a497919b23935e07b97e2e3c633dd.

## r21: hull-sorted search and structure information
Alexandria requests ascending hull distance (then ID), including pagination.
Results/previews show database space-group symbols/numbers. Input and preview
information includes composition, atom count, lattice, volume and a separate
local Moyo space group/point group/crystal system at symprec1e-4 Angstrom.
Analysis runs in a read-only Worker; no idealization, model/optimizer/phonon changes.
Incomplete drafts, nonperiodic structures and analysis failures remain explicit.
Rollback: r20 144804718a195c4086285c3ecf52f68434d31d35.

## r22: run explicitly from a selected preview
A selected search preview has Use preview & Run Relax/Single Point/Phonons at
the ordinary execution controls. It first applies through existing validation,
Undo and provenance handling, then invokes normal Run when its guards allow.
Pending selections cannot run the previous input. Use structure remains apply-only.
Existing models, optimizer, phonon kernels, Worker and WASM files unchanged.
Rollback: r21 95732461f8ade8cf18f7dedc0f1c3933fc881649.
## r23: FERE bond-polarizability Raman preview

Phonon results now include an opt-in Estimated Raman view. The client differentiates a compact bond-polarizability model fitted to RamanDB tensors, derives mode tensors and relative powder activities, and links selected peaks to the corresponding Gamma vibration. A calculated Si Gamma example is available from the empty-results panel. The FERE response bundle is about 16 KiB; this is a qualitative relative preview, not an absolute or universal experimental prediction. Directional NAC modes are not supported by this response path. RamanDB attribution and source files are linked from licenses/index.html. Phonon forces, model execution and calculation settings are unchanged.
Rollback: revert the r23 deployment commit.

## r23.1: Raman preview startup fix
The saved Si Γ example is now available before any phonon result exists. Loading
it initializes the Raman controls and calculates the tensor-derived preview;
opening or calculating any other phonon result also initializes Raman on first
use. The fitted coefficients, phonon calculations and scientific results are
unchanged. Rollback: revert the r23.1 deployment commit to r23.
