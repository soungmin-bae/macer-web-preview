# phononwebsite viewer source

macer-rust vendors the `StructureViewer` VESTA display implementation from
phononwebsite at revision `cc5d0c7801bcef5b1b43c67fbaa7c4e2d1806b5f`. The
original `structureviewer.js`, `structureviewerbase.js`, `viewermeshes.js`,
`viewergeometry.js`, atomic data, and their local source dependencies are
included under `web/design/vendor/phononwebsite-current/src/` without edits.
The product entry adapts macer's parsed atom list to `StructureViewer`'s
`[type, x, y, z]` structure input and reuses its `updateStructure()` rendering
path. Its bundled renderer includes the upstream Three.js 0.182 dependency.

The phononwebsite VESTA-style display is not the VESTA application and does not
include VESTA's source code. The product retains its own pointer selection,
camera controls, periodic-image display and edit operations.

Audited source hashes:

- `src/structureviewer.js`: `489c75354b3050052e7d44ea7c2cc1052fdab882b90ee7029b73c422c7569ce1`
- `src/structureviewerbase.js`: `a83895255c0f54e236876222d29a2cc0f3a5463724d35db009ff83dccbcb56ec`
- `src/viewermeshes.js`: `b4ddf94f45fdf71878fbb3632e1a846760c7020ccb13edf9b8d5e4334378514b`
- `src/viewergeometry.js`: `db145ab588c510916834f9de2f302223ffd56785ba85170e7619c0b1fda7c44c`
- `src/atomic_data.js`: `ce793c5afa857d7a45f2d7dcf4e408a316f8e149c24dbb1c00db55045e89e20f`

Upstream project: https://github.com/henriquemiranda/phononwebsite
Redistribution is governed by [COPYING](COPYING) (BSD 3-Clause).
