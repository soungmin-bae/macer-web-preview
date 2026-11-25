'use strict';

export const CPD_MAX_INPUT_BYTES = 4 * 1024 * 1024;

export function createCpdWorkerClient({
  WorkerCtor = globalThis.Worker,
  workerUrl = new URL('./cpd-worker.js?v=f4ac83cbe68e3f9cf2798b1d0ebff79eff691221579a1b172298b3a089b09e76', import.meta.url),
} = {}) {
  let worker = null;
  let pending = null;
  let disposed = false;
  let serial = 0;

  const abortError = message => {
    if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  };

  function rejectPending(error) {
    const current = pending;
    pending = null;
    current?.reject(error);
  }

  function terminateWorker() {
    const current = worker;
    worker = null;
    current?.terminate();
  }

  function ensureWorker() {
    if (worker) return worker;
    if (typeof WorkerCtor !== 'function') throw new Error('Web Workers are unavailable in this browser.');
    const instance = new WorkerCtor(workerUrl, { type: 'module', name: 'macer-cpd' });
    instance.addEventListener('message', event => {
      const message = event.data || {};
      if (!pending || message.requestId !== pending.requestId) return;
      if (message.type === 'started') {
        pending.onStarted?.();
      } else if (message.type === 'computing') {
        pending.onComputing?.();
      } else if (message.type === 'result') {
        const current = pending;
        pending = null;
        current.resolve(message.response);
      } else if (message.type === 'error') {
        const current = pending;
        pending = null;
        const error = new Error(message.message || 'CPD worker failed.');
        error.name = message.name || 'Error';
        current.reject(error);
      }
    });
    instance.addEventListener('error', event => {
      if (!pending) return;
      const error = new Error(event.message || 'CPD Worker failed to load.');
      error.name = 'WorkerError';
      rejectPending(error);
      terminateWorker();
    });
    worker = instance;
    return instance;
  }

  function run(input, { onStarted, onComputing } = {}) {
    if (disposed) return Promise.reject(new Error('CPD worker client is disposed.'));
    if (pending) return Promise.reject(new Error('A CPD request is already running.'));
    let inputJson;
    try {
      inputJson = typeof input === 'string' ? input : JSON.stringify(input);
      if (typeof inputJson !== 'string') throw new Error('CPD input must be a JSON value.');
      if (new TextEncoder().encode(inputJson).byteLength > CPD_MAX_INPUT_BYTES) {
        throw new Error(`CPD JSON input exceeds the ${CPD_MAX_INPUT_BYTES} byte limit.`);
      }
      JSON.parse(inputJson);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = `cpd-${Date.now()}-${++serial}`;
    let target;
    try {
      target = ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      pending = { requestId, resolve, reject, onStarted, onComputing };
      try {
        target.postMessage({ type: 'compute', requestId, inputJson });
      } catch (error) {
        pending = null;
        reject(error);
      }
    });
  }

  function cancel() {
    if (!pending) return false;
    // The WASM call is synchronous inside its Worker. Termination is the only
    // reliable interrupt that does not depend on its blocked event loop.
    terminateWorker();
    rejectPending(abortError('CPD calculation cancelled.'));
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    terminateWorker();
    rejectPending(abortError('CPD worker client disposed.'));
  }

  return Object.freeze({ run, cancel, dispose, get busy() { return pending !== null; } });
}
