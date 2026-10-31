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
