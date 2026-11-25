import { createCpdWorkerClient } from './cpd-worker-client.js?v=bdb7d5bb551fa7ee871aa8fdeff9de3d543798d241242b8170fbe89504d28472';

const CPD_MU_UNIT = 'eV/atom';
const $ = id => document.getElementById(id);
const Contract = globalThis.PhaseDatasetContract;
const Provider = globalThis.AlexandriaPhaseProvider;
const Project = globalThis.CalculationProject;
const Queue = globalThis.CalculationQueue;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const atomicNumber = symbol => globalThis.ElementStyles?.[symbol]?.atomic_number || null;
const shaBytes = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
const identity = model => Object.fromEntries(['model_id', 'version', 'engine_format', 'model_format', 'weights_sha256', 'manifest_sha256', 'engine_sha256'].map(key => [key, model[key]]));
let collection = null, dataset = null, importedBundle = null, modelCatalog = null, worker = null, workerUrl = null, modelLoadPromise = null, loadedModelKey = null, activeRun = null, queue = null, queueStore = null, cpdClient = null, providerController = null, cpdResult = null, energySet = null, referenceSet = null, lastEnergySummary = null;
let dopants = [];
const MAX_DOPANTS = 3;
const MAX_CPD_ELEMENTS = 6;
const MAX_PHASES = 12;
const dopantSlotCount = hostSize => hostSize < 2 ? 0 : Math.max(0, Math.min(MAX_DOPANTS, MAX_CPD_ELEMENTS - hostSize));
let targetPhase = null, actionPending = false, displayedTarget = null, activeVertex = null, plotTurns = 0;
let relaxedHost = null, perfectVacancyHost = null, setupRelaxation = null;
let appliedTargetText = '', sourceTargetText = null, sourceTargetFormat = 'poscar', targetFrame = 'input';
let targetEditTimer = null;
let relaxingSetupTarget = false;
const cpdRelaxSettings = Object.freeze({mode: 'isif3', optimizer: 'lbfgs', maxSteps: 500, forceToleranceEvA: 0.01, stressToleranceGpa: 0.1});
const modelIdentity = model => ({modelKey: model.model_key, modelId: model.model_id, weightsSha256: model.weights_sha256});
const pendingTargetEdits = () => $('defects-target-poscar').value !== appliedTargetText;
function currentSetupRelaxation() {
  return setupRelaxation && setupRelaxation.target === targetPhase && setupRelaxation.model.modelKey === selectedModel()?.model_key
    ? setupRelaxation : null;
}
function setupReady() {
  return !pendingTargetEdits() && !!(currentSetupRelaxation() || (importedBundle && targetPhase && energyEntry(targetPhase.phaseId)));
}
const vacancyResults = new Map(), vacancyFailures = new Map();
const relaxedPhasesByEnergySet = new WeakMap();
const defectViewers = new Map();
let shownTargetFrame = null, inspectedVacancy = null, localAtom = -1, localDisplayAtoms = [];
let nearCubicCandidate = null, appliedNearCubic = null;
let vacancyPreview = null, draftSupercell = null, selectedVacancy = null, cpdViewer = null, onCpd3dVertex = null, onCpd3dPick = null;
let cpdProjection = null, pickedCpdPotentials = null, cpdSelectionMarker = null;
const currentCpdPotentials = () => pickedCpdPotentials ?? cpdResult?.vertices[activeVertex]?.delta_mu_ev_per_atom;
const currentCpdLabel = () => pickedCpdPotentials ? 'Selected point' : `Vertex ${vertexLabel(activeVertex)}`;
let interstitialSiteSeparation = $('defects-interstitial-separation').valueAsNumber;
const providerStore = Provider.createIndexedDbCheckpointStore();
const collectionKey = () => `cpd:${selectedElements().join('-').toLowerCase()}${dopants.length ? `:dopant-${dopants.slice().sort().join('-').toLowerCase()}` : ''}`;
const setStatus = (id, message, state = 'info') => { const node = $(id); node.textContent = message; node.dataset.state = state; };
function clearCpdPresentation() {
  for (const id of ['defects-cpd-caution','defects-neutral-caution','defects-energy-caution']) if ($(id)) $(id).hidden = true;
  cpdResult = null;
  cpdProjection = null;
  $('defects-cpd-projection-vertices').hidden = true;
  appliedNearCubic = null;
  resetNearCubicCandidates();
  clearVacancyPreview();
  activeVertex = null;
  pickedCpdPotentials = null;
  cpdSelectionMarker = null;
  plotTurns = 0;
  $('defects-neutral-step').hidden = true;
  $('defects-reservoir-summary').textContent = '';
  $('defects-results').hidden = true;
  $('defects-cpd-unavailable').hidden = true;
  $('defects-cpd-explorer').hidden = false;
  delete $('defects-cpd-explorer').dataset.reservoirReady;
  $('defects-result-summary').textContent = '';
  $('defects-phase-usage').open = false;
  $('defects-phase-usage-list').replaceChildren();
  $('defects-vertices').replaceChildren();
  $('defects-cpd-plot').replaceChildren();
  $('defects-cpd-3d').hidden = true;
  $('defects-cpd-legend').replaceChildren();
  $('defects-cpd-readout').hidden = true;
  $('defects-vertex-detail').textContent = '';
}

async function loadCatalog() {
  const response = await fetch('./model-catalog.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`);
  modelCatalog = await response.json();
  const select = $('defects-model'); select.replaceChildren();
  for (const model of modelCatalog.models || []) {
    const option = document.createElement('option'); option.value = model.model_key; option.textContent = `${model.display_name} · ${model.backend}`; select.append(option);
  }
  if (!select.options.length) throw new Error('No available energy/force model is in the catalog.');
  select.value = modelCatalog.models.find(model => model.model_id === 'nep89-20250409')?.model_key || select.options[0].value;
  renderSetup();
  syncModelSupport();
}

function selectedModel() { return modelCatalog?.models.find(model => model.model_key === $('defects-model').value) || null; }
function hostElements() {
  if (!targetPhase) return [];
  return [...new Set(targetPhase.structure.atoms.map(atom => atom.element))]
    .sort((a, b) => atomicNumber(a) - atomicNumber(b));
}
function selectedElements() {
  return [...hostElements(), ...dopants].sort((a, b) => atomicNumber(a) - atomicNumber(b));
}
function applyDopants(next) {
  if (actionPending) return;
  if (next.length === dopants.length && next.every(symbol => dopants.includes(symbol))) return;
  dopants = next;
  dataset = collection = importedBundle = energySet = referenceSet = lastEnergySummary = null;
  renderPhaseList();
  clearCpdPresentation();
  setStatus('defects-source-status', 'Find competing phases for the updated chemical system.');
  setStatus('defects-run-status', '');
  if (!currentSetupRelaxation()) setStatus('defects-target-relax-status', 'Relax the target before selecting competing phases.');
  renderSetup();
  syncModelSupport();
}
const supportsCpd = count => count >= 2 && count <= MAX_CPD_ELEMENTS;
const supportsPhaseSearch = count => count >= 2 && count <= Provider.MAX_SYSTEM_ELEMENTS;
const collectionLimitReached = () => collection &&
  (collection.pageCount >= collection.config.maxPages || collection.recordCount >= collection.config.maxRecords);
function cpdAvailability(count) {
  const next = supportsPhaseSearch(count)
    ? 'You can still search and review competing phases.'
    : `Alexandria competing-phase search supports 2–${Provider.MAX_SYSTEM_ELEMENTS} elements.`;
  return `Browser CPD supports 2–${MAX_CPD_ELEMENTS} elements. This chemical system has ${count}. ${next}`;
}
function syncModelSupport() {
  const model = selectedModel();
  const unsupported = selectedElements().filter(symbol => !model?.supported_atomic_symbols?.includes(symbol));
  $('defects-model').setCustomValidity(unsupported.length ? `${model?.display_name || 'Model'} does not support ${unsupported.join(', ')}.` : '');
  if (unsupported.length && supportsCpd(dataset?.chemicalSystem.length)) setStatus('defects-run-status', `${model?.display_name || 'Model'} does not support ${unsupported.join(', ')}. Choose another listed model or import its precomputed energy bundle.`, 'warning');
  syncButtons();
}

// Keep the chosen target's exact geometry, even when it sits outside the PBE cutoff.
async function setTarget(structure, source, sourceText = null, format = 'poscar') {
  if (!structure?.pbc?.every(Boolean) || !structure.cell) throw new Error('Choose an ordered, fully periodic POSCAR or CIF.');
  const geometry = {
    cell: clone(structure.cell), pbc: [true, true, true],
    atoms: structure.atoms.map(atom => ({
      element: atom.element,
      fractional: globalThis.Structures.fractional(atom.position, structure.cell),
    })),
  };
  Contract.validateStructure(geometry, 'Target');
  const phaseId = source.provider === 'Alexandria' ? 'alexandria-pbe:' + source.recordId : 'target:' + await Contract.sha256(geometry);
  setupRelaxation = relaxedHost = null;
  sourceTargetText = sourceText;
  sourceTargetFormat = format;
  targetPhase = {phaseId, structure: geometry, source, ...(source.formula ? {formula: source.formula} : {})};
  const elements = hostElements();
  dopants = dopants.filter(symbol => !elements.includes(symbol)).slice(0, dopantSlotCount(elements.length));
  $('defects-legacy-target-wrap').hidden = true;
  dataset = collection = importedBundle = energySet = referenceSet = lastEnergySummary = null;
  renderPhaseList();
  clearCpdPresentation();
  renderSetup();
  setStatus('defects-active-target', `${phaseFormula(targetPhase)} · ${source.recordId} · ${geometry.atoms.length} atoms`);
  setStatus('defects-source-status', 'Choose Find competing phases to load candidates.');
  setStatus('defects-target-relax-status', 'Relax the target before selecting competing phases.');
  setStatus('defects-run-status', 'Relax the target and select competing phases before starting the calculation.');
}

function withTarget(base) {
  if (!targetPhase) return base;
  const phases = base.phases.slice();
  const matching = phases.findIndex(phase => phase.phaseId === targetPhase.phaseId);
  if (matching < 0) phases.unshift(targetPhase);
  else phases[matching] = {...phases[matching], structure: targetPhase.structure};
  return Contract.validateDataset({...base, phases});
}

async function performAction(statusId, operation) {
  if (actionPending) return;
  actionPending = true;
  syncButtons();
  try { await operation(); }
  catch (error) { setStatus(statusId, error.message, 'error'); }
  finally {
    actionPending = false;
    if (document.querySelector('.app')?.dataset.activeWorkspace !== 'defects') releaseModelWorker();
    syncButtons();
  }
}

function phaseFormula(phase, subscripts = true) {
  const S = globalThis.Structures;
  return S.formatComposition(S.elementCounts(phase.structure.atoms), {reduce: true, subscripts});
}
function selectedPhaseIds() { return new Set([...$('defects-phase-browser').querySelectorAll('input[data-phase]:checked')].map(input => input.dataset.phase)); }
function phaseRecord(id) { return dataset?.phases.find(phase => phase.phaseId === id); }
function energyEntry(id) { return energySet?.entries.find(entry => entry.phaseId === id && entry.status === 'converged'); }

function defectViewer(kind, onSelect) {
  if (!defectViewers.has(kind)) {
    const canvas = $(`defects-${kind}-canvas`);
    const viewer = globalThis.CrystalViewer.create(canvas, onSelect);
    if (kind !== 'target') canvas.addEventListener('crystal-viewer-tool', event => viewer.setInteractionMode(event.detail.mode));
    $(`defects-${kind}-fit`).onclick = () => viewer.fitCamera({preserveOrientation: kind !== 'target'});
    defectViewers.set(kind, viewer);
  }
  return defectViewers.get(kind);
}

function geometryForViewer(geometry) {
  return {cell: geometry.cell_a, pbc: geometry.pbc,
    atoms: geometry.positions_a.map((position, i) => ({
      position, element: globalThis.Structures.elementSymbol(geometry.atomic_numbers[i]),
    }))};
}

const targetDisplay = {structure: null, conventional: null, request: null, repeats: [1, 1, 1], styles: {}};
const targetControls = () => $('defects-target-view');
const targetRepeats = () => ['a', 'b', 'c'].map(axis => $(`defects-target-repeat-${axis}`));
function targetViewNote(message = '') {
  const status = $('defects-target-view-status');
  status.textContent = message;
  status.hidden = !message;
}
function setTargetRepeats(values) {
  targetRepeats().forEach((input, i) => { input.value = values[i]; });
}
function targetAppearance() {
  const style = $('defects-target-style').value;
  const bondMode = $('defects-target-bond-mode').value;
  const sharedRenderer = style === 'ball-and-stick' || style === 'phonon-vesta';
  const {bondColorByAtom, bondColor, bondCutoffScale} = globalThis.CommonDisplay.frame();
  return {stylePreset: sharedRenderer ? 'phonon-vesta' : style, instancedLargeStructure: sharedRenderer,
    vestaDisplay: style === 'phonon-vesta' ? 'vesta' : 'jmol', elementStyles: targetDisplay.styles,
    bondColorByAtom, bondColor, bondCutoffScale,
    showCell: $('defects-target-cell').checked, showBonds: $('defects-target-bonds').checked,
    showBoundary: $('defects-target-boundary').checked, showNeighbors: $('defects-target-neighbors').checked,
    atomScale: Number($('defects-target-atom-size').value), bondScale: Number($('defects-target-bond-size').value),
    bondMode, repeats: targetDisplay.repeats};
}
function targetInstanceCount(structure, repeats) {
  const {showBoundary, showNeighbors, bondMode} = targetAppearance();
  return globalThis.CrystalViewer.displayInstances(structure, repeats, showBoundary, showNeighbors, bondMode).length;
}
function drawTarget() {
  const structure = targetDisplay.conventional || targetDisplay.structure;
  if (!structure) return;
  const viewer = defectViewer('target');
  const display = targetAppearance();
  viewer.setFrame({structure, display, selectionIds: [], atomDragEnabled: false});
  $('defects-target-conventional').disabled = !structure.cell || !!targetDisplay.request;
  for (const [id, active] of [['defects-target-input-cell', !targetDisplay.conventional], ['defects-target-conventional', !!targetDisplay.conventional]]) {
    $(id).classList.toggle('selected', active);
    $(id).setAttribute('aria-pressed', String(active));
  }
  for (const button of targetControls().querySelectorAll('[data-target-repeat]')) {
    button.setAttribute('aria-pressed', String(display.repeats.every(value => value === Number(button.dataset.targetRepeat))));
  }
  for (const [id, scale] of [['atom', display.atomScale], ['bond', display.bondScale]]) {
    $(`defects-target-${id}-size-value`).value = `${scale.toFixed(2)}×`;
  }
  $('defects-target-bonds').disabled = display.stylePreset === 'space-filling';
  $('defects-target-bond-mode').disabled = $('defects-target-style').value === 'phonon-vesta' || display.stylePreset === 'space-filling';
  $('defects-target-count').textContent = `${structure.atoms.length} atoms · ${viewer.getDisplayStats().atomInstances} shown · display only`;
}
function syncTargetElement() {
  const symbol = $('defects-target-element').value;
  const style = targetDisplay.styles[symbol];
  $('defects-target-color').value = style?.color || globalThis.ElementStyles[symbol]?.color || '#8fa7ba';
  const size = style?.radius_scale ?? 1;
  $('defects-target-element-radius').value = size;
  $('defects-target-element-radius-value').value = `${size.toFixed(2)}×`;
}
function currentRelaxedTargetGeometry() {
  if (!targetPhase) return null;
  const energy = energyEntry(targetPhase.phaseId);
  return currentSetupRelaxation()?.result.geometry ||
    (relaxedHost?.phaseId === targetPhase.phaseId && relaxedHost.hash === energy?.finalGeometrySha256
      ? relaxedHost.geometry : null);
}

function syncTargetEditorFrame(relaxed = currentRelaxedTargetGeometry()) {
  const viewingRelaxed = !!relaxed && targetFrame === 'relaxed';
  $('defects-target-poscar').hidden = viewingRelaxed;
  const output = $('defects-relaxed-poscar');
  output.hidden = !viewingRelaxed;
  $('defects-copy-relaxed-poscar').hidden = !relaxed;
  $('defects-target-editor-frame').textContent = viewingRelaxed ? 'Relaxed structure' : 'Valid edits update automatically';
  if (viewingRelaxed) {
    const format = $('defects-target-format').value;
    const serialize = format === 'cif' ? globalThis.Structures.toCif : globalThis.Structures.toPoscar;
    const text = serialize(geometryForViewer(relaxed), 'Relaxed defects target');
    if (output.value !== text) output.value = text;
  } else output.value = '';
}

function showTargetStructure(reset = false) {
  targetControls().hidden = !targetPhase;
  if (!targetPhase) { shownTargetFrame = null; targetDisplay.structure = null; syncTargetEditorFrame(null); return; }
  const relaxed = currentRelaxedTargetGeometry();
  $('defects-show-relaxed').disabled = !relaxed;
  if (reset || !relaxed) targetFrame = 'input';
  syncTargetEditorFrame(relaxed);
  $('defects-show-input').setAttribute('aria-pressed', String(targetFrame === 'input'));
  $('defects-show-relaxed').setAttribute('aria-pressed', String(targetFrame === 'relaxed'));
  const chosen = targetFrame === 'relaxed' ? relaxed : targetPhase;
  if (shownTargetFrame === chosen && !reset) return;
  shownTargetFrame = chosen;
  targetDisplay.structure = geometryForViewer(chosen === relaxed ? relaxed : phaseToGeometry(targetPhase));
  targetDisplay.conventional = targetDisplay.request = null;
  if (reset) {
    targetDisplay.repeats = [1, 1, 1];
    setTargetRepeats(targetDisplay.repeats);
  }
  const element = $('defects-target-element'), previous = element.value;
  element.replaceChildren(...[...new Set(targetDisplay.structure.atoms.map(atom => atom.element))]
    .map(symbol => new Option(symbol, symbol)));
  if ([...element.options].some(option => option.value === previous)) element.value = previous;
  syncTargetElement();
  targetViewNote();
  drawTarget();
  defectViewer('target').fitCamera({preserveOrientation: !reset});
}
async function conventionalCell(structure) {
  const {fractional, atomicNumber} = globalThis.Structures;
  const moyo = await globalThis.PhononSymmetry.loadMoyo();
  const cell = {lattice: {basis: structure.cell.flat()},
    positions: structure.atoms.map(atom => fractional(atom.position, structure.cell)),
    numbers: structure.atoms.map(atom => atomicNumber(atom.element))};
  const result = moyo.analyze_cell(JSON.stringify(cell), 1e-4, 'Standard');
  const conventional = globalThis.InputSymmetry.standardStructure(result.std_cell, 'Conventional cell');
  if (!conventional) throw new Error('The conventional cell is unavailable for this structure.');
  return conventional;
}

async function useTargetConventional() {
  const structure = targetDisplay.structure;
  if (!structure?.cell || targetDisplay.request || targetDisplay.conventional) return;
  targetDisplay.request = structure;
  $('defects-target-conventional').disabled = true;
  targetViewNote('Preparing the conventional cell…');
  try {
    const conventional = await conventionalCell(structure);
    if (targetDisplay.request !== structure || targetDisplay.structure !== structure) return;
    targetDisplay.conventional = conventional;
    if (targetInstanceCount(conventional, targetDisplay.repeats) > 5000) {
      targetDisplay.repeats = [1, 1, 1];
      setTargetRepeats(targetDisplay.repeats);
    }
    targetViewNote();
  } catch (error) {
    if (targetDisplay.request === structure) targetViewNote(error.message);
  } finally {
    if (targetDisplay.request === structure) {
      targetDisplay.request = null;
      drawTarget();
      if (targetDisplay.conventional) defectViewer('target').fitCamera();
    }
  }
}
function applyTargetRepeats(values) {
  const structure = targetDisplay.conventional || targetDisplay.structure;
  if (!structure) return;
  const message = values.some(value => !Number.isInteger(value) || value < 1 || value > 4)
    ? 'Each repeat count must be an integer from 1 to 4.'
    : targetInstanceCount(structure, values) > 5000 ? 'The selection exceeds the 5,000-atom display limit.' : '';
  if (!message) targetDisplay.repeats = values;
  setTargetRepeats(targetDisplay.repeats);
  targetViewNote(message);
  drawTarget();
}

const calculationRepeats = () => ['a', 'b', 'c'].map(axis => Number($(`defects-repeat-${axis}`).value));
const calculationBasisLabel = basis => basis === 'conventional' ? 'Conventional cell' : 'Host cell';
async function hostForSupercell(phase, geometry, basis) {
  const input = geometryForViewer(geometry);
  const structure = basis === 'conventional' ? await conventionalCell(input) : input;
  const id = basis === 'conventional' ? `${phase.phaseId}:conventional` : phase.phaseId;
  const atoms = structure.atoms.map((atom, index) => ({...atom,
    hostSiteId: `${id}:site:${index}:${atom.element}`, mask: [true, true, true]}));
  return {...structure, id, hostId: id, atoms};
}
function verifiedCpdHost(phase) {
  const energy = energyEntry(phase.phaseId);
  return energy && relaxedHost?.phaseId === phase.phaseId && relaxedHost.hash === energy.finalGeometrySha256 &&
    relaxedHost.modelKey === findCpdRelaxationModel()?.model_key
    ? relaxedHost.geometry : null;
}
async function previewCalculationSupercell() {
  const phase = phaseRecord(cpdResult?.target_phase_id);
  if (!phase) return;
  try {
    const repeats = calculationRepeats();
    if (!appliedNearCubic && repeats.some(n => !Number.isInteger(n) || n < 1 || n > 12)) throw new Error('Enter integer repeats from 1 to 12.');
    const relaxed = verifiedCpdHost(phase);
    const basis = $('defects-calculation-basis').value;
    if (basis === 'conventional') setStatus('defects-vacancy-status', 'Preparing the conventional cell…');
    const host = await hostForSupercell(phase, relaxed || phaseToGeometry(phase), basis);
    draftSupercell = {host, basis, supercell: globalThis.NeutralDefect.buildSupercell(host, appliedNearCubic?.matrix ?? repeats, {maxAtoms: 1024}),
      relaxedHostVerified: !!relaxed};
    showCalculationSupercell(true);
    setStatus('defects-vacancy-status', relaxed
      ? 'Finding symmetry-inequivalent defect sites…'
      : 'Saved CPD · the relaxed calculation lattice will be recovered before calculating defects.');
  } catch (error) {
    draftSupercell = null;
    showCalculationSupercell();
    setStatus('defects-vacancy-status', error.message, 'error');
  }
  syncVacancyControls();
}
const supercellSize = cell => cell.repeats ? cell.repeats.join(' × ') : `Near-cubic · |det S| ${cell.determinant}`;

function resetNearCubicCandidates() {
  nearCubicCandidate = null;
  $('defects-near-options').replaceChildren();
  $('defects-near-all').replaceChildren();
  $('defects-near-more').hidden = true;
  $('defects-near-preview').hidden = true;
  setStatus('defects-near-status', '');
}

function renderNearCubicCandidate(candidate) {
  nearCubicCandidate = candidate;
  for (const button of $('defects-near-cubic').querySelectorAll('[data-determinant]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.determinant) === candidate.determinant));
  }
  const {host} = draftSupercell;
  const structure = globalThis.NeutralDefect.buildSupercell(host, candidate.matrix, {maxAtoms: 1024});
  $('defects-near-preview').hidden = false;
  const viewer = defectViewer('candidate');
  viewer.setFrame({structure, display: {stylePreset: 'phonon-vesta', instancedLargeStructure: true,
    showBoundary: false, showNeighbors: false}, atomDragEnabled: false});
  viewer.fitCamera();
  const matrix = candidate.matrix.map(row => `[${row.join(' ')}]`).join(' ');
  $('defects-near-metrics').textContent = `${structure.atomCount} atoms · shortest periodic distance ${candidate.shortest.toFixed(2)} Å · a/b/c ${candidate.lengths.map(n => n.toFixed(2)).join(' / ')} Å · α/β/γ ${candidate.angles.map(n => n.toFixed(2)).join(' / ')}° · Matrix ${matrix}`;
  syncVacancyControls();
}

async function searchNearCubic() {
  const host = draftSupercell?.host;
  if (!host || !draftSupercell.relaxedHostVerified) throw new Error('Prepare the relaxed calculation basis before searching for candidates.');
  resetNearCubicCandidates();
  setStatus('defects-near-status', 'Searching near-cubic integer supercells…');
  const minLength = Number($('defects-near-length').value), maxAtoms = Number($('defects-near-atoms').value);
  const worker = new Worker('./defect-supercell-search-worker.js?v=0480e13a9615bf0d9353570dde9b2bf8030bebce28271f0e1ba46ae5dc162836');
  let candidates;
  try {
    candidates = await new Promise((resolve, reject) => {
      worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data.candidates);
      worker.onerror = () => reject(new Error('The supercell search worker could not load.'));
      worker.postMessage({cell: host.cell, hostAtoms: host.atoms.length, minLength, maxAtoms});
    });
  } finally { worker.terminate(); }
  const featured = new Map();
  if (candidates.length) {
    const best = key => candidates.reduce((a, b) => b[key] < a[key] ? b : a);
    for (const [candidate, label] of [[candidates[0], 'Fewest atoms'], [best('angleDeviation'), 'Closest to 90°'], [best('shapeScore'), 'Closest to cubic']]) {
      featured.set(candidate, [...featured.get(candidate) || [], label]);
    }
  }
  const render = (candidate, labels) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.determinant = candidate.determinant;
    button.setAttribute('aria-pressed', 'false');
    const heading = document.createElement('strong');
    heading.textContent = labels?.join(' · ') || `|det S| ${candidate.determinant}`;
    button.append(heading, `${candidate.atoms} atoms · ${candidate.shortest.toFixed(2)} Å shortest · ${candidate.angleDeviation.toFixed(2)}° max deviation`);
    button.onclick = () => renderNearCubicCandidate(candidate);
    return button;
  };
  $('defects-near-options').replaceChildren(...[...featured].map(([candidate, labels]) => render(candidate, labels)));
  $('defects-near-all').replaceChildren(...candidates.map(candidate => render(candidate)));
  $('defects-near-more').hidden = candidates.length <= featured.size;
  setStatus('defects-near-status', candidates.length
    ? `${candidates.length} feasible size candidates · ${featured.size} featured · ≥ ${minLength} Å · ≤ ${maxAtoms} atoms. One near-cubic matrix tested per size.`
    : `No candidate met ${minLength} Å within ${maxAtoms} atoms in this search. Increase the atom limit or lower the distance.`);
}

