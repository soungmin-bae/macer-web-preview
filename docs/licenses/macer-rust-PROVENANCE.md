# Browser response preview provenance

Copyright (c) 2026 Soungmin Bae. Application code is MIT; component-specific
licenses and model/data attribution are retained separately.

Fitted BPM: frozen RamanDB coefficient candidate abf824bf, Rust/F64 periodic
bond-polarizability derivative kernel. CGCNN: expanded-v2 Raman checkpoint
972dfa5c, Born-ASR dbc9bbc1 and electronic dielectric 3fa8bc82. Per-head model
manifests record the full checkpoint/weight hashes. Parameters are exported
from the existing local training runs; no raw CRD database, optimizer state or
training projects are distributed. See ../third_party/licenses/ramandb/NOTICE.md
for CRD and phonondb CC BY 4.0 attribution, changes and scientific limits.

Candle supplies the Rust tensor/autodiff runtime (MIT OR Apache-2.0); local
modifications support response coordinate gradients and safe views. Existing
component notices and licenses are retained. Fitted BPM's serde/wasm-bindgen
dependencies are covered by the included browser-rust license inventory.
The new permissively licensed Rust components do not require an additional
source-code archive for this binary distribution. Historical source archives
remain unchanged and are explicitly historical.

MatterSim1M retains Microsoft's MIT model terms. NEP89 retains its pinned
GPLv3 model notices and original editable model text; no GPUMD executable is
linked. The original model hash remains recorded in its notice. No model is
relicensed under the application MIT license. Phononwebsite uses its BSD-3
license, not the unrelated VESTA application's code.

No runtime response API, Python calculation service or localhost inference
endpoint is used by either comparison model. Structure search separately
contacts Alexandria only after user action, under the existing attribution.
Scientific accuracy, platform/resource qualification and restricted file-flow
tests remain incomplete; this preview is not whole-product qualification.

Channel mixture repair (r24.1): restored the previously offered experimental
relative-profile Worker, analytic response-channel module, and pinned 46,712-byte
model (SHA256 40ac9aa5cdd11f8e63abcd9cd3db56abfdb8bf3ddfab76877a45efc557cca43c).
This existing option executes in a browser JavaScript/F64 Worker, without Python
or a calculation service. It is distinct from the Rust/WASM Fitted BPM and
CGCNN routes. It mixes channel activities and does not return a single material
Raman tensor or absolute cross section. See ../web/design/raman-dft-notice.html
for attribution and retained failed/limited accuracy criteria. Only existing
locally fitted runtime assets are added; no raw data, reports, projects,
optimizer checkpoints, or new source archives are distributed.
