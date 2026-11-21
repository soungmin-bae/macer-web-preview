import init, { compute_cpd_json } from './wasm-cpd/macer_rust_chemical_potential.js';

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
    wasmReady ||= init();
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