function perfectSupercellForVacancy(cell) {
  return perfectVacancyHost ? {...cell, atoms: cell.atoms.map((atom, index) =>
    ({...atom, position: perfectVacancyHost.geometry.positions_a[index]}))} : cell;
}
function showCalculationSupercell(reset = false) {
  const section = $('defects-supercell-view'), preview = vacancyPreview || draftSupercell;
  section.hidden = !preview;
  if (!preview) return;
  const cell = preview.supercell;
  const dimensions = globalThis.StructureInfoCore.geometry(cell);
  const frame = $('defects-supercell-frame');
  frame.disabled = !selectedVacancy;
  $('defects-supercell-site-hint').hidden = !!selectedVacancy;
  if (!selectedVacancy) frame.value = 'perfect';
  const vacancy = frame.value === 'vacancy';
  const interstitial = selectedVacancy?.kind === 'interstitial';
  frame.options[1].textContent = interstitial ? 'Interstitial · initial position' : 'Selected defect · initial';
  const perfect = perfectSupercellForVacancy(cell);
  const structure = vacancy ? globalThis.NeutralDefect.structureForDefect(perfect, selectedVacancy) : perfect;
  const viewer = defectViewer('supercell');
  const showSite = selectedVacancy && (interstitial ? vacancy : !vacancy || selectedVacancy.kind === 'substitution');
  viewer.setFrame({structure, selectionIds: showSite ? [selectedVacancy.representativeAtomIndex] : [],
    display: {stylePreset: 'phonon-vesta', vestaDisplay: 'jmol', instancedLargeStructure: true,
      showBoundary: false, showNeighbors: false}, atomDragEnabled: false});
  if (reset) viewer.fitCamera();
  const matrix = cell.matrix.map(row => `[${row.join(' ')}]`).join(' ');
  const count = selectedVacancy ? `${cell.atomCount} → ${cell.atomCount + selectedVacancy.deltaN} atoms` : `${cell.atomCount} atoms`;
  const label = preview.relaxedHostVerified ? 'Fixed calculation lattice' : 'Input geometry preview · relaxed lattice pending';
  $('defects-supercell-badge').textContent = `${calculationBasisLabel(preview.basis)} · ${supercellSize(cell)} · ${cell.atomCount} atoms · ${label}`;
  const insertion = interstitial ? ` · insertion fractional (${selectedVacancy.insertionFractional.map(value => value.toFixed(4)).join(', ')})` : '';
  $('defects-supercell-info').textContent = `Matrix ${matrix}${selectedVacancy ? ` · selected defect ${count}` : ''}${insertion} · a/b/c ${dimensions.lengths.map(n => n.toFixed(2)).join(' / ')} Å · α/β/γ ${dimensions.angles.map(n => n.toFixed(1)).join(' / ')}°`;
}

function inspectLocalAtom(index) {
  localAtom = index;
  const atom = localDisplayAtoms[index], label = $('defects-local-atom');
  if (!atom) { label.textContent = 'Select a neighboring atom to inspect its distance and displacement.'; return; }
  label.textContent = `${atom.element} · ${atom.inserted ? 'interstitial atom' : `perfect site ${atom.hostIndex + 1}`} · distance ${atom.initialDistance.toFixed(3)} → ${atom.finalDistance.toFixed(3)} Å · displacement ${atom.displacement.toFixed(3)} Å`;
}

function vacancyDisplay(entry, radius, fraction, overview) {
  const {fractional, cartesian} = globalThis.Structures;
  const cell = entry.perfect.geometry.cell_a;
  const center = overview ? cartesian([0.5, 0.5, 0.5], cell) : [0, 0, 0];
  const atoms = [];
  let neighbors = 0, images = 0;
  for (const atom of entry.environment.atoms) {
    const focused = Math.min(atom.initialDistance, atom.finalDistance) <= radius;
    if (focused) neighbors++;
    const addImage = (initial, highlighted) => {
      const position = initial.map((value, axis) => value + fraction * atom.vector[axis]);
      atoms.push({...atom, initial, position, focused: highlighted});
    };
    if (!overview) {
      if (focused) addImage(atom.start, true);
      continue;
    }
    // Choose periodic images from the initial positions and keep them fixed
    // throughout the scrub, including neighbors across a cell boundary.
    const initial = atom.start.map((value, axis) => value + center[axis]);
    const frac = fractional(initial, cell);
    const shift = frac.map(value => Math.floor(value + 1e-8));
    if (shift.every(value => value === 0)) addImage(initial, focused);
    else {
      const offset = cartesian(shift, cell);
      const wrapped = initial.map((value, axis) => value - offset[axis]);
      addImage(wrapped, false);
      if (focused) {
        addImage(initial, true);
        images++;
      }
    }
  }
  const viewRadius = overview
    ? Math.max(...[[1,1,1], [1,1,-1], [1,-1,1], [-1,1,1]].map(signs =>
      Math.hypot(...cartesian(signs.map(sign => sign * 0.5), cell))),
      ...atoms.flatMap(atom => [0, 1].map(t =>
        Math.hypot(...atom.initial.map((value, axis) => value + t * atom.vector[axis] - center[axis])))))
    : radius;
  return {atoms, center, viewRadius, neighbors, images, cell: overview ? cell : null};
}

function showLocalVacancy({open = false, refit = false} = {}) {
  const section = $('defects-local-view');
  const entry = vacancyResults.get(selectedVacancy?.defectId);
  section.hidden = !entry;
  if (!entry) { inspectedVacancy = null; return; }
  const changed = inspectedVacancy !== entry;
  if (changed) {
    inspectedVacancy = entry;
    $('defects-local-progress').value = '100';
    inspectLocalAtom(-1);
  }
  if (open) section.hidden = false;
  const radius = Number($('defects-local-radius').value);
  const progress = Number($('defects-local-progress').value);
  const vectorScale = Number($('defects-local-vector-scale').value);
  $('defects-local-progress-value').textContent = `${progress}%`;
  $('defects-local-progress').setAttribute('aria-valuetext',
    progress === 0 ? 'Initial' : progress === 100 ? 'Relaxed' : `${progress}% toward relaxed`);
  $('defects-local-vector-scale-value').textContent = `${vectorScale}×`;
  const showArrows = $('defects-local-arrows').checked;
  $('defects-local-vector-scale').disabled = !showArrows;
  $('defects-local-vector-key').hidden = !showArrows;
  const overview = $('defects-local-scope').value === 'supercell';
  $('defects-local-context-key').hidden = !overview;
  const previous = localDisplayAtoms[localAtom];
  const frame = vacancyDisplay(entry, radius, progress / 100, overview);
  localDisplayAtoms = frame.atoms;
  const selection = changed || !previous ? -1 : localDisplayAtoms.findIndex(atom =>
    atom.hostIndex === previous.hostIndex && atom.focused === previous.focused);
  inspectLocalAtom(selection);
  const structure = {cell: null, displayCell: frame.cell, pbc: [false, false, false],
    viewCenter: frame.center, viewRadius: frame.viewRadius, viewPadding: overview ? 1.02 : undefined,
    atoms: frame.atoms.map(({element, position}) => ({element, position})),
    motionReferencePositions: frame.atoms.map(atom => atom.initial),
    focusMask: overview ? frame.atoms.map(atom => atom.focused) : null,
    displacementVectors: frame.atoms.map(atom => atom.focused && atom.displacement >= 0.1 ? atom.vector : null)};
  const movingAtoms = structure.displacementVectors.filter(Boolean).length;
  const {vectorRadius, vectorColor} = globalThis.CommonDisplay.get();
  const viewer = defectViewer('local', inspectLocalAtom);
  viewer.setFrame({structure, selectionIds: selection < 0 ? [] : [selection], atomDragEnabled: false,
    display: {stylePreset: 'phonon-vesta', vestaDisplay: 'jmol', showCell: overview,
      showBonds: $('defects-local-bonds').checked, bondScale: 0.22, bondColorByAtom: false, atomScale: 0.82,
      showVectors: showArrows, vectorScale, vectorRadius, vectorColor},
    annotations: entry.orbit.kind === 'vacancy' ? {vacancyCenter: frame.center} : undefined});
  $('defects-local-vector-key').style.setProperty('--defect-vector-color', vectorColor);
  if (changed || refit) viewer.fitCamera({preserveOrientation: true});
  section.dataset.defectId = entry.orbit.defectId;
  $('defects-local-vacancy-key').hidden = entry.orbit.kind !== 'vacancy';
  $('defects-local-label').replaceChildren(vacancyLabel(entry.orbit));
  const context = overview ? `${entry.environment.atoms.length} atoms in the supercell · ` : '';
  const images = frame.images ? ` · ${frame.images} periodic ${frame.images === 1 ? 'image' : 'images'}` : '';
  $('defects-local-info').textContent = `${context}${frame.neighbors} neighbors within ${radius} Å${images}${showArrows ? ` · ${movingAtoms} displacements ≥0.10 Å` : ''}`;
}

function clearVacancyPreview(message = 'Preparing the calculation supercell and defect candidates…', state = 'info') {
  vacancyPreview = null; draftSupercell = null; selectedVacancy = null; perfectVacancyHost = null;
  $('defects-supercell-view').hidden = true;
  $('defects-local-view').hidden = true;
  inspectedVacancy = null;
  clearVacancyEnergy();
  $('defects-vacancy-list').replaceChildren(); $('defects-vacancy-detail').textContent = '';
  $('defects-job-counts').textContent = '';
  if ($('defects-include-interstitials').checked) setStatus('defects-interstitial-status', 'Prepare the supercell to find insertion sites.');
  $('defects-download-vacancy').disabled = true;
  $('defects-run-vacancy').disabled = true;
  $('defects-run-all-vacancies').disabled = true;
  setStatus('defects-vacancy-status', message, state);
}

function clearVacancyEnergy() {
  vacancyResults.clear();
  vacancyFailures.clear();
  $('defects-calculation-results').hidden = true;
  $('defects-vacancy-results').hidden = true;
  $('defects-vacancy-more').hidden = true;
  setStatus('defects-vacancy-energy-status', '');
}

function activeDefectCounts() {
  const sites = vacancyPreview?.orbits || [];
  let complete = 0, running = 0, failures = 0;
  for (const {defectId} of sites) {
    if (vacancyResults.has(defectId)) complete++;
    else if (vacancyFailures.get(defectId) === 'Calculating…') running++;
    else if (vacancyFailures.has(defectId)) failures++;
  }
  return {total: sites.length, complete, running, failures, pending: sites.length - complete - running};
}

function syncVacancyControls() {
  const verified = vacancyPreview?.relaxedHostVerified && !!findCpdRelaxationModel();
  const {running, pending} = activeDefectCounts();
  const interstitials = $('defects-include-interstitials');
  interstitials.disabled = actionPending;
  $('defects-interstitial-separation').disabled = actionPending;
  $('defects-calculation-basis').disabled = actionPending;
  $('defects-near-search').disabled = actionPending || !draftSupercell?.relaxedHostVerified;
  $('defects-near-apply').disabled = actionPending || !nearCubicCandidate ||
    canonical(nearCubicCandidate.matrix) === canonical(appliedNearCubic?.matrix);
  for (const button of $('defects-near-cubic').querySelectorAll('[data-determinant]')) button.disabled = actionPending;
  $('defects-near-length').disabled = $('defects-near-atoms').disabled = actionPending;
  $('defects-near-diagonal').hidden = !appliedNearCubic;
  $('defects-near-diagonal').disabled = actionPending;
  $('defects-target-near-cubic').hidden = !currentCpdPotentials();
  $('defects-target-near-cubic').disabled = actionPending;
  const multipleKinds = dopants.length || interstitials.checked;
  const selected = $('defects-run-vacancy'), all = $('defects-run-all-vacancies');
  const canRunSelected = verified && selectedVacancy && !vacancyResults.has(selectedVacancy.defectId);
  const findSites = $('defects-generate-vacancies');
  const needsHostRecovery = !!draftSupercell && !vacancyPreview && !draftSupercell.relaxedHostVerified && !!findCpdRelaxationModel();
  findSites.hidden = !draftSupercell || !!vacancyPreview?.relaxedHostVerified;
  findSites.disabled = actionPending || findSites.hidden;
  selected.disabled = actionPending || !canRunSelected;
  all.disabled = actionPending || (!needsHostRecovery && (!verified || !pending));
  const selectedLabel = `Calculate selected ${selectedVacancy?.kind || (multipleKinds ? 'defect' : 'vacancy')}`;
  const allLabel = multipleKinds ? 'Calculate all neutral defects' : 'Calculate all vacancies';
  const selectedStatus = !selectedVacancy ? ''
    : vacancyFailures.get(selectedVacancy.defectId) === 'Calculating…' ? 'Running'
    : canRunSelected ? '1 to run' : vacancyResults.has(selectedVacancy.defectId) ? 'Complete' : 'Unavailable';
  selected.textContent = selectedStatus ? `${selectedLabel} · ${selectedStatus}` : selectedLabel;
  const allStatus = pending ? `${pending} to run` : running ? 'Running' : 'Complete';
  all.textContent = needsHostRecovery ? 'Prepare and calculate defects'
    : verified ? `${allLabel} · ${allStatus}` : allLabel;
  $('defects-generate-vacancies').textContent = dopants.length ? 'Find defect sites' : 'Find vacancy sites';
  $('defects-download-vacancy').textContent = multipleKinds ? 'Download selected defect POSCAR' : 'Download selected vacancy POSCAR';
  $('defects-download-vacancy').disabled = actionPending || !selectedVacancy || !vacancyPreview;
  for (const axis of ['a', 'b', 'c']) $(`defects-repeat-${axis}`).disabled = actionPending;
  for (const button of $('defects-vacancy-list').querySelectorAll('button')) button.disabled = actionPending;
}

function selectVacancyOrbit(orbit, {showInitial = false} = {}) {
  selectedVacancy = orbit;
  const preview = vacancyPreview;
  for (const button of $('defects-vacancy-list').querySelectorAll('[data-defect-id]')) {
    const active = button.dataset.defectId === orbit.defectId;
    button.setAttribute('aria-pressed', String(active));
    if (active && button.closest('.defects-insertion-site')) button.closest('.defects-insertion-site').open = true;
  }
  const interstitial = orbit.kind === 'interstitial';
  if (showInitial) $('defects-supercell-frame').value = 'vacancy';
  const siteDetails = interstitial
    ? [`Insertion fractional position ${orbit.insertionFractional.map(value => value.toFixed(6)).join(', ')}`,
      `Initial clearance to host atoms ${orbit.separation.toFixed(3)} Å`,
      `Equivalent positions in calculation supercell ${orbit.multiplicity}`]
    : [`Host site ${orbit.hostSiteId}`, `Supercell site ${orbit.supercellSiteId}`,
      `Equivalent sites ${orbit.multiplicity}: ${orbit.memberSiteIds.join(', ')}`];
  const detail = [`Defect ${orbit.defectId}`, ...siteDetails, `Charge 0 · ΔN ${Object.entries(orbit.deltaNByElement).filter(([, count]) => count).map(([element, count]) => `${element} ${count > 0 ? "+" : ""}${count}`).join(" · ")}`, `Cell matrix ${preview.supercell.matrix.map(row => `[${row.join(' ')}]`).join(' ')} · |det S| ${preview.supercell.determinant} · atoms ${preview.supercell.atomCount} → ${preview.supercell.atomCount + orbit.deltaN}`, `Relaxation: ${orbit.relaxationSymmetryPolicy}`];
  $('defects-vacancy-detail').textContent = detail.join('\n');
  showCalculationSupercell();
  showLocalVacancy({open: true});
  renderVacancyEnergy();
  syncVacancyControls();
}

