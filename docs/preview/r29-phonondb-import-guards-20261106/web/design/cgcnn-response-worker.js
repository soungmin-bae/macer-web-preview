/* Client-only CGCNN Raman v2 inference. All model and response work stays in this Worker. */
// Version the runtime-manifest import with the exact response binary. This avoids
// pairing an updated WASM with a stale cached integrity manifest on static hosts.
const workerURL = new URL(self.location.href);
const runtimeAssetVersion = workerURL.searchParams.get('runtime') || workerURL.searchParams.get('v') || 'dev';
let workerHandlerReady = false;
const pendingMessages = [];
self.onmessage = ({ data: message }) => {
  if (!workerHandlerReady) {
    pendingMessages.push(message);
    return;
  }
  void handleMessage(message);
};
postMessage({ type: 'booted', runtimeAssetVersion, workerAssetVersion: workerURL.searchParams.get('v') || 'dev' });
await import(`./cgcnn-response-runtime.js?v=${encodeURIComponent(runtimeAssetVersion)}`);
postMessage({ type: 'runtime-ready', runtimeAssetVersion });
import initCgcnnWasm, { CgcnnRamanSession } from './cgcnn-response/cgcnn_response.js';

const ATOMIC_SYMBOLS = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');

let session = null;
let loadedIdentity = null;
let activeContext = null;
const progress = (stage, extra = {}) => {
  if (activeContext) postMessage({ ...activeContext, type: 'progress', stage, ...extra });
};
const digestHex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');
const jsonHash = async value => digestHex(new TextEncoder().encode(JSON.stringify(value)));

