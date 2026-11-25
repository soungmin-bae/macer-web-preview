import init, { compute_cpd_json } from './wasm-cpd/macer_rust_chemical_potential.js?v=ffa6cf97287c8897173e882d97b0ea31eece95319cc00eaa9fab6f900289c132';

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
    wasmReady ||= init({module_or_path: new URL('./wasm-cpd/macer_rust_chemical_potential_bg.wasm?v=8439d176114a64a7cacc32008c2d78d4ffdfc6364c4111729df1e668f21d4c46', import.meta.url)});
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