function renderVacancyOrbits(preview) {
  const host = $('defects-vacancy-list'); host.replaceChildren();
  const groups = new Map(), insertionGroups = new Map();
  preview.orbits.forEach((orbit, index) => {
    const key = orbit.kind === 'interstitial' ? 'interstitial' : orbit.dopant || '';
    if (!groups.has(key)) {
      const section = document.createElement('section');
      section.className = 'defects-candidate-group';
      section.dataset.dopant = key;
      const heading = document.createElement('h5');
      heading.textContent = key === 'interstitial' ? 'Interstitials' : key ? `${key} substitutions` : 'Vacancies';
      const count = document.createElement('span');
      count.className = 'defects-candidate-count';
      heading.append(count);
      const grid = document.createElement('div');
      if (key !== 'interstitial') grid.className = 'defects-vacancy-list';
      section.append(heading, grid);
      host.append(section);
      groups.set(key, grid);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.vacancyIndex = String(index);
    button.setAttribute('aria-pressed', 'false');
    button.dataset.defectId = orbit.defectId;
    button.append(vacancyLabel(orbit));
    if (key !== 'interstitial') button.append(` · multiplicity ${orbit.multiplicity}`);
    const state = document.createElement('span');
    state.className = 'defects-vacancy-run-state';
    button.append(state);
    button.addEventListener('click', () => selectVacancyOrbit(orbit, {showInitial: true}));
    let destination = groups.get(key);
    if (key === 'interstitial') {
      if (!insertionGroups.has(orbit.siteNumber)) {
        const site = document.createElement('details');
        site.className = 'defects-insertion-site';
        site.open = orbit.siteNumber === 1;
        const summary = document.createElement('summary');
        summary.textContent = `Site ${orbit.siteNumber} · clearance ${orbit.separation.toFixed(2)} Å · ${orbit.multiplicity} equivalent positions`;
        const grid = document.createElement('div');
        grid.className = 'defects-vacancy-list';
        site.append(summary, grid);
        destination.append(site);
        insertionGroups.set(orbit.siteNumber, grid);
      }
      destination = insertionGroups.get(orbit.siteNumber);
    }
    destination.append(button);
  });
  updateVacancyRunStates();
}

function findCpdRelaxationModel() {
  return modelCatalog?.models.find(candidate => candidate.model_id === cpdResult?.model.model_id &&
    candidate.weights_sha256 === cpdResult?.model.weights_sha256);
}

function cpdRelaxationModel() {
  const model = findCpdRelaxationModel();
  if (!model) throw new Error('Use the exact force model and weights recorded in the CPD to calculate a vacancy.');
  return model;
}

function requireConverged(result, input, settings, label) {
  if (result.status !== 'converged' || !Number.isFinite(result.totalEnergyEv) ||
    !Number.isFinite(result.maxForceEvA) || result.maxForceEvA > settings.forceToleranceEvA) {
    throw new Error(`${label} did not converge (${result.status}, ${result.evaluations} evaluations). Formation energy is unavailable.`);
  }
  if (canonical(result.geometry?.atomic_numbers) !== canonical(input.atomic_numbers)) {
    throw new Error(`${label} changed the atom identities or ordering.`);
  }
  if (settings.mode === 'fixed-cell' && canonical(result.geometry.cell_a) !== canonical(input.cell_a)) {
    throw new Error(`${label} changed the fixed lattice.`);
  }
  return result;
}

async function equilibratedCpdHost(phase, model) {
  const entry = energyEntry(phase.phaseId);
  if (!entry) throw new Error('The CPD host must have a converged energy.');
  if (relaxedHost?.phaseId === phase.phaseId && relaxedHost.hash === entry.finalGeometrySha256 &&
      relaxedHost.modelKey === model.model_key) return relaxedHost.geometry;
  // Older energy bundles record a geometry hash but carry no relaxed coordinates.
  const runner = makeRunner(model, 'defects-vacancy-status');
  await ensureModelWorker(model);
  const input = phaseToGeometry(phase);
  const settings = {...entry.relax, maxSteps: 500};
  const run = requireConverged(await runner.runRelax({phaseId: 'CPD host', structure: input, settings}),
    input, settings, 'CPD host');
  const hash = await Contract.sha256(run.geometry);
  if (hash !== entry.finalGeometrySha256) {
    throw new Error('The relaxed host does not match the CPD geometry hash. Recalculate the host and competing phases with this model.');
  }
  relaxedHost = {phaseId: phase.phaseId, hash, modelKey: model.model_key, geometry: run.geometry};
  return run.geometry;
}

async function generateVacancyPreview() {
  const phase = phaseRecord(cpdResult?.target_phase_id);
  if (!phase) throw new Error('Calculate the target CPD before preparing defects.');
  if (!draftSupercell) await previewCalculationSupercell();
  if (!draftSupercell) throw new Error($('defects-vacancy-status').textContent);
  const {basis, supercell} = draftSupercell;
  setStatus('defects-vacancy-status', `Preparing the relaxed CPD host and ${supercellSize(supercell)} supercell…`);
  let host = draftSupercell.host, previewOnlyReason;
  if (!draftSupercell.relaxedHostVerified) {
    let geometry;
    try { geometry = await equilibratedCpdHost(phase, cpdRelaxationModel()); }
    catch (error) { previewOnlyReason = error.message; }
    if (geometry) host = await hostForSupercell(phase, geometry, basis);
  }
  const preview = await globalThis.NeutralDefect.analyzeHostAndGenerate(host, supercell.repeats ?? supercell.matrix, {tolerance: 1e-4, maxAtoms: 1024});
  const vacancies = preview.orbits;
  const substitutions = dopants.flatMap(dopant => vacancies.map(orbit => globalThis.NeutralDefect.substitutionForOrbit(orbit, dopant)));
  preview.orbits = [...vacancies, ...substitutions];
  vacancyPreview = {...preview, basis, baseOrbits: preview.orbits, relaxedHostVerified: !previewOnlyReason, previewOnlyReason};
  refreshInterstitialCandidates();
  showTargetStructure();
  showCalculationSupercell(true);
  const label = previewOnlyReason ? 'Input host preview' : 'Relaxed host';
  const summary = `${label} · ${calculationBasisLabel(basis)} · space group ${preview.symmetry.spaceGroupSymbol} · No. ${preview.symmetry.spaceGroupNumber} · ${supercellSize(preview.supercell)} supercell · ${preview.supercell.atomCount} atoms · ${vacancies.length} inequivalent neutral vacancies${dopants.length ? ` · ${substitutions.length} substitutions across ${dopants.join(", ")}` : ""}.`;
  setStatus('defects-vacancy-status', previewOnlyReason ? `${summary} ${previewOnlyReason} POSCAR export remains available.` : summary, previewOnlyReason ? 'warning' : 'info');
}

function refreshInterstitialCandidates() {
  const toggle = $('defects-include-interstitials'), status = $('defects-interstitial-status');
  status.hidden = !toggle.checked;
  $('defects-interstitial-separation-setting').hidden = !toggle.checked;
  if (!vacancyPreview) {
    if (toggle.checked) status.textContent = 'Prepare the supercell to find insertion sites.';
    return;
  }
  const preview = vacancyPreview;
  preview.orbits = preview.baseOrbits;
  if (toggle.checked) {
    const api = globalThis.NeutralDefect;
    const sites = preview.insertionSites ??= api.findInterstitialSites(preview);
    const symbols = findCpdRelaxationModel()?.supported_atomic_symbols || cpdResult.elements;
    const species = cpdResult.elements.filter(element => symbols.includes(element));
    const allInterstitials = preview.interstitialOrbits ??= sites.flatMap((site, index) => species.map(element =>
      api.interstitialForSite(preview.supercell, site, index, element)));
    const retainedSites = new Set(api.filterInterstitialSites(sites, preview.host, interstitialSiteSeparation));
    const interstitials = allInterstitials.filter(orbit => retainedSites.has(sites[orbit.siteNumber - 1]));
    preview.orbits = [...preview.baseOrbits, ...interstitials];
    const clearance = api.INTERSTITIAL_MIN_CLEARANCE;
    status.textContent = sites.length
      ? `${retainedSites.size} of ${sites.length} inequivalent Voronoi sites retained · ${interstitials.length} candidates · host clearance ≥ ${clearance} Å.`
      : `No periodic Voronoi sites reached the ${clearance} Å minimum clearance.`;
  }
  if (!preview.orbits.includes(selectedVacancy)) {
    selectedVacancy = preview.orbits.find(orbit => vacancyResults.has(orbit.defectId)) || null;
  }
  renderVacancyOrbits(preview);
  if (selectedVacancy) selectVacancyOrbit(selectedVacancy);
  else {
    showCalculationSupercell();
    showLocalVacancy();
    renderVacancyEnergy();
  }
}

function vacancyGeometry(structure) {
  return {cell_a: structure.cell.map(row => row.slice()), pbc: [true, true, true],
    atomic_numbers: structure.atoms.map(atom => atomicNumber(atom.element)),
    positions_a: structure.atoms.map(atom => atom.position.slice())};
}

async function runVacancyEnergy(orbit = selectedVacancy, progress = '') {
  const preview = vacancyPreview;
  if (!preview || !orbit) throw new Error('Choose a defect site first.');
  if (!preview.relaxedHostVerified) throw new Error('Prepare the verified relaxed CPD host before calculating defect energies.');
  if (vacancyResults.has(orbit.defectId)) return;
  const model = cpdRelaxationModel();
  if (orbit.dopant && !model.supported_atomic_symbols.includes(orbit.dopant)) throw new Error(`${model.display_name} does not support ${orbit.dopant}.`);
  const runner = makeRunner(model, 'defects-vacancy-energy-status');
  const settings = {mode: 'fixed-cell', optimizer: 'lbfgs', maxSteps: 500, forceToleranceEvA: 0.01, stressToleranceGpa: 0.1};
  await ensureModelWorker(model);
  const input = vacancyGeometry(preview.supercell);
  const relax = async (label, geometry) => {
    setStatus('defects-vacancy-energy-status', `${progress}Relaxing ${label} · ${geometry.atomic_numbers.length} atoms · fixed cell…`);
    return requireConverged(await runner.runRelax({phaseId: label, structure: geometry, settings}),
      geometry, settings, label);
  };
  perfectVacancyHost ||= await relax('Perfect supercell', input);
  const perfect = perfectVacancyHost;
  // Keep the host-site map while using the converged perfect-cell positions.
  const supercell = perfectSupercellForVacancy(preview.supercell);
  const defect = globalThis.NeutralDefect.structureForDefect(supercell, orbit);
  const initial = vacancyGeometry(defect);
  const vacant = await relax(`${defectName(orbit)} · site ${orbit.siteNumber ?? orbit.representativeAtomIndex + 1}`, initial);
  const environment = globalThis.NeutralDefect.localVacancyEnvironment(perfect.geometry, initial, vacant.geometry, orbit);
  vacancyResults.set(orbit.defectId, {perfect, vacant, orbit, environment});
  showCalculationSupercell();
  showLocalVacancy({open: true});
  vacancyFailures.delete(orbit.defectId);
  updateVacancyRunStates();
  if (!progress) setStatus('defects-vacancy-energy-status', `${model.model_id} · L-BFGS · same fixed lattice · both relaxations converged`);
  renderVacancyEnergy();
}

function recordVacancyFailure(orbit, error) {
  vacancyFailures.set(orbit.defectId, error.message.includes('did not converge') ? 'Not converged' : 'Calculation failed');
  updateVacancyRunStates();
}
async function runAllVacancies() {
  if (!vacancyPreview?.relaxedHostVerified) throw new Error('Prepare the calculation lattice and defect sites first.');
  const sites = vacancyPreview.orbits;
  if (!sites.length) throw new Error('No symmetry-inequivalent defect sites were found.');
  const pending = sites.filter(orbit => !vacancyResults.has(orbit.defectId));
  const reused = sites.length - pending.length;
  const failures = [];
  for (const [index, orbit] of pending.entries()) {
    const progress = `${index + 1}/${pending.length} · `;
    setStatus('defects-vacancy-energy-status', `${progress}Preparing ${defectName(orbit)}…`);
    vacancyFailures.set(orbit.defectId, 'Calculating…');
    updateVacancyRunStates();
    try {
      await runVacancyEnergy(orbit, progress);
      if (!selectedVacancy) selectVacancyOrbit(orbit);
    } catch (error) {
      recordVacancyFailure(orbit, error);
      if (!perfectVacancyHost) throw error;
      failures.push(`${defectName(orbit)} · site ${orbit.representativeAtomIndex + 1}: ${error.message}`);
    }
  }
  const summary = `${activeDefectCounts().complete}/${sites.length} ${dopants.length || $('defects-include-interstitials').checked ? "neutral defects" : "vacancies"} converged${reused ? ` · ${reused} reused` : ''}`;
  setStatus('defects-vacancy-energy-status', failures.length
    ? `${summary} · ${failures.join(' · ')}`
    : `${summary} · same fixed lattice`, failures.length ? 'warning' : 'info');
}

function defectName(orbit) {
  return orbit.dopant ? `${orbit.dopant} on ${orbit.element}` : `${orbit.element} ${orbit.kind}`;
}

function vacancyLabel(orbit) {
  const name = document.createElement('span');
  const element = document.createElement('sub');
  element.textContent = orbit.kind === 'interstitial' ? 'i' : orbit.element;
  const charge = document.createElement('sup');
  charge.textContent = '0';
  name.append(`${defectName(orbit)} · ${orbit.kind === 'interstitial' ? orbit.element : orbit.dopant || 'V'}`, element, charge, ` · site ${orbit.siteNumber ?? orbit.representativeAtomIndex + 1}`);
  return name;
}

function updateVacancyRunStates() {
  const groups = $('defects-vacancy-list').querySelectorAll('.defects-candidate-group');
  for (const group of groups) {
    const buttons = [...group.querySelectorAll('[data-defect-id]')];
    let converged = 0;
    for (const button of buttons) {
      const id = button.dataset.defectId;
      const completed = vacancyResults.has(id);
      if (completed) converged++;
      button.querySelector('.defects-vacancy-run-state').textContent = completed ? 'Converged'
        : vacancyFailures.get(id) || 'Not calculated';
    }
    group.querySelector('.defects-candidate-count').textContent = `${converged}/${buttons.length} complete`;
  }
  const {total, complete: count, running, failures, pending} = activeDefectCounts();
  $('defects-job-counts').dataset.state = total > 0 && count === total ? 'complete' : 'info';
  $('defects-job-counts').textContent = total && count === total ? `All ${total} defects converged · same fixed lattice` : total
    ? `${count}/${total} complete · ${pending} to run${running ? ` · ${running} running` : ''}${failures ? ` · ${failures} to retry` : ''}`
    : '';
  syncVacancyControls();
}

function signedEnergy(value) {
  if (Math.abs(value) < 0.00005) return '0.0000';
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(4)}`;
}

function renderVacancyEnergy() {
  const section = $('defects-vacancy-results'), potentials = currentCpdPotentials();
  const entries = (vacancyPreview?.orbits || []).map(orbit => vacancyResults.get(orbit.defectId)).filter(Boolean);
  if (!entries.length || !potentials) {
    section.hidden = true;
    $('defects-vacancy-more').hidden = true;
    $('defects-calculation-results').hidden = true;
    return;
  }
  section.hidden = false;
  $('defects-vacancy-more').hidden = false;
  const rows = entries.sort((a, b) => a.orbit.representativeAtomIndex - b.orbit.representativeAtomIndex)
    .map(entry => {
      const raw = entry.vacant.totalEnergyEv - entry.perfect.totalEnergyEv;
      const reservoirs = Object.entries(entry.orbit.deltaNByElement).filter(([, count]) => count)
        .map(([element, count]) => {
          const axis = cpdResult.elements.indexOf(element);
          return {element, count, axis, mu0: cpdResult.references_mu0_ev_per_atom[axis]};
        });
      const energyAt = deltaMu => reservoirs.reduce((energy, {axis, count, mu0}) =>
        energy - count * (mu0 + deltaMu[axis]), raw);
      const energies = cpdResult.vertices.map(point => energyAt(point.delta_mu_ev_per_atom));
      return {...entry, reservoirs, raw, energies, selectedEnergy: energyAt(potentials)};
    });
  $('defects-energy-vertex').textContent = currentCpdLabel();
  $('defects-calculation-results').hidden = false;
  $('defects-calculation-results-reservoir').textContent = currentCpdLabel();
  $('defects-inline-energies').replaceChildren(...rows.map(({orbit, selectedEnergy}) => {
    const row = document.createElement('li');
    const energy = document.createElement('strong');
    energy.textContent = `${signedEnergy(selectedEnergy)} eV`;
    row.append(vacancyLabel(orbit), energy);
    return row;
  }));
  renderVacancyChart(rows);
  renderVacancyComparison(rows);
  renderVacancyDiagnostics(rows.find(row => row.orbit.defectId === selectedVacancy?.defectId));
}

function renderVacancyChart(rows) {
  const all = rows.flatMap(row => [...row.energies, row.selectedEnergy]);
  const smallest = Math.min(0, ...all), largest = Math.max(0, ...all);
  const span = Math.max(0.1, largest - smallest);
  const magnitude = 10 ** Math.floor(Math.log10(span / 5));
  const step = [1, 2, 2.5, 5, 10].find(n => n * magnitude >= span / 5) * magnitude;
  const first = Math.floor(smallest / step), last = Math.max(first + 1, Math.ceil(largest / step));
  const position = value => `${(value / step - first) / (last - first) * 100}%`;
  const chart = $('defects-vacancy-chart'), axis = $('defects-vacancy-chart-axis');
  chart.style.setProperty('--vacancy-zero', position(0));
  const focused = chart.contains(document.activeElement) ? document.activeElement.dataset.defectId : null;
  chart.replaceChildren();
  axis.replaceChildren();
  for (let i = first; i <= last; i++) {
    const tick = document.createElement('span');
    tick.style.setProperty('--vacancy-x', position(i * step));
    tick.textContent = Number((i * step).toPrecision(5)).toString().replace('-', '−');
    axis.append(tick);
  }
  for (const {orbit, selectedEnergy: value} of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'defects-energy-row defects-inspect-vacancy';
    row.dataset.defectId = orbit.defectId;
    row.setAttribute('aria-pressed', String(selectedVacancy?.defectId === orbit.defectId));
    const track = document.createElement('span'), bar = document.createElement('span');
    track.className = 'defects-energy-track';
    track.setAttribute('aria-hidden', 'true');
    bar.className = 'defects-energy-bar';
    bar.dataset.negative = String(value < 0);
    bar.style.setProperty('--vacancy-left', position(Math.min(0, value)));
    bar.style.setProperty('--vacancy-width', `${Math.abs(value) / (step * (last - first)) * 100}%`);
    track.append(bar);
    const number = document.createElement('strong');
    number.textContent = `${signedEnergy(value)} eV`;
    row.onclick = () => {
      if (actionPending) return;
      selectVacancyOrbit(orbit);
      $('defects-local-heading').scrollIntoView({block: 'nearest'});
    };
    row.append(vacancyLabel(orbit), number, track);
    chart.append(row);
    if (row.dataset.defectId === focused) row.focus({preventScroll: true});
  }
  const range = $('defects-vacancy-range');
  range.hidden = rows.length !== 1;
  const rangeTrack = $('defects-vacancy-range-track');
  rangeTrack.replaceChildren();
  if (range.hidden) return;
  const values = rows[0].energies;
  const lo = Math.min(...values), hi = Math.max(...values);
  const line = document.createElement('span');
  line.className = 'defects-energy-range-line';
  line.style.setProperty('--vacancy-left', position(lo));
  line.style.setProperty('--vacancy-width', `${(hi - lo) / (step * (last - first)) * 100}%`);
  const point = document.createElement('span');
  point.className = 'defects-energy-range-point';
  point.style.setProperty('--vacancy-x', position(rows[0].selectedEnergy));
  rangeTrack.append(line, point);
  $('defects-vacancy-range-values').textContent = `${signedEnergy(lo)} to ${signedEnergy(hi)} eV`;
}

function renderVacancyComparison(rows) {
  const table = $('defects-vacancy-comparison');
  const focused = table.contains(document.activeElement) ? document.activeElement.dataset.cpdVertex : undefined;
  const head = table.tHead.rows[0];
  head.replaceChildren();
  for (const label of ['Vertex', ...rows.map(row => vacancyLabel(row.orbit))]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.append(label);
    head.append(cell);
  }
  table.tBodies[0].replaceChildren();
  for (const [index] of cpdResult.vertices.entries()) {
    const row = table.tBodies[0].insertRow();
    row.dataset.active = String(index === activeVertex);
    const cell = document.createElement('th');
    cell.scope = 'row';
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cpdVertex = index;
    button.textContent = vertexLabel(index);
    button.setAttribute('aria-label', `Select vertex ${vertexLabel(index)}`);
    button.setAttribute('aria-pressed', String(index === activeVertex));
    button.onclick = () => $('defects-vertices').querySelector(`[data-cpd-vertex="${index}"]`).click();
    cell.append(button);
    row.append(cell);
    for (const entry of rows) row.insertCell().textContent = signedEnergy(entry.energies[index]);
    if (String(index) === focused) button.focus({preventScroll: true});
  }
}

function renderVacancyDiagnostics(entry) {
  const details = $('defects-vacancy-audit'), host = $('defects-vacancy-result');
  details.hidden = !entry;
  if (!entry) return;
  const {perfect, vacant, orbit, reservoirs, raw, selectedEnergy} = entry;
  const rows = [['Perfect', perfect], [orbit.kind[0].toUpperCase() + orbit.kind.slice(1), vacant]].map(([label, r]) =>
    `${label} · ${r.geometry.atomic_numbers.length} atoms · ${r.totalEnergyEv.toFixed(12)} eV · max force ${r.maxForceEvA.toFixed(5)} eV/Å · ${r.evaluations} force evaluations · ${r.elapsedSeconds.toFixed(2)} s`);
  host.textContent = rows.join('\n') + '\n';
  host.append(`E(${orbit.kind}) − E(perfect) = ${raw.toFixed(12)} eV\n`);
  for (const {element, count, axis, mu0} of reservoirs) {
    const dmu = currentCpdPotentials()[axis];
    host.append(`ΔN(${element}) = ${count > 0 ? '+' : ''}${count} · `,
      potentialLabel(element, 'μ⁰'), ` = ${mu0.toFixed(12)} eV/atom · `,
      potentialLabel(element), ` = ${dmu.toFixed(12)} eV/atom\n`);
  }
  host.append(`Reservoir correction (−Σ ΔN μ) = ${(selectedEnergy - raw).toFixed(12)} eV\n`,
    `${currentCpdLabel()} · Formation energy = ${selectedEnergy.toFixed(12)} eV`);
}

function showTargetInput(structure, sourceText = null) {
  clearTimeout(targetEditTimer);
  const format = $('defects-target-format').value;
  const editor = $('defects-target-poscar');
  const structures = globalThis.Structures;
  const serialize = format === 'cif' ? structures.toCif : structures.toPoscar;
  appliedTargetText = structure ? sourceText ?? serialize(structure, 'Defects target') : '';
  editor.value = appliedTargetText;
  editor.placeholder = format === 'cif' ? 'Paste a periodic CIF' : 'Paste a periodic POSCAR';
  editor.removeAttribute('aria-invalid');
}

function syncSetupSummary(canSearch) {
  const status = $('defects-relax-summary');
  const relaxed = currentSetupRelaxation();
  const saved = importedBundle && targetPhase && energyEntry(targetPhase.phaseId);
  const pending = pendingTargetEdits();
  const failed = $('defects-target-relax-status').dataset.state === 'error';
  status.textContent = !targetPhase ? 'Choose a target' : pending ? 'Unapplied structure edits'
    : relaxingSetupTarget ? 'Relaxing…' : relaxed ? 'Relaxed · L-BFGS · ISIF 3'
    : saved ? 'Saved target energy' : failed ? 'Relaxation failed' : 'Ready to relax';
  status.dataset.state = !pending && relaxed ? 'ready' : failed ? 'error' : 'info';
  const badge = $('defects-target-badge');
  badge.textContent = pending ? 'Unapplied edits' : targetPhase ? 'Valid input' : 'Choose a target';
  badge.classList.toggle('valid', !!targetPhase && !pending);
  const summary = $('defects-dopant-summary');
  if (summary.dataset.symbols !== dopants.join(',')) {
    summary.dataset.symbols = dopants.join(',');
    summary.replaceChildren(...(dopants.length ? dopants.map(symbol =>
      dopantChip(symbol, () => applyDopants(dopants.filter(value => value !== symbol)))) : ['None']));
  }
  $('defects-relax-target').hidden = !!relaxed && !pending;
  const search = $('defects-search-from-setup');
  search.hidden = !canSearch || pending || !!dataset;
  search.disabled = actionPending || search.hidden;
}

function renderSetup() {
  const elements = hostElements();
  if (displayedTarget !== targetPhase && globalThis.StructureInfo) {
    displayedTarget = targetPhase;
    if (!targetPhase) setStatus('defects-active-target', 'No active target');
    const s = targetPhase?.structure;
    const structure = s ? {
      ...s, atoms: s.atoms.map(atom => ({element: atom.element,
        position: globalThis.Structures.cartesian(atom.fractional, s.cell)})),
    } : null;
    $('defects-target-format').value = sourceTargetFormat;
    showTargetInput(structure, sourceTargetText);
    $('defects-target-poscar').removeAttribute('aria-invalid');
    setStatus('defects-target-editor-status', '');
    const source = targetPhase?.source;
    const provenance = source?.provider.startsWith('Alexandria') ? {
      provider: 'Alexandria', id: source.recordId, url: source.recordUrl,
      databaseSpaceGroup: source.databaseSpaceGroup ?? targetPhase.providerMetadata?.spaceGroup,
    } : undefined;
    globalThis.StructureInfo.show('defects', structure, {provenance});
    showTargetStructure(true);
  }
  $('defects-elements').textContent = elements.join('–');
  for (const id of ['defects-system-summary', 'defects-setup-settings', 'defects-advanced']) $(id).hidden = !targetPhase;
  $('defects-expanded-system').hidden = !dopants.length;
  $('defects-search-elements').textContent = selectedElements().join('–');
  const available = supportsCpd(selectedElements().length);
  const notice = $('defects-cpd-availability');
  notice.hidden = !targetPhase || available;
  notice.textContent = notice.hidden ? '' : cpdAvailability(selectedElements().length);
  $('defects-target-relax-controls').hidden = !targetPhase;
}

function importedTargetId(bundle) {
  if (bundle.targetPhaseId || bundle.cpdResult?.targetPhaseId) return bundle.targetPhaseId || bundle.cpdResult.targetPhaseId;
  if (!bundle.cpdResult?.constraints?.length) return null;
  const constrained = new Set(bundle.cpdResult.constraints.map(row => row.phase_id));
  const eligible = bundle.phaseEnergySet.entries.filter(entry => entry.status === 'converged' && !constrained.has(entry.phaseId))
    .map(entry => bundle.phaseDataset.phases.find(phase => phase.phaseId === entry.phaseId))
    .filter(phase => Contract.isChemicalSystemCompound(phase, bundle.phaseDataset.chemicalSystem));
  return eligible.length === 1 ? eligible[0].phaseId : null;
}

function normalizePhaseSearch(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function filterExcludedPhases() {
  const query = normalizePhaseSearch($('defects-excluded-query').value);
  const rows = [...$('defects-excluded-list').children];
  let matches = 0;
  for (const row of rows) {
    row.hidden = !row.dataset.search.includes(query);
    if (!row.hidden) matches++;
  }
  $('defects-excluded-count').textContent = matches
    ? `${formatPhaseCount(matches)} of ${formatPhaseCount(rows.length)} excluded candidates`
    : 'No excluded candidates match this search.';
}

function syncPhaseGroups() {
  const host = $('defects-phase-list'), excluded = $('defects-excluded-list'), more = $('defects-excluded-phases');
  const groups = new Map([...host.children].map(section => [section.dataset.group, section]));
  const rows = $('defects-phase-browser').querySelectorAll('.defects-phase-row');
  let focused = null;
  for (const row of rows) {
    const input = row.querySelector('input');
    const destination = input.checked ? groups.get(row.dataset.group).querySelector('.defects-phase-selected') : excluded;
    if (row.parentElement === destination) continue;
    if (document.activeElement === input) focused = input;
    const next = [...destination.children].find(item => Number(item.dataset.order) > Number(row.dataset.order));
    destination.insertBefore(row, next || null);
    row.hidden = false;
  }
  for (const section of groups.values()) section.hidden = !section.querySelector('.defects-phase-selected').childElementCount;
  more.hidden = !excluded.childElementCount;
  const summary = more.querySelector('summary');
  summary.textContent = `Excluded candidates (${formatPhaseCount(excluded.childElementCount)})`;
  filterExcludedPhases();
  if (focused) {
    const row = focused.closest('.defects-phase-row');
    (focused.checked || (more.open && !row.hidden) ? focused : summary).focus({preventScroll:true});
  }
}

function renderPhaseList() {
  const host = $('defects-phase-list'), excluded = $('defects-excluded-list'), existing = selectedPhaseIds();
  host.replaceChildren();
  excluded.replaceChildren();
  $('defects-phase-browser').hidden = !dataset;
  if (!dataset) {
    $('defects-excluded-phases').open = false;
    $('defects-excluded-query').value = '';
    return;
  }
  const allowed = new Set(dataset.chemicalSystem), limit = Math.max(1, Number($('defects-max-atoms').value) || 32);
  const computed = new Set((energySet?.entries || []).filter(entry => entry.status === 'converged').map(entry => entry.phaseId));
  const available = dataset.phases.filter(phase => phase.structure.atoms.every(atom => allowed.has(atom.element)));
  const groups = new Map();
  const groupName = phase => {
    if (phase.phaseId === targetPhase?.phaseId) return 'Target';
    const elements = dataset.chemicalSystem.filter(element => phase.structure.atoms.some(atom => atom.element === element));
    if (elements.length === 1) return 'Elemental reference candidates';
    return `Competing phases · ${elements.join('–')}`;
  };
  let phaseOrder = 0;
  for (const phase of available.slice().sort((a, b) => {
    const rank = phase => phase.phaseId === targetPhase?.phaseId ? 0 : new Set(phase.structure.atoms.map(atom => atom.element)).size;
    return rank(a) - rank(b) || groupName(a).localeCompare(groupName(b));
  })) {
    const group = groupName(phase);
    if (!groups.has(group)) {
      const section = document.createElement('section');
      const heading = document.createElement('h4');
      heading.textContent = group;
      section.className = 'defects-phase-group';
      section.dataset.group = group;
      const selected = document.createElement('div');
      selected.className = 'defects-phase-selected';
      section.append(heading, selected);
      host.append(section);
      groups.set(group, selected);
    }
    const label = document.createElement('label'); label.className = 'defects-phase-row';
    label.dataset.order = phaseOrder++;
    label.dataset.group = group;
    label.dataset.search = normalizePhaseSearch(`${phaseFormula(phase, false)} · ${phase.formula || ''} · ${phase.source.recordId}`);
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.phase = phase.phaseId;
    const aboveLimit = phase.phaseId !== targetPhase?.phaseId && phase.structure.atoms.length > limit;
    input.dataset.aboveLimit = String(aboveLimit);
    input.checked = !aboveLimit && (phase.phaseId === targetPhase?.phaseId || (existing.size ? existing.has(phase.phaseId) : computed.has(phase.phaseId)));
    input.addEventListener('change', () => { clearCpdPresentation(); syncButtons(); });
    const name = document.createElement('strong'); name.textContent = `${phaseFormula(phase)} · ${phase.source.recordId}`;
    const detail = document.createElement('span'); detail.className = 'phase-detail';
    const hull = phase.providerMetadata?.hullDistanceEvPerAtom;
    detail.textContent = `${phase.structure.atoms.length} atoms · ${phase.source.provider} · ${phase.source.license}${Number.isFinite(hull) ? ` · PBE hull ${hull.toFixed(5)} eV/atom (${phase.providerMetadata.cutoffStatus || 'unclassified'})` : ' · hull distance unavailable'}`;
    const energy = document.createElement('span'); energy.className = 'phase-count';
    const entry = (energySet?.entries || []).find(row => row.phaseId === phase.phaseId);
    energy.textContent = aboveLimit ? `Exceeds ${limit}-atom limit` : entry?.status === 'converged' ? `${entry.totalEnergyEv.toFixed(6)} eV · ready` : 'energy not calculated';
    input.disabled = aboveLimit || phase.phaseId === targetPhase?.phaseId || actionPending;
    label.append(input, name, detail, energy);
    (input.checked ? groups.get(group) : excluded).append(label);
  }
  if (!available.length) setStatus('defects-source-status', `No phases with supported periodic structures and ≤${limit} atoms are available. Increase the per-phase atom limit or import a dataset.`, 'warning');
  renderSetup();
  syncButtons();
}

function syncButtons() {
  syncPhaseGroups();
  const loaded = !!dataset, chosen = selectedPhaseIds(), model = selectedModel();
  const uncomputedSelected = (dataset?.phases || []).filter(phase => chosen.has(phase.phaseId) && !energyEntry(phase.phaseId));
  const unsupported = [...new Set(uncomputedSelected.flatMap(phase => phase.structure.atoms.map(atom => atom.element)))].filter(symbol => !model?.supported_atomic_symbols?.includes(symbol));
  const withinLimit = chosen.size > 0 && chosen.size <= MAX_PHASES && [...chosen].every(id => id === targetPhase?.phaseId || (phaseRecord(id)?.structure.atoms.length || Infinity) <= (Number($('defects-max-atoms').value) || 32));
  const hasEnergy = !!energySet && [...chosen].some(id => energyEntry(id));
  const hasUnaryReferences = !!dataset && dataset.chemicalSystem.every(element => dataset.phases.some(phase => phase.structure.atoms.length > 0 && phase.structure.atoms.every(atom => atom.element === element) && chosen.has(phase.phaseId)));
  const supportedSystem = supportsCpd(dataset?.chemicalSystem.length) && supportsCpd(selectedElements().length);
  const canSearch = !!currentSetupRelaxation() && supportsPhaseSearch(selectedElements().length) && !collectionLimitReached();
  const targetIncluded = !targetPhase || chosen.has(targetPhase.phaseId);
  const ready = setupReady();
  $('defects-competing-step').hidden = !ready || (!supportsPhaseSearch(selectedElements().length) && !dataset);
  $('defects-cpd-step').hidden = !ready;
  if (!ready) $('defects-neutral-step').hidden = true;
  $('defects-target-poscar').readOnly = actionPending;
  $('defects-target-format').disabled = actionPending;
  $('defects-copy-relaxed-poscar').disabled = actionPending || pendingTargetEdits();
  $('defects-show-relaxed').disabled = actionPending || pendingTargetEdits() || !currentRelaxedTargetGeometry();
  $('defects-apply-poscar').disabled = actionPending || !pendingTargetEdits() || !$('defects-target-poscar').value.trim();
  $('defects-relax-target').disabled = actionPending || !targetPhase || !model || pendingTargetEdits() || !!currentSetupRelaxation() ||
    hostElements().some(element => !model.supported_atomic_symbols.includes(element));

  for (const id of ['defects-target-file', 'defects-copy-target', 'defects-target-query', 'defects-target-match', 'defects-target-next', 'defects-find-target', 'defects-cutoff', 'defects-max-atoms', 'defects-import', 'defects-model', 'defects-search']) $(id).disabled = actionPending;
  const slots = dopantSlotCount(hostElements().length);
  const editDopants = $('defects-edit-dopants');
  editDopants.hidden = !slots;
  editDopants.disabled = actionPending || !model;
  editDopants.textContent = dopants.length ? 'Edit dopants' : '+ Add dopants';
  for (const chip of $('defects-dopant-summary').querySelectorAll('button')) chip.disabled = actionPending;
  $('defects-legacy-target').disabled = actionPending;
  for (const button of document.querySelectorAll('[data-defects-example]')) button.disabled = actionPending;
  for (const button of $('defects-target-matches').querySelectorAll('button[data-structure-id]')) {
    button.disabled = actionPending;
    button.setAttribute('aria-pressed', String(targetPhase?.phaseId === 'alexandria-pbe:' + button.dataset.structureId));
  }
  $('defects-search').disabled = actionPending || !ready || !canSearch;
  $('defects-target-format').disabled = actionPending;
  syncSetupSummary(canSearch);
  for (const input of $('defects-phase-browser').querySelectorAll('input[data-phase]')) input.disabled = actionPending || input.dataset.aboveLimit === 'true' || input.dataset.phase === targetPhase?.phaseId;
  $('defects-calculate').disabled = !ready || actionPending || !supportedSystem || !targetIncluded || !loaded || !withinLimit || unsupported.length > 0 || !hasUnaryReferences || (!hasEnergy && !model);
  const readiness = $('defects-cpd-readiness');
  const elementCount = selectedElements().length;
  const reason = !supportsCpd(elementCount) ? cpdAvailability(elementCount)
    : !loaded ? 'Find competing phases or open a CPD project before running.'
    : !targetIncluded || !withinLimit ? 'Include the target and keep the selected phases within the limits.'
    : !hasUnaryReferences ? 'Select an elemental reference phase for each element.'
    : unsupported.length ? `The selected model cannot calculate ${unsupported.join(', ')}.` : '';
  readiness.hidden = !reason || !targetPhase;
  readiness.textContent = reason;
  $('defects-resume').disabled = !ready || actionPending || !supportedSystem || !targetIncluded || !loaded || !withinLimit || unsupported.length > 0 || !!queue?.running;
  $('defects-resume-provider').disabled = actionPending;
  $('defects-resume-provider').hidden = !canSearch || !collection?.subsets?.some(subset => subset.nextUrl);
  $('defects-export-bundle').disabled = actionPending || !targetPhase || !dataset || !energySet;
  $('defects-export-vertices-yaml').disabled = !cpdResult?.vertices.length;
  $('defects-cpd-use-polymorph').disabled = actionPending || pendingTargetEdits();
  syncVacancyControls();
  $('defects-selection-summary').textContent = dataset
    ? `${chosen.size} selected for the next CPD (max ${MAX_PHASES}) · ${[...chosen].filter(id => energyEntry(id)).length} energies ready`
    : '';
}

const formatPhaseCount = new Intl.NumberFormat('en-US').format;

function renderCollectionStatus(running = false) {
  const complete = collection.subsets.filter(subset => subset.status === 'complete').length;
  const started = collection.subsets.filter(subset => subset.pages > 0).length;
  const total = collection.subsets.length;
  const state = running ? 'Searching' : collection.status === 'complete' ? 'Complete' : 'Partial';
  const coverage = `${complete}/${total} element subsets complete · ${started}/${total} sampled`;
  const cutoff = running ? '' : ` · ${formatPhaseCount(collection.cutoffSummary.within)} within ≤${collection.hullCutoff.value} eV/atom`;
  const reason = running ? '' : collection.errors.map(error => error.message).join(' ');
  setStatus('defects-source-status',
    `${state} · ${formatPhaseCount(collection.recordCount)} records from ${collection.pageCount} pages · ${coverage}${cutoff}${reason ? ` · ${reason}` : ''}`,
    state === 'Partial' ? 'warning' : 'info');
}

async function collectPhases(checkpoint = null) {
  if (!currentSetupRelaxation() || pendingTargetEdits()) throw new Error('Relax the active target before searching for phases.');
  const elements = checkpoint?.chemicalSystem || selectedElements();
  if (!supportsPhaseSearch(elements.length)) throw new Error(cpdAvailability(elements.length));
  const key = collectionKey();
  providerController = new AbortController();
  $('defects-search').disabled = true; $('defects-search-stop').disabled = false; $('defects-resume-provider').disabled = true;
  try {
    setStatus('defects-source-status', checkpoint ? 'Resuming the saved exact-subset provider cursor…' : 'Searching every exact elemental subset in Alexandria…');
    const config = checkpoint?.config || { ...Provider.DEFAULTS, pageLimit: 100,
      requestBudget: dopants.length ? Math.max(16, 2 ** elements.length) : 8,
      maxPages: 256, maxRecords: dopants.length > 1 ? 8000 : dopants.length ? 3000 : 1000, maxResponseBytes: 4194304, timeoutMs: 20000, retries: 2 };
    collection = await Provider.collect({ elements, checkpoint, cutoff: Number($('defects-cutoff').value), config, sampleSubsetsFirst: !!dopants.length, signal: providerController.signal,
      onCheckpoint: async value => { collection = value; await providerStore.save(key, value); renderCollectionStatus(true); } });
    clearCpdPresentation(); energySet = null; referenceSet = null; importedBundle = null; lastEnergySummary = null;
    dataset = withTarget(Provider.toPhaseDataset(collection));
    renderCollectionStatus(); renderPhaseList();
    const autoSelected = new Set(targetPhase ? [targetPhase.phaseId] : []);
    for (const element of dataset.chemicalSystem) {
      const unary = dataset.phases.filter(phase => phase.structure.atoms.every(atom => atom.element === element) && phase.structure.atoms.length <= Number($('defects-max-atoms').value) && phase.providerMetadata.cutoffStatus === 'within')
        .sort((a, b) => (a.providerMetadata.hullDistanceEvPerAtom ?? Infinity) - (b.providerMetadata.hullDistanceEvPerAtom ?? Infinity) || a.structure.atoms.length - b.structure.atoms.length).slice(0, dopants.length ? 1 : 2);
      unary.forEach(phase => autoSelected.add(phase.phaseId));
    }
    const compounds = dataset.phases.filter(phase => phase.phaseId !== targetPhase?.phaseId && new Set(phase.structure.atoms.map(atom => atom.element)).size > 1 && phase.structure.atoms.length <= Number($('defects-max-atoms').value) && phase.providerMetadata.cutoffStatus === 'within')
      .sort((a, b) => (a.providerMetadata.hullDistanceEvPerAtom ?? Infinity) - (b.providerMetadata.hullDistanceEvPerAtom ?? Infinity) || a.structure.atoms.length - b.structure.atoms.length);
    const compoundElements = new Map(compounds.map(phase =>
      [phase.phaseId, new Set(phase.structure.atoms.map(atom => atom.element))]));
    const elementsFor = phase => compoundElements.get(phase.phaseId);
    // Give each dopant and the host a slot before filling the remainder by hull rank.
    const covered = new Set();
    for (const dopant of dopants) {
      if (covered.has(dopant)) continue;
      const phase = compounds.find(candidate => elementsFor(candidate).has(dopant));
      if (!phase) continue;
      autoSelected.add(phase.phaseId);
      for (const symbol of elementsFor(phase)) covered.add(symbol);
    }
    if (dopants.length > 1) {
      const native = compounds.find(phase => !dopants.some(symbol => elementsFor(phase).has(symbol)));
      if (native) autoSelected.add(native.phaseId);
      if (autoSelected.size < MAX_PHASES) {
        const coupled = compounds.find(phase => dopants.filter(symbol => elementsFor(phase).has(symbol)).length > 1);
        if (coupled) autoSelected.add(coupled.phaseId);
      }
    }
    compounds.filter(phase => !autoSelected.has(phase.phaseId)).slice(0, MAX_PHASES - autoSelected.size)
      .forEach(phase => autoSelected.add(phase.phaseId));
    for (const input of $('defects-phase-browser').querySelectorAll('input[data-phase]')) input.checked = autoSelected.has(input.dataset.phase);
    syncButtons();
    setStatus('defects-run-status', `${autoSelected.size} bounded phase candidates selected (≤${$('defects-max-atoms').value} atoms per competing phase, at most ${MAX_PHASES} structures). Check or change the phases before calculating.`, 'info');
  } finally {
    providerController = null; $('defects-search').disabled = false; $('defects-search-stop').disabled = true; syncButtons();
  }
}

function releaseModelWorker() {
  worker?.terminate();
  worker = null;
  loadedModelKey = null;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = null;
}
document.addEventListener('macer-phonon-workspace-change', ({detail}) => {
  if (detail.workspace !== 'defects' && !actionPending) releaseModelWorker();
});

async function ensureModelWorker(model) {
  if (loadedModelKey === model.model_key && worker) return { modelKey: model.model_key, modelId: model.model_id, weightsSha256: model.weights_sha256 };
  if (modelLoadPromise) return modelLoadPromise;
  releaseModelWorker();
  const asset = modelCatalog.runtime_assets.worker, response = await fetch(asset.url, { cache: 'no-cache' });
  const bytes = await response.arrayBuffer();
  if (!response.ok || bytes.byteLength !== asset.size_bytes || await shaBytes(bytes) !== asset.sha256) throw new Error('Pinned relaxation Worker source size/SHA-256 verification failed.');
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  workerUrl = blobUrl; worker = new Worker(workerUrl); modelLoadPromise = {};
  const promise = new Promise((resolve, reject) => { modelLoadPromise.resolve = resolve; modelLoadPromise.reject = reject; });
  worker.onmessage = event => {
    const data = event.data || {};
    if (modelLoadPromise && data.type === 'ready' && data.modelKey === model.model_key) { loadedModelKey = model.model_key; modelLoadPromise.resolve({ modelKey: model.model_key, modelId: model.model_id, weightsSha256: model.weights_sha256 }); modelLoadPromise = null; return; }
    if (modelLoadPromise && data.type === 'error' && data.modelKey === model.model_key) { const pending = modelLoadPromise; modelLoadPromise = null; pending.reject(new Error(data.message || 'Model load failed.')); return; }
    const current = activeRun;
    if (!current || data.runId !== current.context.runId || data.inputRevision !== 1 || data.modelKey !== model.model_key) return;
    if (data.type === 'step' || data.type === 'batch') {
      const snapshots = data.type === 'batch' ? data.snapshots : [data.snapshot];
      current.chain = current.chain.then(async () => { for (const snapshot of snapshots) { await current.onSnapshot(snapshot); current.last = snapshot; current.evaluations++; } setStatus(current.statusId, `${current.task.phaseId} · step ${current.last?.step ?? 0} · ${current.evaluations} force/stress evaluations`); }).catch(error => current.reject(error));
    } else if (data.type === 'finished') {
      current.chain.then(() => { if (activeRun !== current) return; current.resolve({ status: data.state === 'converged' ? 'converged' : 'max_steps', evaluations: current.evaluations, totalEnergyEv: current.last?.evaluation?.energy_ev, geometry: current.last?.structure, maxForceEvA: current.last?.max_force_ev_per_a, maxStressResidualGpa: current.last?.max_stress_residual_gpa, elapsedSeconds: (performance.now() - current.started) / 1000 }); activeRun = null; });
    } else if (data.type === 'stopped' || data.type === 'error') {
      if (data.type === 'stopped') { current.resolve({ status: 'cancelled', evaluations: current.evaluations }); activeRun = null; }
      else { current.reject(new Error(data.message || 'Phase relaxation failed.')); activeRun = null; }
    }
  };
  worker.onerror = event => { const error = new Error(event.message || 'Phase relaxation Worker failed.'); if (modelLoadPromise) { const pending = modelLoadPromise; modelLoadPromise = null; pending.reject(error); } if (activeRun) { const current = activeRun; activeRun = null; current.reject(error); } };
  worker.postMessage({ type: 'loadModel', loadId: 1, runId: 0, inputRevision: 1, modelKey: model.model_key, model, assetBase: new URL('./', location.href).href });
  return promise;
}

function makeRunner(model, statusId = 'defects-run-status') {
  return {
    prepare: loaded => ensureModelWorker(model).then(actual => {
      if (loaded.modelKey !== model.model_key || actual.modelKey !== model.model_key) throw new Error('Phase model identity changed before calculation.');
      return { modelKey: model.model_key, modelId: model.model_id, weightsSha256: model.weights_sha256 };
    }),
    async runRelax(task, {onSnapshot = () => {}} = {}) {
      if (activeRun) throw new Error('A phase force calculation is already running.');
      const context = { loadId: 1, runId: ++runCounter, inputRevision: 1, modelKey: model.model_key };
      const current = { context, task, onSnapshot, statusId, chain: Promise.resolve(), evaluations: 0, last: null, started: performance.now() };
      const result = new Promise((resolve, reject) => { current.resolve = resolve; current.reject = reject; }); activeRun = current;
      const n = task.structure.atomic_numbers.length;
      const relaxCell = task.settings.mode === 'isif3';
      worker.postMessage({ type: 'start', ...context, modelId: model.model_id, structure: task.structure,
        settings: { optimizer: task.settings.optimizer, max_steps: task.settings.maxSteps, fmax_ev_per_a: task.settings.forceToleranceEvA, smax_gpa: task.settings.stressToleranceGpa, pressure_gpa: 0, optimize_positions: true, optimize_cell_shape: relaxCell, optimize_cell_volume: relaxCell, fractional_constraints: false, movable: Array.from({ length: n }, () => [true, true, true]) }, waitForStepAcknowledgement: false });
      return result;
    },
    async stop() { if (activeRun && worker) worker.postMessage({ type: 'stop', ...activeRun.context }); },
  };
}
let runCounter = 0;

function phaseToGeometry(phase) {
  return { cell_a: phase.structure.cell.map(row => row.slice()), atomic_numbers: phase.structure.atoms.map(atom => atomicNumber(atom.element)), positions_a: phase.structure.atoms.map(atom => globalThis.Structures.cartesian(atom.fractional, phase.structure.cell)), pbc: phase.structure.pbc.slice() };
}

async function relaxSetupTarget() {
  if (!targetPhase || pendingTargetEdits()) throw new Error('Apply the structure input before relaxing.');
  const model = selectedModel();
  if (!model) throw new Error('Choose a force model.');
  const target = targetPhase;
  const structure = phaseToGeometry(target);
  setStatus('defects-target-relax-status', `Loading ${model.display_name}…`);
  await ensureModelWorker(model);
  const settings = cpdRelaxSettings;
  const runner = makeRunner(model, 'defects-target-relax-status');
  const run = await runner.runRelax({phaseId: 'Target relaxation', structure, settings});
  const result = requireConverged(run, structure, settings, 'Target relaxation');
  setupRelaxation = {target, model: modelIdentity(model), settings, result,
    initialHash: await Project.hash(structure), finalHash: await Project.hash(result.geometry)};
  relaxedHost = {phaseId: target.phaseId, modelKey: model.model_key, hash: setupRelaxation.finalHash, geometry: result.geometry};
  setStatus('defects-target-relax-status', `Converged · ${result.evaluations} force/stress evaluations · max force ${result.maxForceEvA.toFixed(4)} eV/Å.`);
  showTargetStructure();
  targetFrame = 'relaxed';
  showTargetStructure();
  syncButtons();

}

async function reuseSetupTarget(project) {
  const prepared = currentSetupRelaxation();
  const task = project.tasks.find(row => row.phaseId === targetPhase.phaseId);
  if (!prepared || !task || task.status === 'completed' || canonical(prepared.model) !== canonical(project.model) ||
    canonical(prepared.settings) !== canonical(task.settings) || prepared.initialHash !== await Project.hash(task.structure)) return;
  const run = prepared.result;
  task.status = 'completed';
  task.result = {status: 'converged', phaseId: task.phaseId, taskKey: task.taskKey,
    model: clone(project.model), totalEnergyEv: run.totalEnergyEv, atomCount: run.geometry.atomic_numbers.length,
    initialGeometrySha256: prepared.initialHash, finalGeometrySha256: prepared.finalHash,
    relaxSettings: clone(task.settings), geometry: clone(run.geometry), evaluations: run.evaluations,
    elapsedSeconds: run.elapsedSeconds, convergence: {maxForceEvA: run.maxForceEvA, maxStressResidualGpa: run.maxStressResidualGpa}};
  project.metrics.completed++;
}

async function buildEnergySet(project, model) {
  const selected = selectedPhaseIds(), phases = dataset.phases.filter(phase => selected.has(phase.phaseId));
  const entries = phases.map(phase => {
    const task = project.tasks.find(row => row.phaseId === phase.phaseId);
    if (task?.status === 'completed') return { phaseId: phase.phaseId, status: 'converged', totalEnergyEv: task.result.totalEnergyEv, atomCount: task.result.atomCount, initialGeometrySha256: task.result.initialGeometrySha256, finalGeometrySha256: task.result.finalGeometrySha256, relax: { optimizer: task.result.relaxSettings.optimizer, mode: 'isif3', forceToleranceEvA: task.result.relaxSettings.forceToleranceEvA, stressToleranceGpa: task.result.relaxSettings.stressToleranceGpa }, evaluations: task.result.evaluations, elapsedSeconds: task.result.elapsedSeconds };
    const prior = energySet?.entries.find(entry => entry.phaseId === phase.phaseId && entry.status === 'converged');
    return prior || { phaseId: phase.phaseId, status: task?.status === 'cancelled' ? 'cancelled' : task?.status === 'max_steps' ? 'max_steps' : 'failed' };
  });
  const datasetSha256 = await Contract.sha256({ dataset, structures: phases.map(phaseToGeometry) });
  return Contract.validateEnergySet({ schema: Contract.SCHEMAS.energy, schemaVersion: 1, energySetId: `${model.model_id}:${datasetSha256.slice(0, 20)}`, datasetId: dataset.datasetId, model: { modelId: model.model_id, weightsSha256: model.weights_sha256 }, energyUnit: 'eV', entries }, dataset, { modelId: model.model_id, weightsSha256: model.weights_sha256 });
}

function referencesForCurrentEnergies() {
  const refs = [];
  for (const element of dataset.chemicalSystem) {
    const candidates = energySet.entries.filter(entry => entry.status === 'converged' && selectedPhaseIds().has(entry.phaseId)).map(entry => ({ entry, phase: phaseRecord(entry.phaseId) })).filter(row => row.phase.structure.atoms.every(atom => atom.element === element));
    if (!candidates.length) throw new Error(`Missing converged unary reference for ${element}. Select and calculate a unary phase. CPD was not run.`);
    candidates.sort((a, b) => a.entry.totalEnergyEv / a.entry.atomCount - b.entry.totalEnergyEv / b.entry.atomCount);
    const { entry, phase } = candidates[0]; refs.push({ element, phaseId: phase.phaseId, mu0EvPerAtom: entry.totalEnergyEv / entry.atomCount, unit: 'eV/atom', source: `${energySet.model.modelId} calculated unary structure ${phase.source.recordId}` });
  }
  referenceSet = { schema: Contract.SCHEMAS.references, schemaVersion: 1, referenceSetId: `references:${energySet.energySetId}`, energySetId: energySet.energySetId, references: refs };
  return refs;
}

function renderCpdPhaseUsage(result) {
  const refs = new Set(result.elemental_reference_phase_ids);
  const entries = result.input_phase_energies.map(phase => {
    const id = phase.phase_id;
    const record = phaseRecord(id);
    const role = id === result.target_phase_id ? 'Target' : refs.has(id) ? 'Elemental reference'
      : phase.atom_counts.filter(Boolean).length === 1 ? 'Other elemental phase' : 'Competing compound';
    return {role, label: `${phaseFormula(record)} · ${record.source.recordId}`};
  });
  const roles = [['Target','target'],['Elemental reference','elemental references'],
    ['Competing compound','competing compounds'],['Other elemental phase','other elemental phases']];
  const counts = roles.map(([role,label]) => [entries.filter(entry => entry.role === role).length,label]);
  $('defects-phase-usage-summary').textContent = `CPD used ${entries.length} phases · ${counts
    .filter(([count]) => count > 0).map(([count,label]) => `${count} ${label}`).join(' / ')}`;
  $('defects-phase-usage-list').replaceChildren(...roles.flatMap(([role]) => entries.filter(entry => entry.role === role).map(entry => {
    const item = document.createElement('li');
    item.textContent = `${role} · ${entry.label}`;
    return item;
  })));
}

function formatTargetCount(phase, element) { return phase.structure.atoms.filter(atom => atom.element === element).length; }

async function calculateCpd() {
  if (!dataset) throw new Error('Load the competing phases first.');
  if (!supportsCpd(dataset.chemicalSystem.length)) throw new Error(cpdAvailability(dataset.chemicalSystem.length));
  const targetId = targetPhase?.phaseId;
  if (!targetId || !energyEntry(targetId)) throw new Error('Select one computed compound phase as the target.');
  const refs = referencesForCurrentEnergies(), selected = selectedPhaseIds(), model = energySet.model;
  const phaseRows = dataset.phases.filter(phase => selected.has(phase.phaseId) && energyEntry(phase.phaseId));
  const input = { elements: dataset.chemicalSystem, target_phase_id: targetId, model: { model_id: model.modelId, weights_sha256: model.weightsSha256 }, pressure_gpa: 0,
    phases: phaseRows.map(phase => ({ phase_id: phase.phaseId, atom_counts: dataset.chemicalSystem.map(element => formatTargetCount(phase, element)), total_energy_ev: energyEntry(phase.phaseId).totalEnergyEv, energy_unit: 'eV', model: { model_id: model.modelId, weights_sha256: model.weightsSha256 } })),
    elemental_references: refs.map(row => ({ element: row.element, phase_id: row.phaseId })) };
  cpdClient?.dispose(); cpdClient = createCpdWorkerClient();
  $('defects-calculate').disabled = true;
  clearCpdPresentation();
  let response;
  try {
    response = await cpdClient.run(input, { onStarted: () => setStatus('defects-run-status', 'CPD WASM Worker started…'), onComputing: () => setStatus('defects-run-status', 'Calculating the CPD half-spaces and vertices in WASM…') });
  } finally {
    cpdClient.dispose();
    cpdClient = null;
  }
  if (response.units?.energy_per_atom !== 'eV/atom' || response.units?.chemical_potential !== CPD_MU_UNIT || response.units?.total_energy !== 'eV') throw new Error('CPD response is missing its explicit energy units.');
  cpdResult = response.result;
  renderCpdPhaseUsage(cpdResult);
  renderCpdResult();
  const partial = !dataset.providerSnapshot.complete || !dataset.providerSnapshot.exactSubsetPaginationComplete ||
    dataset.phases.some(phase => phase.providerMetadata?.cutoffStatus === 'within' && (!selected.has(phase.phaseId) || !energyEntry(phase.phaseId)));
  const accounting = lastEnergySummary ? ` · ${lastEnergySummary.evaluations} force/stress evaluations · ${lastEnergySummary.elapsedSeconds.toFixed(2)} s cumulative queue time` : ' · imported/precomputed energy set';
  setStatus('defects-run-status', `CPD ${correctionLabel(cpdResult)} · ${cpdResult.vertices.length} vertices · ${phaseRows.length} calculated phases · model ${model.modelId}${accounting}${partial ? ' · PARTIAL phase coverage' : ''}`, partial || cpdResult.stabilization ? 'warning' : 'info');
  if (currentCpdPotentials()) {
    $('defects-cpd-explorer').dataset.reservoirReady = '';
    $('defects-neutral-step').hidden = false;
    setStatus('defects-vacancy-status', 'Preparing the calculation supercell and defect candidates…');
    try {
      await prepareDefectPreview();
    } catch (error) {
      setStatus('defects-vacancy-status', error.message, 'error');
    }
  }
}

function vertexLabel(index) {
  const letter = String.fromCharCode(65 + index % 26);
  return index < 26 ? letter : vertexLabel(Math.floor(index / 26) - 1) + letter;
}

// Clip each binary phase's equality line to the plot box and all of the
// calculated inequalities. The target's selected vertices still come from WASM.
function binaryPhaseBoundaries(result, domain) {
  const total = result.target_atom_counts.reduce((sum, count) => sum + count, 0);
  const rows = [...result.constraints, {
    phase_id: result.target_phase_id,
    composition_fraction: result.target_atom_counts.map(count => count / total),
    bound_ev_per_atom: result.target_formation_energy_ev_per_atom,
  }];
  return rows.flatMap(row => {
    const [a, b] = row.composition_fraction;
    const h = row.bound_ev_per_atom, point = [a * h / (a*a + b*b), b * h / (a*a + b*b)];
    const direction = [-b, a];
    let lo = -Infinity, hi = Infinity;
    const clip = (coeff, bound) => {
      const slope = coeff[0] * direction[0] + coeff[1] * direction[1];
      const residual = bound - coeff[0] * point[0] - coeff[1] * point[1];
      if (Math.abs(slope) < 1e-12) return residual >= -1e-8;
      if (slope > 0) hi = Math.min(hi, residual / slope);
      else lo = Math.max(lo, residual / slope);
      return lo <= hi + 1e-8;
    };
    for (let axis = 0; axis < 2; axis++) {
      const coeff = [0, 0];
      coeff[axis] = 1;
      if (!clip(coeff, domain[axis][1])) return [];
      coeff[axis] = -1;
      if (!clip(coeff, -domain[axis][0])) return [];
    }
    if (!rows.every(limit => clip(limit.composition_fraction, limit.bound_ev_per_atom)) || hi - lo < 1e-8) return [];
    return [{row, ends: [lo, hi].map(t => point.map((value, axis) => value + t * direction[axis]))}];
  });
}

function axisTicks([low, high]) {
  const rough = (high - low) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].find(scale => scale * magnitude >= rough) * magnitude;
  const first = Math.ceil(low / step - 1e-8), last = Math.floor(high / step + 1e-8);
  return Array.from({length: last - first + 1}, (_, i) => Number(((i + first) * step).toPrecision(8)));
}

const formatDelta = value => (Math.abs(value) < 5e-8 ? 0 : value).toFixed(4);
const phaseColor = row => row.composition_fraction.slice().reverse().reduce((rgb, fraction) =>
  rgb * 256 + Math.round(153 + 102 * fraction), 0);
const vertexTooltip = (result, vertex, index) => [
  `Vertex ${vertexLabel(index)}`,
  ...result.elements.map((element, axis) => `Δμ_${element} = ${formatDelta(vertex.delta_mu_ev_per_atom[axis])} eV/atom`),
].join('\n');

function renderCpdRanges(result, domain) {
  const host = $('defects-cpd-ranges');
  const rows = result.elements.map((element, axis) => {
    const values = result.vertices.map(vertex => vertex.delta_mu_ev_per_atom[axis]);
    const row = document.createElement('tr');
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = element;
    row.append(name);
    const plot = domain?.[axis];
    for (const bounds of [plot, values.length && [Math.min(...values), Math.max(...values)]]) {
      const cell = document.createElement('td');
      cell.textContent = bounds ? bounds.map(formatDelta).join(' to ') : '—';
      row.append(cell);
    }
    return row;
  });
  host.querySelector('tbody').replaceChildren(...rows);
  host.hidden = !domain && result.elements.length <= 3;
}

// Use an initial window beyond every possible finite intercept, then use
// the reference CPD's common lower bound from the finite coordinates only.
function cpdWindow(result, rows, findPoints) {
  const vertices = result.vertices.map(vertex => vertex.delta_mu_ev_per_atom);
  const intercepts = rows.flatMap(row => row.composition_fraction
    .filter(fraction => fraction > 0).map(fraction => row.bound_ev_per_atom / fraction));
  const provisional = 1.2 * Math.min(-0.05, ...intercepts, ...vertices.flat());
  const outer = result.elements.map(() => [provisional, 0]);
  const finite = findPoints(outer).flat().filter(value => value > provisional + 1e-8);
  const lower = 1.1 * Math.min(-0.05, ...finite, ...vertices.flat());
  return result.elements.map(() => [lower, 0]);
}

// Build one visible facet per phase using the same half-spaces as the
// CPD solver. Only the finite viewing window clips unbounded facets.
function buildCpd3dScene(result) {
  const count = result.target_atom_counts.reduce((sum, n) => sum + n, 0);
  const target = {
    phase_id: result.target_phase_id,
    composition_fraction: result.target_atom_counts.map(n => n / count),
    bound_ev_per_atom: result.target_formation_energy_ev_per_atom,
  };
  const rows = [...result.constraints, target];
  const dot = (a, b) => a.reduce((sum, x, axis) => sum + x * b[axis], 0);
  function clip(face, limit) {
    const output = [];
    for (const [i, a] of face.entries()) {
      const b = face[(i + 1) % face.length];
      const da = dot(limit.composition_fraction, a) - limit.bound_ev_per_atom;
      const db = dot(limit.composition_fraction, b) - limit.bound_ev_per_atom;
      const insideA = da <= 1e-10, insideB = db <= 1e-10;
      if (insideA) output.push(a);
      if (insideA !== insideB) output.push(a.map((x, axis) => x + (b[axis] - x) * da / (da - db)));
    }
    return output;
  }
  function phaseFacets(domain) {
    const limits = rows.slice();
    for (const [axis, [lower, upper]] of domain.entries()) {
      for (const [sign, bound] of [[1, upper], [-1, -lower]]) {
        limits.push({composition_fraction: domain.map((_, index) => index === axis ? sign : 0), bound_ev_per_atom: bound});
      }
    }
    return rows.flatMap(row => {
      const normal = row.composition_fraction;
      const anchor = normal.indexOf(Math.max(...normal)), u = (anchor + 1) % 3, v = (anchor + 2) % 3;
      let face = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([i, j]) => {
        const point = [0, 0, 0];
        point[u] = domain[u][i];
        point[v] = domain[v][j];
        point[anchor] = (row.bound_ev_per_atom - dot(normal, point)) / normal[anchor];
        return point;
      });
      for (const limit of limits) {
        if (limit === row) continue;
        face = clip(face, limit);
        if (face.length < 3) return [];
      }
      return [{row, face}];
    });
  }
  const domain = cpdWindow(result, rows, outer => phaseFacets(outer).flatMap(({face}) => face));
  // Keep equal physical scales and orient the first chemical axis vertically.
  const order = [1, 0, 2];
  const center = domain.map(([lo, hi]) => (lo + hi) / 2);
  const centered = point => order.map(axis => point[axis] - center[axis]);
  const faces = [], faceStyles = [], visiblePhases = [];
  for (const {row, face} of phaseFacets(domain)) {
    const highlighted = row === target;
    const color = highlighted ? 0x8ebce4 : phaseColor(row);
    const phase = phaseRecord(row.phase_id);
    faces.push(face.map(centered));
    faceStyles.push({color, opacity: 1, normal: order.map(axis => row.composition_fraction[axis]),
      edgeColor: highlighted ? 0x185b94 : 0x354454, label: phase ? phaseFormula(phase) : '', target: highlighted});
    visiblePhases.push({row, color});
  }
  const grid = order.map(axis => ({
    label: 'Δμ',
    subscript: result.elements[axis],
    unit: CPD_MU_UNIT,
    bounds: domain[axis].map(value => value - center[axis]),
    ticks: axisTicks(domain[axis]).map(value => ({position: value - center[axis], label: String(value)})),
  }));
  return {faces, faceStyles, grid, domain, order, visiblePhases, positionOf: centered,
    pickSurface: faceStyles.some(style => style.target),
    potentialsAt: position => center.map((value, axis) => value + position[order.indexOf(axis)]),
    radius: Math.hypot(...center),
    points: result.vertices.map((vertex, index) => ({position: centered(vertex.delta_mu_ev_per_atom),
      label: vertexLabel(index), title: vertexTooltip(result, vertex, index)})),
    selected: activeVertex ?? 0,
  };
}

function planarHostHull(positions, normal) {
  // Drop the axis with the largest coefficient in the host equality for the
  // planar hull, then draw the boundary in all three physical coordinates.
  const dependent = normal.indexOf(Math.max(...normal));
  const [u, v] = [0, 1, 2].filter(axis => axis !== dependent);
  const ordered = positions.slice().sort((a, b) => a[u] - b[u] || a[v] - b[v]);
  const chain = points => {
    const hull = [];
    for (const point of points) {
      while (hull.length >= 2) {
        const [a, b] = hull.slice(-2);
        const cross = (b[u] - a[u]) * (point[v] - a[v]) - (b[v] - a[v]) * (point[u] - a[u]);
        if (cross > 1e-10) break;
        hull.pop();
      }
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  return [...chain(ordered), ...chain(ordered.slice().reverse())];
}

// A convex polygon can be triangulated from its first corner. Interpolate
// the full reservoirs, including coordinates hidden by an axis projection.
function interpolateCpdFace(point, polygon, potentials) {
  const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
  const dot = (a, b) => a.reduce((sum, value, axis) => sum + value * b[axis], 0);
  if (polygon.length < 3) return null;
  const offset = subtract(point, polygon[0]);
  for (let i = 1; i + 1 < polygon.length; i++) {
    const u = subtract(polygon[i], polygon[0]), v = subtract(polygon[i + 1], polygon[0]);
    const uu = dot(u, u), uv = dot(u, v), vv = dot(v, v);
    const denominator = uu * vv - uv * uv;
    if (denominator <= 1e-14) continue;
    const ou = dot(offset, u), ov = dot(offset, v);
    const b = (ou * vv - ov * uv) / denominator, c = (ov * uu - ou * uv) / denominator;
    const weights = [1 - b - c, b, c];
    if (weights.some(weight => weight < -1e-7)) continue;
    const [a, y, z] = weights.map(weight => Math.max(0, weight));
    return potentials[0].map((value, axis) =>
      (a * value + y * potentials[i][axis] + z * potentials[i + 1][axis]) / (a + y + z));
  }
  return null;
}

function buildCpdProjection(result, elements, hostAxes) {
  const axes = elements.map(element => result.elements.indexOf(element));
  const groups = [], groupByVertex = [];
  result.vertices.forEach((vertex, index) => {
    const point = axes.map(axis => vertex.delta_mu_ev_per_atom[axis]);
    let group = groups.findIndex(({position}) => position.every((value, axis) => Math.abs(value - point[axis]) <= 1e-7));
    if (group < 0) {
      group = groups.length;
      groups.push({position: point, vertices: []});
    }
    groups[group].vertices.push(index);
    groupByVertex[index] = group;
  });

  const positions = groups.map(group => group.position);
  const normal = axes.map(axis => result.target_atom_counts[axis]);
  // Extrinsic recession directions vanish only in host coordinates, where the
  // convex hull of finite projected vertices describes the full region.
  const hull = hostAxes ? planarHostHull(positions, normal) : [];
  const domain = axes.map((_, index) => {
    const values = positions.map(point => point[index]);
    return [Math.min(...values), Math.max(...values)];
  });
  const pad = 0.08 * Math.max(1, ...domain.map(([lo, hi]) => hi - lo));
  const bounds = domain.map(([lo, hi]) => [lo - pad, hi + pad]);
  const center = bounds.map(([lo, hi]) => (lo + hi) / 2);
  const order = [0, 1, 2];
  const centered = point => point.map((value, axis) => value - center[axis]);
  const grid = elements.map((element, axis) => ({
    label: 'Δμ', subscript: element, unit: CPD_MU_UNIT,
    bounds: bounds[axis].map(value => value - center[axis]),
    ticks: axisTicks(bounds[axis]).map(value => ({position: value - center[axis], label: String(value)})),
  }));
  const points = groups.map(({position, vertices}) => ({
    position: centered(position),
    label: vertices.length === 2 ? vertices.map(vertexLabel).join('/')
      : vertexLabel(vertices[0]) + (vertices.length > 2 ? ` +${vertices.length - 1}` : ''),
    title: vertices.map(index => vertexTooltip(result, result.vertices[index], index)).join('\n\n'),
  }));
  const face = hull.map(centered);
  const fullPotentials = hull.map(position => result.vertices[groups[positions.indexOf(position)].vertices[0]].delta_mu_ev_per_atom);
  return { groups, groupByVertex, elements, order,
    positionOf: values => centered(axes.map(axis => values[axis])),
    pickSurface: face.length >= 3,
    potentialsAt: position => interpolateCpdFace(position, face, fullPotentials),
    domain: result.elements.map((_, axis) => bounds[axes.indexOf(axis)]),
    grid, points, faces: face.length >= 3 ? [face] : [],
    faceStyles: [{color: 0x8ebce4, opacity: 1, normal, edgeColor: 0x185b94, target: true}],
    radius: Math.hypot(...bounds.map(([lo, hi]) => hi - lo)) / 2,
    selected: groupByVertex[activeVertex ?? 0],
  };
}

function syncCpdProjectionVertex(index, selectVertex) {
  const controls = $('defects-cpd-projection-vertices');
  const group = cpdProjection?.groupByVertex[index];
  if (index !== null && !$('defects-cpd-3d').hidden) cpdViewer?.select(group ?? index, 0);
  const vertices = cpdProjection?.groups[group]?.vertices;
  controls.hidden = !vertices || vertices.length < 2;
  if (controls.hidden) {
    controls.replaceChildren();
    return;
  }
  if (controls.dataset.group !== String(group) || !controls.childElementCount) {
    const title = document.createElement('span');
    title.textContent = 'Vertices at this point';
    controls.replaceChildren(title, ...vertices.map(vertex => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.cpdVertex = vertex;
      button.textContent = vertexLabel(vertex);
      button.onclick = () => selectVertex(vertex);
      return button;
    }));
    controls.dataset.group = group;
  }
}

function showCpd3d(result, selectVertex, selectPoint, projection = null, hostAxes = true) {
  const section = $('defects-cpd-3d'), canvas = $('defects-cpd-canvas');
  section.hidden = false;
  const scene = projection ? buildCpdProjection(result, projection, hostAxes) : buildCpd3dScene(result);
  cpdProjection = projection ? scene : null;
  onCpd3dVertex = projection
    ? group => {
      const {vertices} = scene.groups[group];
      selectVertex(vertices.includes(activeVertex) ? activeVertex : vertices[0]);
    }
    : selectVertex;
  onCpd3dPick = position => {
    const values = scene.potentialsAt(position);
    if (values) selectPoint(values);
  };
  cpdViewer ||= globalThis.BrillouinZone.create(canvas,
    index => onCpd3dVertex?.(index), position => onCpd3dPick?.(position));
  cpdViewer.loadGeometry(scene);
  cpdViewer.fit();
  canvas.style.cursor = scene.pickSurface ? 'crosshair' : '';
  if (pickedCpdPotentials) cpdViewer.selectPosition(scene.positionOf(pickedCpdPotentials));
  cpdSelectionMarker = values => { if (values) cpdViewer.selectPosition(scene.positionOf(values)); };
  renderCpdRanges(result, scene.domain);
  const legend = $('defects-cpd-legend');
  legend.textContent = `Chemical potentials Δμ [${CPD_MU_UNIT}]`;
  if (projection) {
    const description = hostAxes ? 'host stability region' : 'dopant projection of finite vertices. Dopant Δμ has no lower bound.';
    legend.textContent = `${projection.join('–')} · ${description} · Δμ [${CPD_MU_UNIT}]`;
  }
  if (scene.pickSurface) legend.append(projection
    ? ' · Click the region to interpolate a reservoir. Where vertices share a host coordinate, interpolation uses the first listed vertex.'
    : ' · Click the target face to select a point.');
  for (const {row, color} of scene.visiblePhases || []) {
    const phase = phaseRecord(row.phase_id);
    if (!phase) continue;
    const item = document.createElement('span');
    const swatch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    swatch.setAttribute('width', '12');
    swatch.setAttribute('height', '10');
    swatch.setAttribute('aria-hidden', 'true');
    const fill = document.createElementNS(swatch.namespaceURI, 'rect');
    fill.setAttribute('width', '12');
    fill.setAttribute('height', '10');
    fill.setAttribute('fill', '#' + color.toString(16).padStart(6, '0'));
    swatch.append(fill);
    item.append(swatch, `${phaseFormula(phase)}${row.phase_id === result.target_phase_id ? ' (target)' : ''}`);
    legend.append(item);
  }
  for (const button of section.querySelectorAll('[data-cpd-axis]')) {
    const axis = Number(button.dataset.cpdAxis);
    button.textContent = (projection || result.elements)[axis];
    button.onclick = () => cpdViewer.axis(scene.order.indexOf(axis));
  }
  $('defects-cpd-fit').onclick = () => cpdViewer.fit();
  $('defects-cpd-zoom-in').onclick = () => cpdViewer.scaleZoom(1.25);
  $('defects-cpd-zoom-out').onclick = () => cpdViewer.scaleZoom(1 / 1.25);
  canvas.onkeydown = event => {
    if (!['Home', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') cpdViewer.fit();
    else if (result.vertices.length) selectVertex(Math.min(result.vertices.length - 1, Math.max(0, (activeVertex ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1))));
  };
}

function renderCpdPlot(result, selectVertex, selectPoint) {
  cpdSelectionMarker = null;
  const host = $('defects-cpd-plot'), legend = $('defects-cpd-legend');
  host.replaceChildren();
  legend.replaceChildren();
  $('defects-cpd-3d').hidden = true;
  renderCpdRanges(result, null);
  const axisSet = $('defects-cpd-axis-set');
  axisSet.parentElement.hidden = true;
  axisSet.onchange = null;
  if (result.elements.length > 3) {
    $('defects-cpd-rotation').hidden = true;
    const hostElements = result.elements.filter((_, axis) => result.target_atom_counts[axis] > 0);
    if (hostElements.length === 3 && result.vertices.length) {
      const formulaOrder = phaseFormula(targetPhase, false).match(/[A-Z][a-z]?/g) || [];
      const plotElements = [...new Set([...formulaOrder, ...hostElements])].filter(element => hostElements.includes(element));
      try {
        showCpd3d(result, selectVertex, selectPoint, plotElements);
        const dopantAxes = dopants.filter(element => result.elements.includes(element) && !hostElements.includes(element));
        if (dopantAxes.length === 3) {
          axisSet.replaceChildren(new Option(plotElements.join('–'), 'host'), new Option(dopantAxes.join('–'), 'dopants'));
          axisSet.parentElement.hidden = false;
          axisSet.onchange = () => {
            const hostAxes = axisSet.value === 'host';
            $('defects-cpd-projection-vertices').replaceChildren();
            showCpd3d(result, selectVertex, selectPoint, hostAxes ? plotElements : dopantAxes, hostAxes);
            if (activeVertex !== null) selectVertex(activeVertex);
          };
        }
        return;
      } catch (error) {
        cpdProjection = null;
        $('defects-cpd-3d').hidden = true;
      }
    }
    legend.textContent = result.vertices.length
      ? `Select a vertex below to inspect all ${result.elements.length} chemical potentials.`
      : 'The selected phase constraints give an empty chemical-potential region.';
    return;
  }
  if (result.elements.length === 3) {
    $('defects-cpd-rotation').hidden = true;
    try {
      showCpd3d(result, selectVertex, selectPoint);
      return;
    } catch (error) {
      $('defects-cpd-3d').hidden = true;
      legend.textContent = '3D view unavailable. Showing a projection of the target vertices.';
    }
  }
  const svgNode = (name, attrs = {}, text = '') => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    if (text) node.textContent = text;
    return node;
  };
  const binary = result.elements.length === 2;
  $('defects-cpd-rotation').hidden = result.elements.length < 2 || (!binary && !result.vertices.length);
  if (!result.vertices.length && !binary) return;
  const twoAxes = result.elements.length >= 2;
  const width = 448, height = twoAxes ? 360 : 145;
  let left = 70, right = 422, top = 24, bottom = height - 54;
  const svg = svgNode('svg', {viewBox: `0 0 ${width} ${height}`, class: 'defects-cpd-svg',
    role: 'group', 'aria-label': 'Chemical potential diagram. Select a vertex or click the stability region.'});
  const vertices = result.vertices.map(vertex => vertex.delta_mu_ev_per_atom);
  const count = result.target_atom_counts.reduce((sum, n) => sum + n, 0);
  const target = {composition_fraction: result.target_atom_counts.map(n => n / count),
    bound_ev_per_atom: result.target_formation_energy_ev_per_atom};
  const domain = binary
    ? cpdWindow(result, [...result.constraints, target], outer => binaryPhaseBoundaries(result, outer).flatMap(({ends}) => ends))
      .map(([low]) => [Math.floor(low / 0.5) * 0.5, 0])
    : result.elements.map((_, axis) => {
      const values = vertices.map(vertex => vertex[axis]);
      const min = Math.min(...values), max = Math.max(...values);
      const pad = Math.max(0.08 * (max - min), max === min ? 0.05 : 1e-6);
      return [min - pad, max + pad];
    });
  const axes = [[[0, 1], [1, 1]], [[1, 1], [0, -1]], [[0, -1], [1, -1]], [[1, -1], [0, 1]]][plotTurns];
  const [[xi, xs], [yi, ys]] = axes;
  const extent = (i, sign) => domain[i].map(value => sign * value).sort((a, b) => a - b);
  const [xmin, xmax] = extent(xi, xs), [ymin, ymax] = twoAxes ? extent(yi, ys) : [0, 1];
  if (binary) {
    const scale = Math.min((right - left) / (xmax - xmin), (bottom - top) / (ymax - ymin));
    const dx = (right - left - scale * (xmax - xmin)) / 2;
    const dy = (bottom - top - scale * (ymax - ymin)) / 2;
    left += dx; right -= dx; top += dy; bottom -= dy;
  }
  renderCpdRanges(result, domain);
  const x = value => left + (value - xmin) / (xmax - xmin) * (right - left);
  const y = value => bottom - (value - ymin) / (ymax - ymin) * (bottom - top);
  const project = value => [x(xs * value[xi]), twoAxes ? y(ys * value[yi]) : (top + bottom) / 2];
  const points = vertices.map(project);
  svg.append(svgNode('rect', {x: left, y: top, width: right-left, height: bottom-top, class: 'defects-cpd-plane'}));
  for (const value of axisTicks([xmin, xmax])) {
    const xx = x(value);
    svg.append(svgNode('line', {x1: xx, x2: xx, y1: top, y2: bottom, class: 'defects-cpd-grid'}));
    svg.append(svgNode('text', {x: xx, y: bottom + 17, class: 'defects-cpd-axis', 'text-anchor': 'middle'}, String(xs * value)));
  }
  if (twoAxes) for (const value of axisTicks([ymin, ymax])) {
    const yy = y(value);
    svg.append(svgNode('line', {x1: left, x2: right, y1: yy, y2: yy, class: 'defects-cpd-grid'}));
    svg.append(svgNode('text', {x: left - 6, y: yy + 4, class: 'defects-cpd-axis', 'text-anchor': 'end'}, String(ys * value)));
  }
  function axisTitle(attrs, element) {
    const title = svgNode('text', {...attrs, class: 'defects-cpd-axis', 'text-anchor': 'middle'}, 'Δμ');
    title.append(svgNode('tspan', {dy: 3, 'font-size': '75%'}, element),
      svgNode('tspan', {dy: -3}, ` [${CPD_MU_UNIT}]`));
    svg.append(title);
  }
  axisTitle({x: (left + right) / 2, y: height - 10}, result.elements[xi]);
  if (twoAxes) axisTitle({transform: `translate(16 ${(top + bottom) / 2}) rotate(-90)`}, result.elements[yi]);
  if (binary) {
    const boundaries = binaryPhaseBoundaries(result, domain).filter(segment => segment.row.phase_id !== result.target_phase_id);
    for (const {row, ends} of boundaries) {
      const color = `#${phaseColor(row).toString(16)}`, phase = phaseRecord(row.phase_id);
      const name = phase ? `${phaseFormula(phase)} · ${phase.source.recordId}` : row.constraint_id;
      const [[x1, y1], [x2, y2]] = ends.map(project);
      const line = svgNode('line', {x1, y1, x2, y2, stroke: color, 'stroke-width': 2});
      line.append(svgNode('title', {}, name));
      svg.append(line);
      const item = document.createElement('span');
      const swatch = svgNode('svg', {width: 18, height: 8, 'aria-hidden': 'true'});
      swatch.append(svgNode('line', {x1: 0, y1: 4, x2: 18, y2: 4, stroke: color, 'stroke-width': 2}));
      item.append(swatch, name);
      legend.append(item);
    }
  } else if (result.elements.length === 3) {
    legend.append(` Target stability region projected onto ${result.elements[xi]}–${result.elements[yi]}. Select a vertex to see all three chemical potentials.`);
  }
  if (points.length > 1) {
    const center = [0, 1].map(axis => points.reduce((sum, point) => sum + point[axis], 0) / points.length);
    const area = !binary && result.dimension === 2;
    const ordered = points.slice().sort(area ? (a, b) => Math.atan2(a[1] - center[1], a[0] - center[0]) - Math.atan2(b[1] - center[1], b[0] - center[0])
      : (a, b) => a[0] - b[0] || a[1] - b[1]);
    const geometry = ordered.map(point => point.join(',')).join(' ');
    svg.append(svgNode(area ? 'polygon' : 'polyline', {points: geometry, class: area ? 'defects-cpd-region' : 'defects-cpd-region defects-cpd-edge'}));
    const hit = svgNode(area ? 'polygon' : 'polyline', {points: geometry, class: area ? 'defects-cpd-hit' : 'defects-cpd-hit defects-cpd-hit-edge'});
    const corresponding = ordered.map(point => vertices[points.indexOf(point)]);
    hit.onclick = event => {
      const click = svg.createSVGPoint();
      click.x = event.clientX;
      click.y = event.clientY;
      const pixel = click.matrixTransform(svg.getScreenCTM().inverse());
      if (area) {
        const values = interpolateCpdFace([pixel.x, pixel.y], ordered, corresponding);
        if (values) selectPoint(values);
        return;
      }
      const [a, b] = [ordered[0], ordered.at(-1)];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((pixel.x - a[0]) * dx + (pixel.y - a[1]) * dy) / (dx * dx + dy * dy)));
      if (Number.isFinite(t)) selectPoint(corresponding[0].map((value, axis) => value + t * (corresponding.at(-1)[axis] - value)));
    };
    svg.append(hit);
    if (binary) legend.prepend('Click the target line to select a point. ');
  }
  const pickedMarker = svgNode('circle', {r: 6, class: 'defects-cpd-picked-point', 'aria-hidden': 'true', display: 'none'});
  svg.append(pickedMarker);
  cpdSelectionMarker = values => {
    pickedMarker.setAttribute('display', values ? 'inline' : 'none');
    if (values) {
      const [px, py] = project(values);
      pickedMarker.setAttribute('cx', px);
      pickedMarker.setAttribute('cy', py);
    }
  };
  cpdSelectionMarker(pickedCpdPotentials);
  points.forEach(([px, py], index) => {
    const label = vertexLabel(index);
    const marker = svgNode('g', {class: 'defects-cpd-point', role: 'button', tabindex: 0,
      'data-cpd-vertex': index, 'aria-label': `Vertex ${label}`, 'aria-pressed': 'false'});
    marker.append(svgNode('title', {}, vertexTooltip(result, result.vertices[index], index)), svgNode('circle', {cx: px, cy: py, r: 13, fill: 'transparent'}),
      svgNode('circle', {cx: px, cy: py, r: 7, class: 'defects-cpd-marker'}),
      svgNode('text', {x: px, y: py - 13, class: 'defects-cpd-letter', 'text-anchor': 'middle'}, label));
    marker.setAttribute('aria-pressed', String(activeVertex === index));
    marker.addEventListener('click', () => selectVertex(index));
    marker.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectVertex(index);
      }
    });
    svg.append(marker);
  });
  host.append(svg);
}

