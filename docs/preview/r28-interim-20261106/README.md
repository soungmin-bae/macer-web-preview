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

Fresh page loads start with the built-in example. Open a saved project explicitly to restore prior work. Edits remain in the current page; verified model cache entries may persist across reloads.

## Sources, licenses and rollback
Open licenses/index.html for component notices and the downloadable source archive.
This repository contains only the selected distribution, not private development history.
Republish a reviewed package to update. Revert the distribution commit to roll back.
Existing tabs keep their loaded code until manually reloaded; do not refresh during a run.
Downloaded/IndexedDB calculations are user-local and not stored in this repository.

## Phonon reference import

Open a user-supplied, uncompressed Phonopy parameter YAML file to show its bands beside the active calculation. The import runs locally and does not retrieve records from a database or upload structure data. This route needs displacement-force records; force-constants-only files and compressed `.xz` archives are not supported. Imported NAC data are not applied. The user must confirm the selected record's license and attribution before import.
