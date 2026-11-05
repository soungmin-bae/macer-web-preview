/* Fitted BPM numerical response runs exclusively in Rust/F64 WebAssembly. */
self.window = self;
importScripts('./elements.js');
const ASSETS = Object.freeze({
  model: ['raman-fere-model.js', '138fe2561c2634c3ba7cdda6682d567cfecf9c3f55786ae7409bc242064d9b0f'],
  glue: ['wasm-fitted-bpm/fitted_bpm.js', '852ef25e6876cddaafc0dcaeda33a1213b9785f8e03c04cac7fce2781661e0c7'],
  wasm: ['wasm-fitted-bpm/fitted_bpm_bg.wasm', 'd7611e3aec7b5e0e7f96e47eb084ae26bc7a4570ca951fa82a8b958aab05a1fe']
});
let loading = null;
async function verified([path, hash]) {
  const url = new URL(path, self.location.href); url.searchParams.set('v', hash);
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw Error(`Fitted BPM asset HTTP ${response.status}: ${path}`);
  const bytes = await response.arrayBuffer();
  const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) throw Error(`Fitted BPM asset integrity mismatch: ${path}`);
  return { url: url.href, bytes };
}
async function load() {
  if (!loading) loading = (async () => {
    const [model, glue, wasm] = await Promise.all(Object.values(ASSETS).map(verified));
    importScripts(model.url);
    const module = await import(glue.url);
    await module.default({ module_or_path: wasm.bytes });
    return module;
  })();
  return loading;
}
self.onmessage = async ({ data: message }) => {
  const context = { requestId: message.requestId, revision: message.revision, phononHash: message.phononHash, geometryHash: message.geometryHash };
  let session;
  try {
    if (!Array.isArray(message.q) || message.q.length !== 3 || message.q.some(x => !Number.isFinite(x) || Math.abs(x) > 1e-8) || message.nac) throw Error('Fitted BPM requires analytic Γ modes without directional NAC.');
    if (!message.data || !Array.isArray(message.data.atoms) || !Array.isArray(message.bands) || message.bands.length !== 3 * message.data.atoms.length) throw Error('Fitted BPM requires a complete 3N Γ result.');
    const module = await load();
    const data = { lattice: message.data.lattice, atoms: message.data.atoms.map((atom, index) => {
      const element = self.ElementStyles[atom.element];
      if (!element) throw Error(`Unknown element at atom ${index + 1}.`);
      return { ...atom, atomicNumber: element.atomic_number, covalentRadiusAngstrom: element.covalent_radius_angstrom };
    }) };
    session = new module.FittedBpmSession(JSON.stringify(self.RamanFEREBundle));
    const value = JSON.parse(session.predict_json(JSON.stringify({ data, bands: message.bands, q: message.q, directionalNac: false })));
    postMessage({ ...context, type: 'result', model: { ...value.model, ...JSON.parse(session.identity_json()) }, diagnostics: value.diagnostics, modes: value.modes });
  } catch (error) {
    postMessage({ ...context, type: 'error', message: error.message || String(error) });
  } finally {
    if (session) { session.dispose(); session.free(); }
  }
};