function potentialLabel(element, symbol = 'Δμ') {
  const label = document.createElement('span');
  label.className = 'cpd-potential';
  const sub = document.createElement('sub');
  sub.textContent = element;
  label.append(symbol, sub);
  return label;
}

function renderPotentialReadout(host, prefix, elements, values, format) {
  host.textContent = prefix;
  elements.forEach((element, axis) => {
    host.append(' · ', potentialLabel(element), ` = ${format(values[axis])} eV/atom`);
  });
}

function findLowerPolymorph(result) {
  const total = result.target_atom_counts.reduce((sum, count) => sum + count, 0);
  let best = null;
  for (const row of result.constraints) {
    const count = row.original_atom_counts.reduce((sum, n) => sum + n, 0);
    const sameComposition = row.original_atom_counts.every((n, axis) => n * total === result.target_atom_counts[axis] * count);
    const difference = result.target_formation_energy_ev_per_atom - row.bound_ev_per_atom;
    if (!sameComposition || difference <= result.diagnostics.numerical_tolerance_ev_per_atom) continue;
    if (!best || difference > best.difference) best = {phase: phaseRecord(row.phase_id), difference};
  }
  return best?.phase ? best : null;
}

async function useCpdPolymorph(phase) {
  const cached = relaxedPhasesByEnergySet.get(energySet)?.get(phase.phaseId);
  if (!cached && !importedBundle) throw new Error('The saved phase data is unavailable. Select this structure in Setup and relax it.');
  targetPhase = phase;
  sourceTargetText = null;
  sourceTargetFormat = 'poscar';
  setupRelaxation = relaxedHost = null;
  if (cached) {
    const {model, geometry, initialGeometrySha256, finalGeometrySha256, relaxSettings} = cached;
    setupRelaxation = {target: phase, model, settings: relaxSettings, result: {...cached, ...cached.convergence},
      initialHash: initialGeometrySha256, finalHash: finalGeometrySha256};
    relaxedHost = {phaseId: phase.phaseId, modelKey: model.modelKey, hash: finalGeometrySha256, geometry};
  }
  setStatus('defects-active-target', `${phaseFormula(phase)} · ${phase.source.recordId} · ${phase.structure.atoms.length} atoms`);
  setStatus('defects-target-status', `Selected ${phaseFormula(phase)} · ${phase.source.recordId}.`);
  setStatus('defects-target-relax-status', 'Reusing the converged phase energy from this CPD.');
  lastEnergySummary = null;
  renderPhaseList();
  renderSetup();
  if (cached) {
    targetFrame = 'relaxed';
    showTargetStructure();
  }
  await calculateCpd();
}

