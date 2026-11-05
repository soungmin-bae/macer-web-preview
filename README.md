# macer web preview

Latest hands-on preview: https://soungmin-bae.github.io/macer-web-preview/preview/r28-interim-20261106/web/design/

Experimental client-only MatterSim1M/NEP89 structure Relax and harmonic phonons.
No computation server or analytics. Model and app files are served by GitHub Pages;
structure input, model inference, optimization and results remain in the browser.

## Distribution
`docs/` is a reviewed static package served from main:/docs, following the simple
GANSU Lite static deployment pattern. The original development repository remains private.
App code MIT; model and component terms retained individually. NEP89 is GPLv3,
MatterSim1M MIT. See docs/licenses/index.html and docs/licenses/public-preview-review.json.
The preferred model text and browser/dependency source archive are provided on the site.
No private structures, original Git history, credentials or automation memory included.

## Preview status
Numerical and resource qualification is incomplete. WebGPU depends on browser/hardware.
Large supercells can exceed memory. Initial Relax and finite-difference forces are real;
BORN/NAC is opt-in and requires appropriate tensors. r28 can import a user-selected
uncompressed Phonopy displacement-force YAML locally for a separate reference-band view;
this does not fetch database records or apply imported NAC. Full qualification remains open.

## Updating / rollback
Add each hands-on build under a new versioned directory in `docs/preview/` and update
the landing page to link it. Older previews stay available; revert the distribution
commit to restore the previous landing page. Existing tabs are not forced to refresh.
Source download: `docs/source/browser-source.tar.gz`.
