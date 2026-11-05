# Extracted phonors tetrahedron integration

Upstream phonopy/phonors 0.3.0, commit ca6eac4464cea519fef1d6d8018b4d13c20fa84d.
Source: src/tetrahedron_method.rs; BSD-3-Clause, see phonors-v0.3.0-LICENSE.
Local crates/phonon-kernel/src/tetrahedron.rs preserves numerical routines and tests,
replaces common matrix type/helper imports with local definitions, and removes
Python/NumPy/Rayon binding dependencies. dos.rs adds bounded chunk integration.
Atomic projections use invariant degenerate-subspace averaging within 1e-8 THz,
recorded separately from raw phonopy eigensolver-basis projections.