function renderUnavailableCpd(result) {
  $('defects-cpd-explorer').hidden = true;
  $('defects-cpd-unavailable').hidden = false;
  const button = $('defects-cpd-use-polymorph');
  const lower = findLowerPolymorph(result);
  const reason = $('defects-cpd-unavailable-reason');
  button.hidden = true;
  button.onclick = null;
  if (!lower) {
    reason.textContent = 'The target chemical potentials cannot satisfy all of the calculated competing-phase constraints. Review the phases and model used for this CPD.';
    return;
  }
  const {phase, difference} = lower;
  const label = `${phaseFormula(phase)} · ${phase.source.recordId}`;
  reason.textContent = `${label} has the same composition and is ${(difference * 1000).toPrecision(4)} meV/atom lower with this model. The selected target therefore has no stable chemical-potential vertices.`;
  if (!relaxedPhasesByEnergySet.get(energySet)?.has(phase.phaseId) && !importedBundle) return;
  button.textContent = `Use ${label} and rerun CPD`;
  button.hidden = false;
  button.onclick = () => performAction('defects-run-status', () => useCpdPolymorph(phase));
}

function correctionLabel(result) {
  return result?.stabilization ? 'ABOVE HULL · CORRECTED CPD' : result?.status?.toUpperCase();
}

