# UFF-derived prior table

`web/design/universal-ir-ct1-model.js` packages median elemental `xiUFF`,
`hardnessUFF`, and `radiusUFF` values extracted from RDKit UFF atom-type
parameters. These neutral-atom values are used only as priors in an explicitly
unqualified estimated-dynamic-charge model; they are not ionic Born charges.

- Source: [RDKit `Code/ForceField/UFF/Params.cpp`](https://github.com/rdkit/rdkit/blob/237a1d9027c800784afed8788540f38a3aa595f8/Code/ForceField/UFF/Params.cpp)
- Pinned revision: `237a1d9027c800784afed8788540f38a3aa595f8`
- Source SHA-256: `635cd03390bbcbc9b2f1fb37dce31cee78483f172d05906ab070d531882857e8`
- Derived table: 94 elements, median across source atom types; see the model
  manifest for per-element source ranges and the generated property-table hash.
- License: RDKit BSD 3-Clause. The pinned license text is in [LICENSE.txt](LICENSE.txt).

The fitted CT1 coefficients are a separate exploratory fit against DFT Born
tensors. The property-table license does not validate or endorse that model.
