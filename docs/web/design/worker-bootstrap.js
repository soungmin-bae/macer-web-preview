'use strict';

// Fetch and integrity-check the production Worker source only when a Run needs
// it. A cancelled first Run must also cancel this bootstrap request.
globalThis.MacerWorkerBootstrap = Object.freeze({
  create({ fetchImpl = fetch, digest = async bytes => {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } } = {}) {
    let source = null;
    let pending = null;
    let controller = null;

    return Object.freeze({
      load(asset, url) {
        if (source !== null) return Promise.resolve(source);
        if (pending) return pending;

        const requestController = new AbortController();
        controller = requestController;
        pending = (async () => {
          const response = await fetchImpl(url, { cache: 'no-cache', signal: requestController.signal });
          if (!response.ok) throw new Error(`Could not load browser worker (${response.status}).`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (requestController.signal.aborted || controller !== requestController) {
            throw new DOMException('Worker bootstrap cancelled', 'AbortError');
          }
          if (bytes.byteLength !== asset.size_bytes || await digest(bytes) !== asset.sha256) {
            throw new Error('Browser worker size or SHA-256 validation failed.');
          }
          if (requestController.signal.aborted || controller !== requestController) {
            throw new DOMException('Worker bootstrap cancelled', 'AbortError');
          }
          source = new TextDecoder().decode(bytes);
          return source;
        })().finally(() => {
          if (controller === requestController) {
            controller = null;
            pending = null;
          }
        });
        return pending;
      },

      abort() {
        const active = controller;
        controller = null;
        pending = null;
        active?.abort();
      },
    });
  },
});