function renderStabilizationCaution() {
  for (const [id, anchor] of [
    ['defects-cpd-caution', 'defects-result-summary'],
    ['defects-neutral-caution', 'defects-reservoir-summary'],
    ['defects-energy-caution', 'defects-vacancy-results'],
  ]) {
    let node = $(id);
    if (!node) {
      node = document.createElement('p');
      node.id = id;
      node.setAttribute('role', 'status');
      node.style.cssText = 'padding:10px;border:1px solid #bd872c;border-radius:6px;background:#fff6dd;color:#684510;';
      $(anchor).before(node);
    }
    const info = cpdResult?.stabilization;
    node.hidden = !info;
    node.textContent = info ? `Caution · Target above hull by ${(info.above_hull_ev_per_atom * 1000).toFixed(4)} meV/atom with ${cpdResult.model.model_id}. CPD target shift ${(info.signed_change_ev_per_atom * 1000).toFixed(4)} meV/atom includes a ${(info.buffer_ev_per_atom * 1000).toFixed(4)} meV/atom buffer. Defect formation energies use these corrected chemical potentials. Hull refers to the calculated selected phases.` : '';
  }
}

function renderCpdResult() {
  renderStabilizationCaution();
  const result = cpdResult, host = $('defects-vertices');
  host.replaceChildren();
  $('defects-results').hidden = false;
  $('defects-cpd-readout').hidden = true;
  $('defects-result-summary').textContent = `${result.elements.join('–')} · ${phaseRecord(result.target_phase_id)?.source.recordId || result.target_phase_id} · target ΔHf ${result.target_formation_energy_ev_per_atom.toFixed(8)} eV/atom · ${correctionLabel(result)} · model ${result.model.model_id} · zero pressure`;
  if (!result.vertices.length) {
    renderUnavailableCpd(result);
    return;
  }
  const unbounded = result.unbounded_below_elements || [];
  const targetLabel = `Target: ${phaseFormula(targetPhase)}`;
  const elementalOnly = dopants.filter(dopant => !result.input_phase_energies.some(phase => {
    const counts = phase.atom_counts;
    return counts[result.elements.indexOf(dopant)] && counts.filter(count => count > 0).length > 1;
  }));
  const notes = [targetLabel];
  if (unbounded.length) notes.push(`No lower Δμ bound for ${unbounded.join(', ')}. The listed vertices are finite endpoints.`);
  if (unbounded.length && result.elements.length === 3) notes.push('Plot limits only frame the view.');
  if (elementalOnly.length) notes.push(`Dopants with elemental constraints only: ${elementalOnly.join(', ')}.`);
  $('defects-cpd-target').textContent = notes.join(' ');
  const constraints = new Map(result.constraints.map(row => [row.constraint_id, row]));
  function selectVertex(index) {
    pickedCpdPotentials = null;
    selectReservoir(index);
  }
  function selectPoint(values) {
    pickedCpdPotentials = values;
    selectReservoir(null);
  }
  function selectReservoir(index) {
    activeVertex = index;
    cpdSelectionMarker?.(pickedCpdPotentials);
    syncCpdProjectionVertex(index, selectVertex);
    const vertex = result.vertices[index];
    const readout = $('defects-cpd-readout');
    const values = currentCpdPotentials();
    renderPotentialReadout(readout, currentCpdLabel(), result.elements, values, formatDelta);
    readout.hidden = false;
    for (const item of $('defects-cpd-explorer').querySelectorAll('[data-cpd-vertex]')) item.setAttribute('aria-pressed', String(index !== null && Number(item.dataset.cpdVertex) === index));
    const active = vertex?.active_constraint_ids.map(id => {
      const phase = phaseRecord(constraints.get(id)?.phase_id);
      return phase ? `${phaseFormula(phase)} (${phase.source.recordId})` : id;
    });
    const detail = $('defects-vertex-detail');
    detail.textContent = currentCpdLabel();
    result.elements.forEach((element, axis) => {
      const delta = values[axis];
      const mu = result.references_mu0_ev_per_atom[axis] + delta;
      detail.append('\n', potentialLabel(element), ` = ${delta.toPrecision(12)} eV/atom · `,
        potentialLabel(element, 'μ'), ` = ${mu.toPrecision(12)} eV/atom`);
    });
    if (vertex) detail.append(`\nActive constraints: ${active.join(', ') || 'none'}\n`,
      `Target residual: ${vertex.target_residual_ev_per_atom} eV/atom\n`,
      `Maximum inequality violation: ${vertex.max_inequality_violation_ev_per_atom} eV/atom`);
    renderDefectReservoir();
    if (matchMedia('(max-width: 720px)').matches) $('defects-vacancy-chart').scrollTop = 0;
    syncButtons();
  }
  const draw = () => renderCpdPlot(result, selectVertex, selectPoint);
  for (const [id, direction] of [['defects-cpd-rotate-cw', 1], ['defects-cpd-rotate-ccw', -1]]) {
    $(id).onclick = () => {
      plotTurns = (plotTurns + direction + 4) % 4;
      draw();
    };
  }
  draw();
  for (const [index, vertex] of result.vertices.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cpdVertex = index;
    button.textContent = `Vertex ${vertexLabel(index)} · ${result.elements.map((element, axis) => `${element} ${formatDelta(vertex.delta_mu_ev_per_atom[axis])}`).join(' · ')} eV/atom`;
    button.addEventListener('click', () => selectVertex(index));
    host.append(button);

  }
  selectVertex(0);
  syncButtons();
}

