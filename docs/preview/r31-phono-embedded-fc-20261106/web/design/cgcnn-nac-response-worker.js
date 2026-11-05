/* Local CGCNN Born + electronic dielectric prediction for phonon NAC. */
import { CgcnnCommonResponseRuntime as Runtime } from './cgcnn-common-response-runtime.js';
import init, { CgcnnResponseSession } from './cgcnn-common-response/cgcnn_common_response.js';

let wasmReady = false;
let nacSession = null;
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
async function verified(path, expected, label) {
  const url = new URL(path, self.location.href); url.searchParams.set('v', expected);
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw Error(`Could not load ${label} (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected) throw Error(`${label} SHA-256 mismatch.`);
  return bytes;
}
const symbols = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
function geometry(primitive) {
  const atomicNumbers = primitive.atoms.map(atom => symbols.indexOf(atom.element) + 1);
  if (atomicNumbers.some(z => z < 1)) throw Error('CGCNN NAC models do not recognize every primitive element. No fallback was used.');
  return { cell: primitive.cell, fractionalPositions: primitive.atoms.map(atom => atom.fractional), atomicNumbers, massesAmu: primitive.atoms.map(atom => atom.mass) };
}
async function loadModels() {
  const [wasm, bornManifestBytes, bornWeights, dielectricManifestBytes, dielectricWeights] = await Promise.all([
    verified(Runtime.wasm, Runtime.wasmSha256, 'CGCNN response WASM'),
    verified(Runtime.born.manifest, Runtime.born.manifestSha256, 'CGCNN Born manifest'),
    verified(Runtime.born.weights, Runtime.born.weightsSha256, 'CGCNN Born weights'),
    verified(Runtime.dielectric.manifest, Runtime.dielectric.manifestSha256, 'CGCNN dielectric manifest'),
    verified(Runtime.dielectric.weights, Runtime.dielectric.weightsSha256, 'CGCNN dielectric weights'),
  ]);
  if (!wasmReady) { await init(wasm); wasmReady = true; }
  const bornManifest = new TextDecoder().decode(bornManifestBytes), dielectricManifest = new TextDecoder().decode(dielectricManifestBytes);
  for (const [manifest, expected, name] of [[bornManifest, Runtime.born, 'Born'], [dielectricManifest, Runtime.dielectric, 'dielectric']]) {
    const parsed = JSON.parse(manifest);
    if (parsed.modelId !== expected.modelId || parsed.checkpointSHA256 !== expected.checkpointSha256) throw Error(`CGCNN ${name} model identity mismatch.`);
  }
  const bornBytes = new Uint8Array(bornWeights), dielectricBytes = new Uint8Array(dielectricWeights);
  const packedWeights = new Uint8Array(bornBytes.byteLength + dielectricBytes.byteLength);
  packedWeights.set(bornBytes, 0); packedWeights.set(dielectricBytes, bornBytes.byteLength);
  const nacManifest = JSON.stringify({ schema: 'macer-cgcnn-nac-bundle-v1',
    born: { offset: 0, bytes: bornBytes.byteLength, manifestJson: bornManifest },
    dielectric: { offset: bornBytes.byteLength, bytes: dielectricBytes.byteLength, manifestJson: dielectricManifest },
  });
  nacSession = new CgcnnResponseSession('nac-response', packedWeights, nacManifest);
  const identity = JSON.parse(nacSession.identity_json());
  if (identity.task !== 'nac-response' || identity.runtime !== 'rust-wasm-cpu-f64'
      || identity.born?.task !== 'born' || identity.born?.weightsSha256 !== Runtime.born.weightsSha256
      || identity.dielectric?.task !== 'dielectric' || identity.dielectric?.weightsSha256 !== Runtime.dielectric.weightsSha256) {
    throw Error('CGCNN composite NAC runtime identity mismatch.');
  }
}
function tensorLine(values) {
  if (!Array.isArray(values) || values.length !== 9 || values.some(x => !Number.isFinite(x))) throw Error('Predicted BORN tensor is malformed or non-finite.');
  return values.map(x => x.toPrecision(17)).join(' ');
}
function makeBornFile(primitive, born, dielectric) {
  const order = primitive.bornOrder;
  if (!Array.isArray(order) || !order.length) throw Error('The standardized primitive has no independent-atom order.');
  const eps = dielectric.epsilonInfinity.flat();
  if (eps.length !== 9 || eps.some(x => !Number.isFinite(x))) throw Error('Predicted electronic dielectric tensor is malformed or non-finite.');
  if (born.projected.length !== primitive.structure.atoms.length) throw Error('Predicted Born tensors do not match the calculation primitive.');
  const lines = ['14.39965172592227', tensorLine(eps)];
  for (const item of order) {
    if (!Number.isInteger(item.index) || !born.projected[item.index]) throw Error('Independent-atom mapping is inconsistent with predicted Born tensors.');
    lines.push(tensorLine(born.projected[item.index].flat()));
  }
  return lines.join('\n') + '\n';
}
self.onmessage = async ({ data: m }) => {
  const context = { jobId: m.jobId, revision: m.revision, inputHash: m.inputHash };
  try {
    postMessage({ ...context, type: 'progress', stage: 'Loading CGCNN Born and dielectric models…' });
    await loadModels();
    postMessage({ ...context, type: 'progress', stage: 'Predicting Born charges and ε∞…' });
    const g = geometry(m.primitive.structure);
    const nac = JSON.parse(nacSession.predict_nac_json(JSON.stringify(g)));
    const born = nac.born, dielectric = nac.dielectric;
    if (nac.task !== 'nac-response' || nac.models?.task !== 'nac-response') throw Error('CGCNN composite NAC task identity mismatch.');
    if (born.modelId !== Runtime.born.modelId || dielectric.modelId !== Runtime.dielectric.modelId) throw Error('CGCNN NAC model identity mismatch.');
    if (born.projected.length !== g.atomicNumbers.length || dielectric.epsilonInfinity.length !== 3) throw Error('CGCNN NAC outputs do not match the calculation primitive.');
    const bornText = makeBornFile(m.primitive, born, dielectric);
    postMessage({ ...context, type: 'finished', bornText, models: {
      born: { modelId: born.modelId, checkpointSha256: born.checkpointSha256, weightsSha256: Runtime.born.weightsSha256, runtime: 'rust-wasm-cpu-f64' },
      dielectric: { modelId: dielectric.modelId, checkpointSha256: dielectric.checkpointSha256, weightsSha256: Runtime.dielectric.weightsSha256, runtime: 'rust-wasm-cpu-f64' },
    }, diagnostics: { rawBorn: born.raw, projectedBorn: born.projected, subtractedAtomMean: born.subtractedAtomMean, projectedTensorSum: born.projectedTensorSum, epsilonLog: dielectric.logEpsilon, epsilonInfinity: dielectric.epsilonInfinity, epsilonEigenvalues: dielectric.epsilonEigenvalues, edgeCount: born.edgeCount } });
  } catch (error) { postMessage({ ...context, type: 'error', message: error?.message || String(error) }); }
};
self.addEventListener('close', () => { nacSession?.dispose(); nacSession?.free(); nacSession = null; });
