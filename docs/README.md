# macer web preview

**Latest hands-on preview: r33. Validation is ongoing.** Some numerical, resource and browser acceptance gates remain open. Alexandria structure search depends on its external service and may be unavailable.

Current preview: [r33](./preview/r33-tan-symmetry-20261106/web/design/?v=r33-tan-symmetry-20261106#phonons). It corrects the symmetry lattice-tolerance failure reported for structures such as Nb₃Cl₈. Earlier preview paths remain available. This is an interim review build; scientific and browser qualification gates remain open.

Static browser-only structure editing, MatterSim1M/NEP89 Relax and harmonic phonon preview.
Open index.html through HTTP(S), not file://. No calculation server, Python, PyTorch,
analytics or CDN is used. The selected model is fetched from the same static origin.
CPU/WASM is the default; WebGPU is experimental and device dependent.

## Use
Paste POSCAR/CIF in Phonons, check structure, choose model/supercell and Run.
Initial Relax is enabled; BORN/NAC is off by default. Preview the supercell before Run.
Stop retains completed records. Save project to export or resume. The result includes
bands and eigenvectors; choose a mode and Play. Structure & Relax also supports XYZ.
Large supercells can exceed browser memory. Numerical qualification is incomplete. This public build is shared for review, not as a fully qualified release.

Fresh page loads start with the built-in example. Open a saved project explicitly to restore prior work. Edits remain in the current page; verified model cache entries may persist across reloads.

## Sources, licenses and rollback
Open licenses/index.html for component notices and the downloadable source archive.
This repository contains only the selected distribution, not private development history.
Republish a reviewed package to update. Revert the distribution commit to roll back.
Existing tabs keep their loaded code until manually reloaded; do not refresh during a run.
Downloaded/IndexedDB calculations are user-local and not stored in this repository.
