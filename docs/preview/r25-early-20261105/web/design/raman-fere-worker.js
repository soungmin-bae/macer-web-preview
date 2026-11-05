/* Main-menu Fitted BPM adapter. Numerical model inference is Rust/WASM. */
self.window = self;
importScripts('./raman-fere-model.js');
let cached = null, child = null;
self.onmessage = async ({ data: m }) => {
  const context = { jobId: m.jobId, revision: m.revision, phononHash: m.phononHash, parameterHash: m.parameterHash };
  try {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(self.RamanFEREBundle))))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== m.parameterHash || m.parameterId !== self.RamanFEREBundle.id) throw Error('Fitted BPM model identity mismatch.');
    if (m.reuseCached) {
      if (!cached || cached.phononHash !== m.phononHash || cached.parameterHash !== m.parameterHash) throw Error('Cached Fitted BPM input identity mismatch; resend the complete phonon input.');
    } else {
      if (!m.data?.atoms || !Array.isArray(m.bands) || m.bands.length !== m.data.atoms.length * 3) throw Error('Invalid Fitted BPM Gamma input.');
      cached = { data: m.data, bands: m.bands, phononHash: m.phononHash, parameterHash: m.parameterHash };
    }
    if (!Number.isInteger(m.startIndex) || m.startIndex < 0 || m.startIndex > cached.bands.length) throw Error('Invalid Fitted BPM resume index.');
    const memoryEstimate = cached.data.atoms.length * cached.bands.length * 3 * 2 * 8;
    if (memoryEstimate > 256 * 1024 * 1024) throw Error('Fitted BPM mode estimate exceeds 256 MiB.');
    child?.terminate();
    child = new Worker('./raman-model-comparison-worker.js?v=ec475cdbdc1f8a83');
    child.onerror = () => { postMessage({ ...context, type: 'error', message: 'Fitted BPM Rust/WASM Worker failed.' }); child?.terminate(); child = null; };
    child.onmessage = ({ data: value }) => {
      if (value.requestId !== m.jobId || value.revision !== m.revision || value.phononHash !== m.phononHash) return;
      if (value.type === 'error') postMessage({ ...context, type: 'error', message: value.message });
      else if (value.type === 'result') {
        postMessage({ ...context, type: 'prepared', bondCount: value.diagnostics.periodicBondCount, memoryEstimate, diagnostics: value.diagnostics, model: value.model });
        postMessage({ ...context, type: 'modes', results: value.modes.slice(m.startIndex).map(result => ({ modeIndex: result.modeIndex, result })) });
        postMessage({ ...context, type: 'finished' });
      }
      child?.terminate(); child = null;
    };
    child.postMessage({ requestId: m.jobId, revision: m.revision, phononHash: m.phononHash, q: m.q, nac: m.nacEnabled, data: cached.data, bands: cached.bands });
  } catch (error) { postMessage({ ...context, type: 'error', message: error.message || String(error) }); }
};
