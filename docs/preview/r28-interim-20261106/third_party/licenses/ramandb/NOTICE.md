# Computational Raman Database attribution

The FERE bond-polarizability preview coefficients and experimental CGCNN
Raman/Born/electronic-dielectric parameters were fitted using response labels from the Computational Raman Database (CRD), release v1.0.1.
The CRD states that its database is available under the Creative Commons
Attribution 4.0 International license (CC BY 4.0).

- Authors: Mohammad Bagheri and Hannu-Pekka Komsa.
- Dataset and attribution: [Computational Raman Database](https://ramandb.oulu.fi/)
  and [About / citation](https://ramandb.oulu.fi/about.html).
- Citation: M. Bagheri and H.-P. Komsa, “High-throughput computation of Raman
  spectra from first principles,” *Scientific Data* 10, 80 (2023),
  [doi:10.1038/s41597-023-01988-5](https://doi.org/10.1038/s41597-023-01988-5).
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Changes: selected database tensors were fitted to a compact empirical
  bond-polarizability model. This package contains fitted coefficients, not a
  copy of the CRD archive. The coefficients are not literal atomic
  polarizabilities and do not guarantee quantitative accuracy for every
  material.

## Expanded CGCNN response preview

The experimental Raman, Born-ASR and electronic dielectric heads are locally
trained macer models, exported without optimizer state or training records as
F64 safetensors for Rust/WASM inference. The original CRD tensors were mapped,
filtered and fitted; the resulting predictions are modifications/estimates,
not original CRD calculations or a copy of the database. Atom-mean ASR
projection and an SPD dielectric representation constrain the outputs; they
do not establish physical accuracy. Born parameters support IR/NAC and do not
replace a Raman polarizability derivative. No CRD author endorsement is implied.

The CRD repository also acknowledges phonon results, including Born charges,
adapted from Atsushi Togo's Phonon Database under CC BY 4.0:
https://github.com/atztogo/phonondb . Retain both source attributions.

## Curated browser reference records

The local browser package also redistributes a curated subset of CRD v1.0.1
structure, Γ-mode, and Raman-tensor records under CC BY 4.0. The archive SHA-256
is `1a03a98877643584ab0139f06879c8668962f89bf8709884751f3bdbdc36c4a4`.
Each record retains its Materials Project ID and links to its CRD source page.
The bundled subset contains only validated 3D records with at most 6 atoms;
other records are not included in the browser package. These are calculated
DFT reference data, not experimental spectra. See
`web/design/references/crd-v1.0.1/NOTICE.md` for the subset details.
The database license and release history are available at
https://github.com/mbagheri20/ramandb/blob/main/LICENSE and
https://github.com/mbagheri20/ramandb .

Frozen source checkpoint identities:

- Raman: `972dfa5c77a99369a91878c97928941506d3dba4deb3ab2e9c9cddd64b61ca6a`
- Born-ASR: `dbc9bbc1e39a3e390b7f0285d2290ce12193f0ce99ce5f8ca00aa6eb2f19fa8d`
- Electronic dielectric: `3fa8bc824b8107f9db8a48bb7dbc3ba76890d4a2d4432bac5c9aafbfd9587d4b`

Per-head manifests identify the exported parameter hashes and supported-element
policy. Observed/trained element coverage is not accuracy qualification.
The Raman/Born/dielectric candidates have no independent blind-accuracy
qualification. Raman spectra are relative response previews using the current
phonon modes, excluding resonance and finite-temperature/anharmonic effects.
