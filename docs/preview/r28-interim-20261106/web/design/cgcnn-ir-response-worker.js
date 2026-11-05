/* CGCNN Born prediction + IR mode projection; all inference remains local. */
import { CgcnnCommonResponseRuntime as Runtime } from './cgcnn-common-response-runtime.js';
import init, { CgcnnResponseSession } from './cgcnn-common-response/cgcnn_common_response.js';

let wasmReady = false;
let session = null;
let loadedBundle = null;
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
async function verified(path, expected, label) {
  const url = new URL(path, self.location.href); url.searchParams.set('v', expected);
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw Error(`Could not load ${label} (${response.status}).`);
  const bytes = await response.arrayBuffer();
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected) throw Error(`${label} SHA-256 mismatch.`);
  return bytes;
}
function geometry(data) {
  const symbols = 'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
  const atomicNumbers = data.atoms.map(atom => symbols.indexOf(atom.element) + 1);
  if (atomicNumbers.some(z => z < 1)) throw Error('The Born model does not recognize an input element.');
  return { cell: data.lattice, fractionalPositions: data.atoms.map(atom => atom.fractional), atomicNumbers, massesAmu: data.atoms.map(atom => atom.mass) };
}
async function loadModel() {
  if (session && loadedBundle === Runtime.born.weightsSha256) return;
  session?.dispose(); session?.free(); session = null;
  const [wasm, manifestBytes, weights] = await Promise.all([
    verified(Runtime.wasm, Runtime.wasmSha256, 'CGCNN response WASM'),
    verified(Runtime.born.manifest, Runtime.born.manifestSha256, 'CGCNN Born manifest'),
    verified(Runtime.born.weights, Runtime.born.weightsSha256, 'CGCNN Born weights'),
  ]);
  if (!wasmReady) { await init(wasm); wasmReady = true; }
  const manifestText = new TextDecoder().decode(manifestBytes);
  const manifest = JSON.parse(manifestText);
  if (manifest.modelId !== Runtime.born.modelId || manifest.checkpointSHA256 !== Runtime.born.checkpointSha256) throw Error('CGCNN Born model identity mismatch.');
  session = new CgcnnResponseSession('born', new Uint8Array(weights), manifestText);
  const id = JSON.parse(session.identity_json());
  if (id.task !== 'born' || id.modelId !== Runtime.born.modelId || id.weightsSha256 !== Runtime.born.weightsSha256 || id.runtime !== 'rust-wasm-cpu-f64') throw Error('CGCNN Born runtime identity mismatch.');
  loadedBundle = Runtime.born.weightsSha256;
}
function projectIR(data, bands, born) {
  const modes = bands.map((band, modeIndex) => {
    let re = [0,0,0], im = [0,0,0];
    for (let i = 0; i < data.atoms.length; i++) for (let a = 0; a < 3; a++) for (let k = 0; k < 3; k++) {
      const z = born.projected[i][a][k] / Math.sqrt(data.atoms[i].mass);
      re[a] += z * band.eigenvector[i][k][0];
      im[a] += z * band.eigenvector[i][k][1];
    }
    const activity = re.reduce((s,x,k) => s + x*x + im[k]*im[k], 0);
    return { modeIndex, frequencyTHz: band.frequencyTHz, frequencyCm: band.frequencyTHz * 1e12 / (299792458 * 100), effectiveChargeReal: re, effectiveChargeImag: im, activity, units: 'e²/amu' };
  });
  return { schema: 'macer-ir-response-v1', tensors: born.projected.map(t => t.flat()), rawTensors: born.raw.map(t => t.flat()),
    neutralityResidual: Math.max(...born.projectedTensorSum.flat().map(Math.abs)), source: 'CGCNN Born model estimate',
    responseRoute: { requestedPath: 'CGCNN Born', actualPath: 'CGCNN Born · predicted', modelId: born.modelId,
      checkpointSha256: born.checkpointSha256, weightsSha256: Runtime.born.weightsSha256,
      qualification: 'EXPOSED_DEVELOPMENT_NOT_ACCURACY_QUALIFIED',
      displayQualification: 'Estimated IR response; accuracy for this structure is not qualified.' },
    prediction: { raw: born.raw, subtractedAtomMean: born.subtractedAtomMean, projected: born.projected,
      projectedTensorSum: born.projectedTensorSum, edgeCount: born.edgeCount }, modes,
    normalization: 'complex coherent mode charge sum from e/sqrt(M); no frequency/Bose prefactor' };
}
self.onmessage = async ({ data: m }) => {
  const context = { jobId: m.jobId, revision: m.revision, inputHash: m.inputHash };
  try {
    if (m.nac || !Array.isArray(m.q) || m.q.some(x => !Number.isFinite(x) || Math.abs(x) > 1e-8)) throw Error('CGCNN IR requires analytic Γ modes without directional NAC.');
    if (!m.data?.atoms?.length || m.bands?.length !== m.data.atoms.length * 3) throw Error('Complete 3N analytic Γ modes are required.');
    postMessage({ ...context, type: 'progress', stage: 'Loading CGCNN Born model…' });
    await loadModel();
    const g = geometry(m.data);
    postMessage({ ...context, type: 'progress', stage: 'Predicting atom-resolved Born tensors…' });
    const born = JSON.parse(session.predict_born_json(JSON.stringify(g)));
    if (born.modelId !== Runtime.born.modelId || born.projected.length !== m.data.atoms.length) throw Error('CGCNN Born output does not match the current structure.');
    const ir = projectIR(m.data, m.bands, born);
    postMessage({ ...context, type: 'finished', ir });
  } catch (error) { postMessage({ ...context, type: 'error', message: error?.message || String(error) }); }
};
self.addEventListener('close', () => { session?.dispose(); session?.free(); session = null; });
