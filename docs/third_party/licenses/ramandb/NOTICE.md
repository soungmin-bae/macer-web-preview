# Computational Raman Database attribution

The FERE bond-polarizability response coefficients in this preview were fitted from Raman tensors in the Computational Raman Database (CRD), database release v1.0.1. The CRD website states that its database is licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).

- Authors: Mohammad Bagheri and Hannu-Pekka Komsa
- Dataset and source: [Computational Raman Database](https://ramandb.oulu.fi/) · [about and citation](https://ramandb.oulu.fi/about.html)
- Citation: M. Bagheri and H.-P. Komsa, “High-throughput computation of Raman spectra from first principles,” *Scientific Data* 10, 80 (2023), [doi:10.1038/s41597-023-01988-5](https://doi.org/10.1038/s41597-023-01988-5).
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Changes: selected database tensors were used to fit a compact empirical bond-polarizability model; this package contains the fitted coefficients, not the source database archive. The preview does not claim that coefficients are literal atomic polarizabilities or quantitatively accurate for every material.

The FERE implementation and preview code are separate application code. Download the source overlay from [`../../../source/raman-fere-preview-r23.1.tar.gz`](../../../../../source/raman-fere-preview-r23.1.tar.gz) or inspect the individual files in [`../../../web/design/`](../../../web/design/).
