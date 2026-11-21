import init, { compute_cpd_json } from './wasm-cpd/macer_rust_chemical_potential.js?v=2db4150e77f17bd23543bce89541d6473e54919aa13b5b4b4c18be7137b90204';

let wasmReady;
let activeRequestId = null;

self.addEventListener('message', async event => {
  const message = event.data || {};
  if (message.type !== 'compute') return;
  const { requestId, inputJson } = message;
  if (activeRequestId !== null) {
    self.postMessage({ type: 'error', requestId, name: 'BusyError', message: 'This CPD worker already has an active request.' });
    return;
  }
  activeRequestId = requestId;
  self.postMessage({ type: 'started', requestId });
  try {
    wasmReady ||= init({module_or_path: new URL('./wasm-cpd/macer_rust_chemical_potential_bg.wasm?v=6f42ce163ae7e06514969bf828ee9ca33d5bd047b700b758b0298f9792e6ec77', import.meta.url)});
    await wasmReady;
    if (activeRequestId !== requestId) return;
    self.postMessage({ type: 'computing', requestId });
    const responseJson = compute_cpd_json(inputJson);
    const response = JSON.parse(responseJson);
    if (activeRequestId === requestId) self.postMessage({ type: 'result', requestId, response });
  } catch (error) {
    if (activeRequestId === requestId) {
      self.postMessage({
        type: 'error',
        requestId,
        name: typeof error?.name === 'string' ? error.name : 'Error',
        message: typeof error?.message === 'string' ? error.message : String(error),
      });
    }
  } finally {
    if (activeRequestId === requestId) activeRequestId = null;
  }
});