function renderDefectReservoir() {
  const values = currentCpdPotentials();
  if (!values) return;
  renderPotentialReadout($('defects-reservoir-summary'),
    `${phaseFormula(targetPhase)} · ${currentCpdLabel()}`,
    cpdResult.elements, values, value => value.toPrecision(8));
  renderVacancyEnergy();
}

async function prepareDefectPreview() {
  await previewCalculationSupercell();
  if (draftSupercell?.relaxedHostVerified) await generateVacancyPreview();
}

async function runSelected(resume = false) {
  if (!dataset || !setupReady()) throw new Error('Relax the target and load its competing phases first.');
  if (!supportsCpd(dataset.chemicalSystem.length)) throw new Error(cpdAvailability(dataset.chemicalSystem.length));
  if (targetPhase && !selectedPhaseIds().has(targetPhase.phaseId)) throw new Error('The selected phases must include the chosen target.');
  const chosen = selectedPhaseIds();
  if (!chosen.size || chosen.size > MAX_PHASES) throw new Error(`Select between 1 and ${MAX_PHASES} phases for this browser run.`);
  const phases = dataset.phases.filter(phase => chosen.has(phase.phaseId));
  if (energySet && chosen.size && phases.every(phase => energyEntry(phase.phaseId))) { await calculateCpd(); return; }
  const model = selectedModel(); if (!model) throw new Error('Select a model.');
  if (energySet && (energySet.model.modelId !== model.model_id || energySet.model.weightsSha256 !== model.weights_sha256)) throw new Error('The imported phase energies were produced by another model. Select that exact model in the catalog or import a matching energy bundle; mixed-model energies are not allowed.');
  const unsupported = [...new Set(phases.flatMap(phase => phase.structure.atoms.map(atom => atom.element)))].filter(element => !model.supported_atomic_symbols.includes(element));
  if (unsupported.length) throw new Error(`${model.display_name} does not support ${unsupported.join(', ')}. No model calculations were started.`);
  const geometries = phases.map(phaseToGeometry);
  if (geometries.some(geometry => geometry.atomic_numbers.some(number => !Number.isSafeInteger(number)))) throw new Error('One or more element symbols have no atomic-number mapping.');
  const datasetSha256 = await Contract.sha256({ dataset, structures: geometries });
  const modelRef = modelIdentity(model);
  const settings = cpdRelaxSettings;
  const tasks = phases.map((phase, index) => ({ taskId: `cpd-${phase.source.recordId}`, type: 'phase-relax', phaseId: phase.phaseId, structure: geometries[index], settings }));
  const plan = { projectId: `thermo-cpd-${datasetSha256.slice(0, 16)}-${model.model_key.slice(0, 12)}`, datasetSha256, model: modelRef, tasks };
  queueStore = Project.createIndexedDbStore();
  const saved = resume ? await queueStore.load(plan.projectId) : null;
  let project;
  if (saved) {
    const valid = await Project.verifyTaskIdentities(saved);
    const planned = await Project.createProject(plan);
    if (valid.datasetSha256 !== plan.datasetSha256 || valid.model.modelKey !== plan.model.modelKey || valid.tasks.length !== planned.tasks.length || valid.tasks.some(task => !planned.tasks.some(candidate => candidate.taskId === task.taskId && candidate.taskKey === task.taskKey))) throw new Error('Saved calculation identity differs from the current data/model/selected phases; it was not resumed.');
    project = valid;
  } else project = await Project.createProject(plan);
  await reuseSetupTarget(project);
  const runner = makeRunner(model); queue = new Queue({ project, runner, store: queueStore, onProgress: async event => {
    if (event.type === 'task-start') setStatus('defects-run-status', `Loading ${model.display_name}; starting ${event.task.phaseId}…`);
    else if (event.type === 'task-completed') setStatus('defects-run-status', `${event.project.metrics.completed}/${event.project.tasks.length} phase energies committed · ${event.project.metrics.forceStressEvaluations} force/stress evaluations · ${event.project.metrics.elapsedSeconds.toFixed(2)} s`);
    else if (['failed', 'cancelled', 'max_steps'].includes(event.type)) setStatus('defects-run-status', `${event.type.toUpperCase()} · ${event.task.phaseId} · saved partial project can be resumed.`, event.type === 'failed' ? 'error' : 'warning');
  } });
  $('defects-search').disabled = true; $('defects-calculate').disabled = true; $('defects-stop').disabled = false; $('defects-resume').disabled = true;
  try {
    const finished = await queue.run();
    energySet = await buildEnergySet(finished, model);
    relaxedPhasesByEnergySet.set(energySet, new Map(finished.tasks
      .filter(task => task.status === 'completed').map(task => [task.phaseId, task.result])));
    const target = finished.tasks.find(task => task.phaseId === targetPhase.phaseId && task.status === 'completed');
    if (target) relaxedHost = {phaseId: target.phaseId, hash: target.result.finalGeometrySha256,
      modelKey: model.model_key, geometry: target.result.geometry};
    renderPhaseList();
    showTargetStructure();
    lastEnergySummary = { completed: finished.metrics.completed, evaluations: finished.metrics.forceStressEvaluations, elapsedSeconds: finished.metrics.elapsedSeconds, reused: finished.metrics.reused };
    if (finished.state !== 'completed') {
      setStatus('defects-run-status', `Calculation ${finished.state} · ${finished.metrics.completed}/${finished.tasks.length} converged phases · ${finished.metrics.forceStressEvaluations} force/stress evaluations · ${finished.metrics.elapsedSeconds.toFixed(2)} s. Use Resume saved calculation to continue.`, 'warning'); return;
    }
    setStatus('defects-run-status', `All ${finished.metrics.completed} phase energies saved · ${finished.metrics.forceStressEvaluations} force/stress evaluations · ${finished.metrics.elapsedSeconds.toFixed(2)} s · ${model.model_id}. Calculating CPD…`);
    await calculateCpd();
  } finally { $('defects-stop').disabled = true; $('defects-search').disabled = false; queue = null; syncButtons(); }
}

function download(name, text, type) { const url = URL.createObjectURL(new Blob([text], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function exportTargetVertices() {
  const result = cpdResult;
  if (!result?.vertices.length) return;
  const constraints = new Map(result.constraints.map(row => [row.constraint_id, row]));
  const yaml = {target: phaseFormula(phaseRecord(result.target_phase_id), false)};
  for (const [index, vertex] of result.vertices.entries()) {
    const chemPot = Object.fromEntries(result.elements.map((element, axis) => {
      const value = vertex.delta_mu_ev_per_atom[axis];
      if (!Number.isFinite(value)) throw new Error(`Invalid chemical potential for vertex ${vertexLabel(index)} (${element}).`);
      return [element, value];
    }));
    const competing = [], impurity = [];
    for (const id of vertex.active_constraint_ids) {
      const phase = phaseRecord(constraints.get(id)?.phase_id);
      if (!phase) throw new Error(`Missing competing phase for constraint ${id}.`);
      (phase.structure.atoms.some(atom => dopants.includes(atom.element)) ? impurity : competing).push(phaseFormula(phase, false));
    }
    yaml[vertexLabel(index)] = {
      // pydefect's chem_pot field stores shifts relative to elemental references.
      chem_pot: chemPot,
      competing_phases: [...new Set(competing)],
      impurity_phases: [...new Set(impurity)],
    };
  }
  const caution = result.stabilization ? '# Caution: above-hull target; corrected reservoirs.\n# stabilization: ' + JSON.stringify(result.stabilization) + '\n' : '';
  const header = caution + `# chem_pot contains Δμ [${CPD_MU_UNIT}], relative to the elemental energies used in this CPD.\n`;
  download('target_vertices.yaml', header + globalThis.jsyaml.dump(yaml, {noRefs: true}), 'text/yaml');
}

async function exportBundle() {
  if (!dataset || !energySet) throw new Error('There is no phase energy set to export.');
  referencesForCurrentEnergies();
  const refs = referenceSet;
  const chosen = selectedPhaseIds();
  const selectedEnergies = {...energySet, entries: energySet.entries.filter(entry => chosen.has(entry.phaseId))};
  const bundle = { schema: 'macer-thermo-defect-bundle-v1', schemaVersion: 1, ...(dopants.length ? {dopants} : {}), phaseDataset: dataset, phaseEnergySet: selectedEnergies, elementReferenceSet: refs, targetPhaseId: targetPhase.phaseId };
  if (cpdResult) bundle.cpdResult = { schema: Contract.SCHEMAS.cpd, schemaVersion: 1, targetPhaseId: cpdResult.target_phase_id,
    targetFormula: phaseFormula(phaseRecord(cpdResult.target_phase_id), false), elements: cpdResult.elements.slice(), status: cpdResult.status,
    stabilization: clone(cpdResult.stabilization || null), targetFormationEnergyEvPerAtom: cpdResult.target_formation_energy_ev_per_atom, model: clone(cpdResult.model), pressureGpa: 0,
    phaseDatasetSha256: await Contract.sha256(dataset), phaseEnergySetSha256: await Contract.sha256(selectedEnergies), elementReferenceSetSha256: await Contract.sha256(refs), constraints: cpdResult.constraints, vertices: cpdResult.vertices, facets: cpdResult.facets, unboundedBelowElements: cpdResult.unbounded_below_elements || [], missingRows: cpdResult.missing_rows || [] };
  const checked = Contract.validateBundle(bundle);
  download('macer-thermo-defect-bundle.json', JSON.stringify(checked, null, 2), 'application/json');
}

async function phaseImport(file) {
  if (!file) return;
  const raw = await file.text();
    const staged = await Contract.importBundle({}, raw);
    // No active state is replaced until all phase, energy, reference and identity checks pass.
    setupRelaxation = relaxedHost = null;
    sourceTargetText = null;
    sourceTargetFormat = 'poscar';
    clearCpdPresentation(); importedBundle = staged.thermoDefectBundle; dataset = importedBundle.phaseDataset; energySet = importedBundle.phaseEnergySet; referenceSet = importedBundle.elementReferenceSet; lastEnergySummary = null;
    const legacy = $('defects-legacy-target');
    targetPhase = phaseRecord(importedTargetId(importedBundle)) || null;
    dopants = importedBundle.dopants ?? (importedBundle.dopant ? [importedBundle.dopant] : []);
    const eligible = dataset.phases.filter(phase => Contract.isChemicalSystemCompound(phase, dataset.chemicalSystem));
    legacy.replaceChildren(new Option('Choose a target', ''), ...eligible.map(phase => new Option(`${phaseFormula(phase)} · ${phase.source.recordId}`, phase.phaseId)));
    $('defects-legacy-target-wrap').hidden = !!targetPhase;
    setStatus('defects-active-target', targetPhase ? `${phaseFormula(targetPhase)} · ${targetPhase.source.recordId} · imported target` : 'Choose the target for this imported project.');
    setStatus('defects-target-relax-status', 'Use the saved target energy or relax the target to start a fresh phase search.');
    $('defects-cutoff').value = dataset.hullCutoff.value;
    collection = null; renderPhaseList();
    for (const input of $('defects-phase-browser').querySelectorAll('input[data-phase]')) input.checked = input.dataset.aboveLimit !== 'true' && (input.dataset.phase === targetPhase?.phaseId || !!energyEntry(input.dataset.phase));
    const missing = dataset.chemicalSystem.filter(element => !energySet.entries.some(entry => entry.status === 'converged' && phaseRecord(entry.phaseId)?.structure.atoms.every(atom => atom.element === element)));
    const unsupported = dataset.chemicalSystem.filter(element => !selectedModel()?.supported_atomic_symbols?.includes(element));
    setStatus('defects-source-status', `Imported validated ${dataset.providerSnapshot.provider} phase/energy bundle · ${dataset.phases.length} phases · model ${energySet.model.modelId} · ${dataset.providerSnapshot.complete ? 'complete' : 'partial'} dataset.`, dataset.providerSnapshot.complete ? 'info' : 'warning');
    if (missing.length || unsupported.length) {
      const notes = [];
      if (unsupported.length) notes.push(`${selectedModel()?.display_name || 'Selected model'} cannot calculate ${unsupported.join(', ')}; imported energies, if present, retain their recorded model identity.`);
      if (missing.length) notes.push(`Missing unary energy/reference for ${missing.join(', ')}. CPD needs a converged elemental phase for each system element.`);
      setStatus('defects-run-status', notes.join(' '), 'warning');
    }
    else setStatus('defects-run-status', 'Project loaded. Calculate CPD to reuse the saved phase energies.', 'info');
    renderSetup(); syncButtons();

}

async function useAlexandriaTarget(item) {
  const id = item.id;
  setStatus('defects-target-status', `Applying ${globalThis.StructureSearch.displayFormula(item.chemical_formula_reduced)} · ${id}…`);
  const {structure, provenance} = await globalThis.StructureSearch.getStructure(id);
  await setTarget(structure, {
    provider: 'Alexandria', formula: item.chemical_formula_reduced, recordId: provenance.id, license: provenance.license, recordUrl: provenance.url, databaseSpaceGroup: provenance.databaseSpaceGroup ?? null,
  });
  setStatus('defects-target-status', `Selected ${phaseFormula(targetPhase)} · ${id}.`);
  const setup = $('defects-target-setup');
  if (setup.getBoundingClientRect().bottom > window.innerHeight) {
    setup.scrollIntoView({block: 'nearest'});
  }
}
async function useTargetExample(name) {
  const example = globalThis.StructureExamples[name];
  if (targetPhase?.source.provider === 'Built-in example' && targetPhase.source.recordId === example.id && !pendingTargetEdits()) return;
  const source = {provider: 'Built-in example', recordId: example.id,
    license: example.source ? 'CC BY 4.0' : 'MIT',
    ...(example.source ? {recordUrl: example.source} : {})};
  await setTarget(globalThis.Structures.parse(example.poscar, 'poscar'), source, example.poscar);
  clearTargetMatches();
  setStatus('defects-target-status', 'Example loaded.');
}

for (const button of document.querySelectorAll('[data-defects-example]')) {
  button.addEventListener('click', () => performAction('defects-target-editor-status', () => useTargetExample(button.dataset.defectsExample)));
}

async function applyTargetText() {
  clearTimeout(targetEditTimer);
  if (!pendingTargetEdits()) return;
  if (actionPending) { targetEditTimer = setTimeout(applyTargetText, 250); return; }
  const editor = $('defects-target-poscar'), format = $('defects-target-format').value;
  await performAction('defects-target-editor-status', async () => {
    try {
      if (new TextEncoder().encode(editor.value).length > 2 * 1024 * 1024) throw new Error('Use a structure up to 2 MiB.');
      await setTarget(globalThis.Structures.parse(editor.value, format), {
        provider: 'Local input', recordId: `${format.toUpperCase()} input`, license: 'user-provided',
      }, editor.value, format);
      clearTargetMatches();
      setStatus('defects-target-status', `Loaded ${phaseFormula(targetPhase)} from ${format.toUpperCase()} input.`);
      setStatus('defects-target-editor-status', 'Structure applied to the viewer.');
    } catch (error) {
      editor.setAttribute('aria-invalid', 'true');
      setStatus('defects-target-editor-status', `${error.message} The viewer shows the last valid structure.`, 'error');
    }
  });
}

function queueTargetText() {
  clearTimeout(targetEditTimer);
  $('defects-target-poscar').removeAttribute('aria-invalid');
  setStatus('defects-target-editor-status', pendingTargetEdits() ? 'Validating structure…' : '');
  syncButtons();
  if (pendingTargetEdits()) targetEditTimer = setTimeout(applyTargetText, 250);
}

$('defects-target-poscar').addEventListener('input', queueTargetText);
$('defects-target-format').addEventListener('change', () => {
  if (pendingTargetEdits()) { queueTargetText(); return; }
  const structure = targetPhase ? geometryForViewer(phaseToGeometry(targetPhase)) : null;
  const format = $('defects-target-format').value;
  showTargetInput(structure, format === sourceTargetFormat ? sourceTargetText : null);
  syncTargetEditorFrame();
  syncButtons();
});
$('defects-apply-poscar').addEventListener('click', applyTargetText);
$('defects-copy-relaxed-poscar').addEventListener('click', async () => {
  const geometry = currentRelaxedTargetGeometry();
  if (!geometry) return;
  const text = globalThis.Structures.toPoscar(geometryForViewer(geometry), 'Relaxed defects target');
  try {
    await navigator.clipboard.writeText(text);
    setStatus('defects-target-editor-status', 'Relaxed POSCAR copied.');
  } catch {
    targetFrame = 'relaxed';
    $('defects-target-format').value = 'poscar';
    showTargetInput(geometryForViewer(phaseToGeometry(targetPhase)), sourceTargetFormat === 'poscar' ? sourceTargetText : null);
    showTargetStructure();
    $('defects-relaxed-poscar').focus();
    $('defects-relaxed-poscar').select();
    setStatus('defects-target-editor-status', 'Relaxed POSCAR selected. Copy it with the browser copy command.');
  }
});
$('defects-relax-target').addEventListener('click', async () => {
  await performAction('defects-target-relax-status', async () => {
    relaxingSetupTarget = true;
    syncSetupSummary(false);
    try { await relaxSetupTarget(); }
    finally { relaxingSetupTarget = false; }
  });
  if (!$('defects-search-from-setup').disabled) $('defects-search-from-setup').focus();
});
$('defects-target-file').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  performAction('defects-target-status', async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error('Use a target structure file up to 2 MiB.');
    const raw = await file.text();
    const format = /\.cif$/i.test(file.name) || /^\s*data_/im.test(raw) ? 'cif' : 'poscar';
    await setTarget(globalThis.Structures.parse(raw, format), {provider: 'Local file', recordId: file.name, license: 'user-provided'}, raw, format);
    clearTargetMatches();
    setStatus('defects-target-status', 'Target loaded from a local file.');
  });
});
function relaxationHandoffMismatch(handoff, model) {
  if (!model || canonical(handoff.model) !== canonical(modelIdentity(model))) return 'The selected Defects model differs.';
  const requested = cpdRelaxSettings;
  const {settings, input, result} = handoff;
  if (settings.preserveSymmetry || !['positions', 'shape', 'volume'].every(key => settings.dof[key]) ||
      input.atoms.some(atom => atom.mask && !atom.mask.every(Boolean))) {
    return 'Defects requires an unconstrained relaxation of the atoms, cell shape and volume.';
  }
  if (settings.pressure !== 0 || settings.optimizer !== requested.optimizer ||
      settings.forceTolerance !== requested.forceToleranceEvA || settings.stressTolerance !== requested.stressToleranceGpa ||
      settings.maxSteps !== requested.maxSteps) {
    return 'Defects uses zero pressure, L-BFGS, 500 maximum steps, 0.01 eV/Å force tolerance and 0.1 GPa stress tolerance.';
  }
  if (result.status !== 'converged' || !Number.isFinite(result.totalEnergyEv) ||
      !Number.isFinite(result.maxForceEvA) || result.maxForceEvA > requested.forceToleranceEvA ||
      !Number.isFinite(result.maxStressResidualGpa) || result.maxStressResidualGpa > requested.stressToleranceGpa) {
    return 'The final energy, forces or stress did not pass the Defects convergence checks.';
  }
  return '';
}