async function fetchVerified(url, expectedHash, label) {
  const versionedURL = new URL(url);
  versionedURL.searchParams.set('v', expectedHash);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(versionedURL, { credentials: 'omit', cache: 'force-cache', signal: controller.signal });
    if (!response.ok) throw new Error(`Could not load CGCNN ${label} (${response.status}): ${versionedURL}`);
    const bytes = await response.arrayBuffer();
    const actualHash = await digestHex(bytes);
    if (actualHash !== expectedHash) throw new Error(`CGCNN ${label} SHA-256 mismatch.`);
    return bytes;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`CGCNN ${label} request timed out after 30 s: ${versionedURL}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function makeGeometry(data) {
  const atomicNumbers = data.atoms.map(atom => {
    const atomicNumber = ATOMIC_SYMBOLS.indexOf(atom.element) + 1;
    if (atomicNumber < 1) throw new Error(`CGCNN does not recognize element ${atom.element}.`);
    return atomicNumber;
  });
  return {
    cell: data.lattice,
    fractionalPositions: data.atoms.map(atom => atom.fractional),
    atomicNumbers,
    massesAmu: data.atoms.map(atom => atom.mass),
  };
}

function makeModes(bands) {
  return bands.map((band, index) => {
    if (!Array.isArray(band.eigenvector)) throw new Error(`Gamma mode ${index + 1} has no eigenvector.`);
    const eigenvectorReal = [];
    const eigenvectorImag = [];
    for (const atom of band.eigenvector) {
      for (const component of atom) {
        if (!Array.isArray(component) || component.length !== 2) throw new Error(`Gamma mode ${index + 1} has invalid complex eigenvectors.`);
        eigenvectorReal.push(component[0]);
        eigenvectorImag.push(component[1]);
      }
    }
    return { frequencyThz: band.frequencyTHz, eigenvectorReal, eigenvectorImag };
  });
}

async function ensureModel(context) {
  const runtime = globalThis.CgcnnRamanRuntime;
  if (runtime.id !== 'cgcnn-response-expanded-v2-raman' || runtime.qualification !== 'RESEARCH_PREVIEW_NOT_ACCURACY_QUALIFIED') {
    throw new Error('CGCNN runtime identity is not the approved local preview bundle.');
  }
  const expectedParameterHash = await jsonHash(runtime);
  if (expectedParameterHash !== context.parameterHash) throw new Error('CGCNN runtime parameter hash mismatch.');
  if (context.parameterId !== runtime.id) throw new Error('CGCNN runtime model ID mismatch.');
  if (session && loadedIdentity === runtime.bundleSHA256) return;

  session?.dispose();
  session?.free();
  session = null;
  const base = new URL(runtime.assetBase, self.location.href);
  progress('Fetching and verifying local model assets…');
  const [manifestBytes, weightBytes, wasmBytes, wasmGlueBytes, wasmSnippetBytes] = await Promise.all([
    fetchVerified(new URL(runtime.manifestFile, base), runtime.manifestSHA256, 'manifest'),
    fetchVerified(new URL(runtime.weightsFile, base), runtime.weightsSHA256, 'weights'),
    fetchVerified(new URL(runtime.wasmFile, base), runtime.wasmSHA256, 'WASM'),
    // All runtime asset paths are relative to the declared asset base. Resolving
    // these two from the Worker URL incorrectly escaped /web/design/ when a
    // repository-root static server (or Pages subpath) served the app.
    fetchVerified(new URL(runtime.wasmJsFile, base), runtime.wasmJsSHA256, 'WASM loader'),
    fetchVerified(new URL(runtime.wasmSnippetFile, base), runtime.wasmSnippetSHA256, 'WASM snippet'),
  ]);
  const manifestText = new TextDecoder().decode(manifestBytes);
  const manifest = JSON.parse(manifestText);
  if (manifest.modelId !== runtime.id || manifest.checkpointSHA256.toLowerCase() !== runtime.checkpointSHA256.toLowerCase()) {
    throw new Error('CGCNN model manifest does not match the pinned checkpoint.');
  }
  progress('Initializing local WASM runtime…');
  // wasm-bindgen's `web` output is an ES module; its `no-modules` output
  // requires CommonJS `require()` for Candle snippets and cannot run in a browser.
  await initCgcnnWasm(wasmBytes);
  progress('Loading CGCNN weights…');
  session = new CgcnnRamanSession(new Uint8Array(weightBytes), manifestText);
  loadedIdentity = runtime.bundleSHA256;
}

async function handleMessage(message) {
  const context = {
    jobId: message.jobId,
    revision: message.revision,
    phononHash: message.phononHash,
    parameterHash: message.parameterHash,
  };
  activeContext = context;
  try {
    progress('Validating request…');
    if (!Array.isArray(message.q) || message.q.length !== 3 || message.q.some(value => !Number.isFinite(value) || Math.abs(value) > 1e-8) || message.nacEnabled) {
      throw new Error('CGCNN response requires analytic q=(0,0,0), without directional NAC.');
    }
    if (!message.data || !Array.isArray(message.data.atoms) || !Array.isArray(message.bands) || message.bands.length !== message.data.atoms.length * 3) {
      throw new Error('Invalid CGCNN structure or Gamma mode count.');
    }
    await ensureModel({ ...message, parameterId: message.parameterId });
    progress('Preparing periodic geometry…');
    const geometry = makeGeometry(message.data);
    const bands = makeModes(message.bands);
    const preflight = JSON.parse(session.preflight_json(JSON.stringify(geometry)));
    postMessage({ ...context, type: 'prepared', pairCount: null, candidates: null, memoryEstimate: preflight.estimatedWorkspaceBytes, modelId: globalThis.CgcnnRamanRuntime.id });
    postMessage({ ...context, type: 'progress', stage: 'Forward + six coordinate derivatives + mode contraction' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const response = JSON.parse(session.predict_json(JSON.stringify({ geometry, modes: bands })));
    if (response.modes.length !== bands.length || response.checkpointSha256 !== globalThis.CgcnnRamanRuntime.checkpointSHA256) {
      throw new Error('CGCNN response output identity or mode count mismatch.');
    }
    const modes = response.modes.slice(message.startIndex || 0).map(row => ({
      modeIndex: row.modeIndex,
      result: {
        modeIndex: row.modeIndex,
        frequencyTHz: row.frequencyThz,
        frequencyCm: row.frequencyCm,
        tensorReal: row.tensorReal,
        tensorImag: row.tensorImag,
        activity: row.activity,
        activityPerVolume: row.activityPerVolume,
        status: row.frequencyThz < 0 ? 'Imaginary' : row.frequencyThz < 0.1 ? 'Near zero' : 'Optical-frequency',
        responseKind: 'cgcnn-v2-wasm-mode-tensor',
        tensorAvailable: true,
      },
    }));
    postMessage({ ...context, type: 'modes', results: modes, responseSummary: { edgeCount: response.edgeCount, estimatedWorkspaceBytes: response.estimatedWorkspaceBytes, runtime: response.runtime } });
    postMessage({ ...context, type: 'finished' });
  } catch (error) {
    postMessage({ ...context, type: 'error', message: error?.message || String(error) });
  } finally {
    activeContext = null;
  }
}

self.addEventListener('message', ({ data }) => {
  if (data?.type === 'dispose') {
    session?.dispose();
    session?.free();
    session = null;
    loadedIdentity = null;
  }
});
workerHandlerReady = true;
for (const message of pendingMessages.splice(0)) void handleMessage(message);