$('defects-copy-target').addEventListener('click', () => performAction('defects-target-status', async () => {
  const source = globalThis.MacerRelax, handoff = source.convergedRelaxation?.();
  const relaxed = handoff?.finalStructure ?? source.convergedStructure?.();
  const recordId = relaxed ? 'Converged structure' : 'Current input';
  const model = selectedModel();
  const mismatch = handoff ? relaxationHandoffMismatch(handoff, model) : '';
  const reusable = handoff && !mismatch;
  await setTarget(reusable ? handoff.input : relaxed || source.inputStructure(), {
    provider: 'Structure & Relax', recordId, license: 'user-provided',
  });
  clearTargetMatches();
  setStatus('defects-target-status', `${recordId} copied from Structure & Relax.`);
  if (!reusable) {
    if (mismatch) setStatus('defects-target-relax-status', `${mismatch} Run target relax to continue.`, 'warning');
    return;
  }
  const result = requireConverged(handoff.result, phaseToGeometry(targetPhase), cpdRelaxSettings, 'Structure & Relax result');
  setupRelaxation = {target: targetPhase, model: modelIdentity(model), settings: cpdRelaxSettings, result,
    initialHash: await Project.hash(phaseToGeometry(targetPhase)), finalHash: await Project.hash(result.geometry)};
  relaxedHost = {phaseId: targetPhase.phaseId, modelKey: model.model_key, hash: setupRelaxation.finalHash, geometry: result.geometry};
  targetFrame = 'relaxed';
  showTargetStructure();
  setStatus('defects-target-relax-status', 'Reused converged energy and geometry from Structure & Relax. Ready to find competing phases.');
}));
const targetSearch = globalThis.StructureSearch;
let targetSearchPage = null;
const matchField = $('defects-target-match');
for (const [value, entry] of Object.entries(targetSearch.matchModes)) matchField.add(new Option(entry.label, value));

function clearTargetMatches() {
  targetSearchPage = null;
  $('defects-target-matches').replaceChildren();
  $('defects-target-results').hidden = true;
  $('defects-target-next').hidden = true;
}

function updateTargetMatch() {
  if (!Object.hasOwn(targetSearch.matchModes, matchField.value)) matchField.value = 'formula';
  const entry = targetSearch.matchModes[matchField.value];
  $('defects-target-query').placeholder = entry.placeholder;
  $('defects-target-search-guide').textContent = entry.text;
  clearTargetMatches();
}

async function findTargets(nextPage = false) {
  const request = nextPage ? targetSearchPage : {query: $('defects-target-query').value.trim(), mode: matchField.value, next: null};
  if (!request || (nextPage && request.next === null)) return;
  const page = await targetSearch.search(request.query, request.mode, request.next);
  const matches = $('defects-target-matches');
  matches.replaceChildren();
  for (const item of page.items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.dataset.structureId = item.id;
    button.textContent = targetSearch.resultLabel(item);
    button.addEventListener('click', () => performAction('defects-target-status', () => useAlexandriaTarget(item)));
    matches.append(button);
  }
  const results = $('defects-target-results');
  results.hidden = !page.items.length;
  results.open = true;
  $('defects-target-result-count').textContent = `Results (${page.items.length})`;
  targetSearchPage = {...request, next: page.next};
  $('defects-target-next').hidden = page.next === null;
  setStatus('defects-target-status', page.items.length
    ? `${page.items.length} results · Alexandria PBE · Above hull: low to high. Select a target.`
    : 'No target structures found.');
}

updateTargetMatch();
matchField.addEventListener('change', updateTargetMatch);
$('defects-target-query').addEventListener('input', clearTargetMatches);
window.addEventListener('pageshow', updateTargetMatch);
$('defects-target-search').addEventListener('submit', event => {
  event.preventDefault();
  performAction('defects-target-status', () => findTargets());
});
$('defects-target-next').addEventListener('click', () => performAction('defects-target-status', () => findTargets(true)));
const searchCompeting = () => performAction('defects-source-status', async () => {
  const elements = selectedElements();
  if (!supportsPhaseSearch(elements.length)) throw new Error(cpdAvailability(elements.length));
  const saved = await providerStore.load(collectionKey());
  const sameSystem = saved && JSON.stringify(saved.chemicalSystem) === JSON.stringify(elements);
  await collectPhases(sameSystem ? saved : null);
});
$('defects-excluded-query').addEventListener('input', filterExcludedPhases);
$('defects-search').addEventListener('click', searchCompeting);
$('defects-search-from-setup').addEventListener('click', () => {
  $('defects-source-title').scrollIntoView({block:'start'});
  searchCompeting();
});
$('defects-search-stop').addEventListener('click', () => providerController?.abort());
$('defects-resume-provider').addEventListener('click', searchCompeting);
$('defects-import').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  performAction('defects-source-status', () => phaseImport(file));
});
// Dots preserve the group gaps. The two detached rows start at group 3.
const periodicRows = [
  'H . . . . . . . . . . . . . . . . He',
  'Li Be . . . . . . . . . . B C N O F Ne',
  'Na Mg . . . . . . . . . . Al Si P S Cl Ar',
  'K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr',
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe',
  'Cs Ba . Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn',
  'Fr Ra . Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og',
  '. . La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu',
  '. . Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr',
];
const dopantDialog = $('defects-dopant-dialog');
const dopantQuery = $('defects-dopant-query');
const dopantGrid = $('defects-dopant-grid');
const dopantTiles = new Map();
let draftDopants = [];

function dopantChip(symbol, remove) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'defects-dopant-chip';
  chip.textContent = symbol;
  chip.setAttribute('aria-label', `Remove ${symbol}`);
  chip.onclick = remove;
  return chip;
}

function dopantIssue(symbol, host, supported, limit) {
  if (host.includes(symbol)) return 'Already in the target structure';
  if (!supported.includes(symbol)) return 'Unsupported by the selected model';
  if (draftDopants.includes(symbol)) return 'Already selected';
  if (draftDopants.length >= limit) return `Limit of ${limit} dopants reached`;
  return '';
}

function updateDopantPicker({reveal = false} = {}) {
  const query = dopantQuery.value.trim().toLowerCase();
  const normalized = query.slice(0, 1).toUpperCase() + query.slice(1);
  const exact = dopantTiles.has(normalized) ? normalized : '';
  const host = hostElements(), limit = dopantSlotCount(host.length);
  const supported = selectedModel()?.supported_atomic_symbols || [];
  let matches = 0;
  let firstAvailable;
  for (const [symbol, tile] of dopantTiles) {
    const issue = dopantIssue(symbol, host, supported, limit);
    const match = query && symbol.toLowerCase().startsWith(query);
    if (match) matches++;
    tile.dataset.match = exact === symbol ? 'exact' : match ? 'prefix' : '';
    tile.dataset.selected = String(draftDopants.includes(symbol));
    tile.dataset.host = String(host.includes(symbol));
    tile.disabled = !!issue;
    tile.tabIndex = -1;
    if (!issue) firstAvailable ||= tile;
    tile.title = issue ? `${symbol} · ${issue}` : symbol;
    tile.setAttribute('aria-label', `${tile.title} · atomic number ${atomicNumber(symbol)}`);
  }
  const exactTile = dopantTiles.get(exact);
  const tabStop = exactTile && !exactTile.disabled ? exactTile : firstAvailable;
  if (tabStop) tabStop.tabIndex = 0;
  $('defects-dopant-count').textContent = `Selected ${draftDopants.length}/${limit}`;
  $('defects-dopant-picked').replaceChildren(...draftDopants.map(symbol => dopantChip(symbol, () => {
    draftDopants = draftDopants.filter(value => value !== symbol);
    updateDopantPicker();
    dopantQuery.focus({preventScroll: true});
  })));
  const issue = exact ? dopantIssue(exact, host, supported, limit) : '';
  const invalid = !!query && !matches;
  dopantQuery.setAttribute('aria-invalid', String(invalid || !!issue));
  setStatus('defects-dopant-feedback', exact ? (issue ? `${exact} · ${issue}` : `${exact} · Press Enter or select its tile`)
    : invalid ? 'Enter a valid element symbol, such as La, Ca or Zr.'
    : query ? `${matches} matching symbols · Select a highlighted tile` : 'Type a symbol or select an element.', invalid || issue ? 'error' : 'info');
  const add = $('defects-dopant-add');
  add.textContent = exact && !issue ? `Add ${exact}` : 'Add';
  add.disabled = !exact || !!issue;
  if (reveal && exactTile) {
    const view = $('defects-dopant-table');
    const tile = exactTile.getBoundingClientRect(), area = view.getBoundingClientRect();
    if (tile.left < area.left || tile.right > area.right) {
      view.scrollLeft += (tile.left + tile.right - area.left - area.right) / 2;
    }
  }
}

function pickDopant(symbol) {
  if (!dopantTiles.has(symbol) || dopantTiles.get(symbol).disabled) return;
  draftDopants.push(symbol);
  dopantQuery.value = '';
  updateDopantPicker();
  dopantQuery.focus({preventScroll: true});
}

periodicRows.forEach((row, period) => row.split(' ').forEach((symbol, group) => {
  if (symbol === '.') return;
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.dataset.element = symbol;
  tile.dataset.row = period;
  tile.dataset.column = group;
  tile.style.gridArea = `${period + 1} / ${group + 1}`;
  const number = document.createElement('small');
  number.textContent = atomicNumber(symbol);
  tile.append(number, symbol);
  tile.onclick = () => pickDopant(symbol);
  dopantTiles.set(symbol, tile);
  dopantGrid.append(tile);
}));
dopantGrid.addEventListener('keydown', event => {
  const direction = {ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1]}[event.key];
  const current = event.target.closest('[data-element]');
  if (!current || !Array.isArray(direction)) return;
  event.preventDefault();
  let row = Number(current.dataset.row), column = Number(current.dataset.column);
  while (true) {
    row += direction[0];
    column += direction[1];
    if (row < 0 || row >= periodicRows.length || column < 0 || column >= 18) return;
    const next = dopantGrid.querySelector(`[data-row="${row}"][data-column="${column}"]:not(:disabled)`);
    if (next) {
      current.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
      return;
    }
  }
});
$('defects-edit-dopants').onclick = () => {
  draftDopants = [...dopants];
  dopantQuery.value = '';
  updateDopantPicker();
  dopantDialog.showModal();
};
dopantQuery.addEventListener('input', () => updateDopantPicker({reveal: true}));
$('defects-dopant-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = dopantQuery.value.trim();
  pickDopant(query.slice(0, 1).toUpperCase() + query.slice(1).toLowerCase());
});
$('defects-dopant-done').onclick = () => {
  dopantDialog.close();
  applyDopants(draftDopants);
};
$('defects-dopant-cancel').onclick = () => dopantDialog.close();
dopantDialog.addEventListener('close', () => $('defects-edit-dopants').focus({preventScroll: true}));

$('defects-model').addEventListener('change', () => {
  const model = selectedModel();
  if (setupRelaxation && !currentSetupRelaxation()) {
    setupRelaxation = relaxedHost = null;
    energySet = referenceSet = null;
    lastEnergySummary = null;
    clearCpdPresentation();
    showTargetStructure();
    setStatus('defects-target-relax-status', 'Relax the target with the selected model to continue.');
  }
  if (cpdResult && (cpdResult.model.model_id !== model?.model_id || cpdResult.model.weights_sha256 !== model?.weights_sha256)) clearCpdPresentation();
  renderSetup();
  syncModelSupport();
});
$('defects-legacy-target').addEventListener('change', () => {
  targetPhase = phaseRecord($('defects-legacy-target').value) || null;
  if (!targetPhase) return;
  $('defects-legacy-target-wrap').hidden = true;
  setStatus('defects-active-target', `Active target: ${phaseFormula(targetPhase)} · ${targetPhase.source.recordId} · imported target`);
  renderPhaseList();
});
$('defects-max-atoms').addEventListener('change', () => {
  clearCpdPresentation();
  renderPhaseList();
});
$('defects-show-input').addEventListener('click', () => { targetFrame = 'input'; showTargetStructure(); });
$('defects-show-relaxed').addEventListener('click', () => { targetFrame = 'relaxed'; showTargetStructure(); });
for (const button of targetControls().querySelectorAll('[data-target-axis]')) {
  button.onclick = () => defectViewer('target').setCameraAxis(Number(button.dataset.targetAxis));
}
const targetTools = [...targetControls().querySelectorAll('[data-target-tool]')];
function setTargetTool(mode) {
  defectViewer('target').setInteractionMode(mode);
  for (const tool of targetTools) {
    const active = tool.dataset.targetTool === mode;
    tool.classList.toggle('selected', active);
    tool.setAttribute('aria-pressed', String(active));
  }
}
for (const button of targetTools) button.onclick = () => setTargetTool(button.dataset.targetTool);
$('defects-target-canvas').addEventListener('crystal-viewer-tool', event => setTargetTool(event.detail.mode));
$('defects-target-projection').onclick = event => {
  const button = event.currentTarget, orthographic = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(orthographic));
  button.textContent = orthographic ? 'Orthographic' : 'Perspective';
  defectViewer('target').setProjection(orthographic ? 'orthographic' : 'perspective');
};
$('defects-target-input-cell').onclick = () => {
  targetDisplay.request = targetDisplay.conventional = null;
  targetViewNote();
  drawTarget();
  defectViewer('target').fitCamera();
};
$('defects-target-conventional').onclick = useTargetConventional;
$('defects-target-apply-repeat').onclick = () => applyTargetRepeats(targetRepeats().map(input => Number(input.value)));
for (const button of targetControls().querySelectorAll('[data-target-repeat]')) {
  button.onclick = () => applyTargetRepeats(Array(3).fill(Number(button.dataset.targetRepeat)));
}
for (const id of ['boundary', 'neighbors', 'bond-mode']) {
  $(`defects-target-${id}`).addEventListener('change', () => {
    const structure = targetDisplay.conventional || targetDisplay.structure;
    if (targetInstanceCount(structure, targetDisplay.repeats) > 5000) {
      $('defects-target-neighbors').checked = false;
      if (targetInstanceCount(structure, targetDisplay.repeats) > 5000) $('defects-target-boundary').checked = false;
      targetViewNote('Periodic images exceed the 5,000-atom display limit.');
    } else targetViewNote();
    drawTarget();
  });
}
for (const id of ['style', 'cell', 'bonds']) $(`defects-target-${id}`).addEventListener('change', drawTarget);
for (const id of ['atom-size', 'bond-size']) $(`defects-target-${id}`).addEventListener('input', drawTarget);
$('defects-target-element').addEventListener('change', syncTargetElement);
for (const id of ['color', 'element-radius']) {
  $(`defects-target-${id}`).addEventListener('input', () => {
    targetDisplay.styles[$('defects-target-element').value] = {
      color: $('defects-target-color').value, radius_scale: Number($('defects-target-element-radius').value),
    };
    $('defects-target-style').value = 'custom';
    syncTargetElement();
    drawTarget();
  });
}

$('defects-local-scope').addEventListener('change', () => showLocalVacancy({refit: true}));
for (const id of ['defects-local-radius', 'defects-local-bonds', 'defects-local-arrows']) {
  $(id).addEventListener('change', () => showLocalVacancy());
}
for (const id of ['defects-local-progress', 'defects-local-vector-scale']) {
  $(id).addEventListener('input', () => showLocalVacancy());
}
for (const [id, value] of [['defects-local-initial', '0'], ['defects-local-relaxed', '100']]) {
  $(id).addEventListener('click', () => {
    $('defects-local-progress').value = value;
    showLocalVacancy();
  });
}

$('defects-include-interstitials').addEventListener('change', () => performAction('defects-interstitial-status', refreshInterstitialCandidates));
$('defects-interstitial-separation').addEventListener('change', event => {
  const input = event.currentTarget;
  if (!input.reportValidity()) {
    input.value = interstitialSiteSeparation;
    return;
  }
  interstitialSiteSeparation = input.valueAsNumber;
  performAction('defects-interstitial-status', refreshInterstitialCandidates);
});
$('defects-generate-vacancies').addEventListener('click', () => performAction('defects-vacancy-status', generateVacancyPreview));
$('defects-run-all-vacancies').addEventListener('click', () => performAction('defects-vacancy-energy-status', async () => {
  if (!vacancyPreview && draftSupercell) await generateVacancyPreview();
  if (!vacancyPreview?.relaxedHostVerified) {
    throw new Error(vacancyPreview?.previewOnlyReason || 'The relaxed calculation lattice could not be verified.');
  }
  await runAllVacancies();
}));
$('defects-run-vacancy').addEventListener('click', () => performAction('defects-vacancy-energy-status', async () => {
  const orbit = selectedVacancy;
  if (!orbit) return;
  vacancyFailures.set(orbit.defectId, 'Calculating…');
  updateVacancyRunStates();
  try {
    await runVacancyEnergy(orbit);
  }
  catch (error) {
    recordVacancyFailure(orbit, error);
    throw error;
  }
}));
$('defects-supercell-frame').addEventListener('change', () => showCalculationSupercell());
$('defects-target-near-cubic').onclick = () => {
  $('defects-near-cubic').open = true;
  $('defects-near-cubic').scrollIntoView({block: 'start'});
};
$('defects-near-search').onclick = () => performAction('defects-near-status', searchNearCubic);
for (const id of ['defects-near-length', 'defects-near-atoms']) $(id).addEventListener('input', () => {
  resetNearCubicCandidates();
  syncVacancyControls();
});
$('defects-near-apply').onclick = () => {
  if (!nearCubicCandidate) return;
  appliedNearCubic = nearCubicCandidate;
  clearVacancyPreview();
  performAction('defects-vacancy-status', prepareDefectPreview);
};
$('defects-near-diagonal').onclick = () => {
  appliedNearCubic = null;
  clearVacancyPreview();
  performAction('defects-vacancy-status', prepareDefectPreview);
};
for (const id of ['defects-calculation-basis', 'defects-repeat-a', 'defects-repeat-b', 'defects-repeat-c']) $(id).addEventListener('change', () => {
  appliedNearCubic = null;
  resetNearCubicCandidates();
  clearVacancyPreview();
  performAction('defects-vacancy-status', prepareDefectPreview);
});
$('defects-download-vacancy').addEventListener('click', () => {
  if (!vacancyPreview || !selectedVacancy) return;
  try {
    const structure = globalThis.NeutralDefect.structureForDefect(perfectSupercellForVacancy(vacancyPreview.supercell), selectedVacancy);
    const poscar = globalThis.Structures.toPoscar(structure, selectedVacancy.defectId);
    download(`${selectedVacancy.defectId.replace(/[^A-Za-z0-9_.-]+/g, '_')}.vasp`, poscar, 'text/plain');
  } catch (error) { setStatus('defects-vacancy-status', `Could not export defect structure: ${error.message}`, 'error'); }
});
$('defects-cpd-review-phases').addEventListener('click', () => {
  $('defects-source-title').scrollIntoView({block: 'start'});
});
$('defects-calculate').addEventListener('click', () => performAction('defects-run-status', () => runSelected(false)));
$('defects-stop').addEventListener('click', () => { cpdClient?.cancel(); queue?.cancel().catch(error => setStatus('defects-run-status', `Stop error: ${error.message}`, 'error')); });
$('defects-resume').addEventListener('click', () => performAction('defects-run-status', () => runSelected(true)));
$('defects-export-vertices-yaml').addEventListener('click', () => {
  try { exportTargetVertices(); }
  catch (error) { setStatus('defects-run-status', error.message, 'error'); }
});
$('defects-export-bundle').addEventListener('click', () => exportBundle().catch(error => setStatus('defects-run-status', error.message, 'error')));

function openDefectsSetup() {
  if ($('defects-workspace').hidden || !globalThis.StructureInfo) return;
  if (!targetPhase && !importedBundle && !pendingTargetEdits()) {
    return performAction('defects-target-editor-status', () => useTargetExample('anatase'));
  }
}
document.addEventListener('macer-phonon-workspace-change', event => {
  if (event.detail.workspace === 'defects') openDefectsSetup();
});
document.addEventListener('DOMContentLoaded', openDefectsSetup, {once: true});
openDefectsSetup();

loadCatalog().catch(error => { $('defects-model').replaceChildren(new Option('Model catalog error', '')); setStatus('defects-run-status', `Cannot load the pinned model catalog: ${error.message}`, 'error'); });
window.addEventListener('beforeunload', () => { providerController?.abort(); cpdClient?.dispose(); worker?.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl); });
