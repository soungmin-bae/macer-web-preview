/* Versioned, UI-independent records shared by CPD, neutral defects and thermal workflows. */
(function (root) {
  'use strict';

  const VERSION = 1;
  const SCHEMAS = Object.freeze({
    dataset: 'macer-phase-dataset-v1', energy: 'macer-phase-energy-set-v1',
    references: 'macer-element-reference-set-v1', cpd: 'macer-cpd-result-v1',
    defects: 'macer-defect-set-v1', defectEnergies: 'macer-defect-energy-set-v1',
    reservoir: 'macer-reservoir-selection-v1', thermal: 'macer-thermal-grid-v1',
    finiteTemperature: 'macer-finite-temperature-iteration-v1',
  });
  const fail = message => { throw new TypeError(message); };
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const nonempty = x => typeof x === 'string' && x.trim().length > 0;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clone = value => JSON.parse(JSON.stringify(value));

  function canonicalStringify(value) {
    const active = new Set();
    function visit(v, path) {
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) fail(`Non-finite number at ${path}.`);
        return Object.is(v, -0) ? '0' : JSON.stringify(v);
      }
      if (typeof v !== 'object') fail(`Unsupported JSON value at ${path}.`);
      if (active.has(v)) fail(`Circular value at ${path}.`);
      active.add(v);
      let result;
      if (Array.isArray(v)) result = `[${v.map((x, i) => visit(x, `${path}[${i}]`)).join(',')}]`;
      else {
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null) fail(`Non-plain object at ${path}.`);
        const keys = Object.keys(v).sort();
        result = `{${keys.map(k => `${JSON.stringify(k)}:${visit(v[k], `${path}.${k}`)}`).join(',')}}`;
      }
      active.delete(v);
      return result;
    }
    return visit(value, '$');
  }

  async function sha256(value) {
    const text = canonicalStringify(value);
    if (root.crypto?.subtle && root.TextEncoder) {
      const digest = await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(text));
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    if (typeof require === 'function') return require('node:crypto').createHash('sha256').update(text).digest('hex');
    fail('SHA-256 is unavailable in this runtime.');
  }

  function determinant(cell) {
    const [a, b, c] = cell;
    return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  function validateStructure(structure, path) {
    if (!structure || !Array.isArray(structure.cell) || structure.cell.length !== 3 || !structure.cell.every(v => Array.isArray(v) && v.length === 3 && v.every(finite))) fail(`${path}: cell must be a finite 3×3 lattice in Å.`);
    if (Math.abs(determinant(structure.cell)) < 1e-8) fail(`${path}: cell volume must be nonzero.`);
    if (!Array.isArray(structure.pbc) || structure.pbc.length !== 3 || !structure.pbc.every(v => typeof v === 'boolean') || !structure.pbc.some(Boolean)) fail(`${path}: periodic boundary flags are invalid.`);
    if (!Array.isArray(structure.atoms) || !structure.atoms.length) fail(`${path}: at least one atom is required.`);
    for (const [i, atom] of structure.atoms.entries()) {
      if (!atom || !nonempty(atom.element) || !Array.isArray(atom.fractional) || atom.fractional.length !== 3 || !atom.fractional.every(finite)) fail(`${path}.atoms[${i}]: element and three finite fractional coordinates are required.`);
      if (atom.occupancy !== undefined && (!finite(atom.occupancy) || atom.occupancy <= 0 || atom.occupancy > 1)) fail(`${path}.atoms[${i}]: occupancy must be in (0,1].`);
    }
  }
  function validateHeader(value, schema, label) {
    if (!value || value.schema !== schema || value.schemaVersion !== VERSION) fail(`${label}: unsupported or missing schema version.`);
  }
  function validateDataset(input) {
    canonicalStringify(input);
    validateHeader(input, SCHEMAS.dataset, 'PhaseDataset');
    if (!nonempty(input.datasetId) || !input.providerSnapshot || !nonempty(input.providerSnapshot.provider) || !nonempty(input.providerSnapshot.retrievedAt) || typeof input.providerSnapshot.complete !== 'boolean') fail('PhaseDataset: provider identity, retrieval time and completeness are required.');
    if (!Array.isArray(input.chemicalSystem) || !input.chemicalSystem.length || !input.chemicalSystem.every(nonempty) || new Set(input.chemicalSystem).size !== input.chemicalSystem.length) fail('PhaseDataset: chemicalSystem must contain unique element symbols.');
    if (!input.hullCutoff || !finite(input.hullCutoff.value) || input.hullCutoff.value < 0 || input.hullCutoff.unit !== 'eV/atom') fail('PhaseDataset: hull cutoff must be finite and expressed in eV/atom.');
    if (!Array.isArray(input.phases) || !input.phases.length) fail('PhaseDataset: at least one phase record is required.');
    const ids = new Set(), allowed = new Set(input.chemicalSystem);
    for (const [i, phase] of input.phases.entries()) {
      if (!phase || !nonempty(phase.phaseId) || ids.has(phase.phaseId)) fail(`PhaseDataset.phases[${i}]: phaseId must be unique and nonempty.`);
      ids.add(phase.phaseId);
      if (!phase.source || !nonempty(phase.source.provider) || !nonempty(phase.source.recordId) || !nonempty(phase.source.license)) fail(`PhaseDataset.phases[${i}]: source, record identity and license are required.`);
      validateStructure(phase.structure, `PhaseDataset.phases[${i}].structure`);
      if (phase.structure.atoms.some(a => !allowed.has(a.element))) fail(`PhaseDataset.phases[${i}]: structure contains an element outside chemicalSystem.`);
    }
    if (input.manualHistory !== undefined && !Array.isArray(input.manualHistory)) fail('PhaseDataset.manualHistory must be an array.');
    return clone(input);
  }
  function isChemicalSystemCompound(phase, chemicalSystem) {
    if (!phase || !phase.structure || !Array.isArray(phase.structure.atoms) || !Array.isArray(chemicalSystem) || chemicalSystem.length < 2) return false;
    const present = new Set(phase.structure.atoms.map(atom => atom && atom.element).filter(nonempty));
    return chemicalSystem.every(element => present.has(element));
  }
  function validateEnergySet(input, dataset, expectedModel) {
    validateHeader(input, SCHEMAS.energy, 'PhaseEnergySet');
    if (!nonempty(input.energySetId) || input.datasetId !== dataset.datasetId || !input.model || !nonempty(input.model.modelId) || !/^[a-f0-9]{64}$/i.test(input.model.weightsSha256 || '')) fail('PhaseEnergySet: dataset and model identities are required.');
    if (expectedModel && (input.model.modelId !== expectedModel.modelId || input.model.weightsSha256.toLowerCase() !== String(expectedModel.weightsSha256).toLowerCase())) fail('PhaseEnergySet: model identity mismatch.');
    if (input.energyUnit !== 'eV' || !Array.isArray(input.entries)) fail('PhaseEnergySet: entries and eV total-energy units are required.');
    const phases = new Map(dataset.phases.map(p => [p.phaseId, p])), seen = new Set();
    for (const [i, entry] of input.entries.entries()) {
      if (!phases.has(entry.phaseId) || seen.has(entry.phaseId)) fail(`PhaseEnergySet.entries[${i}]: unknown or duplicate phaseId.`);
      seen.add(entry.phaseId);
      if (!['converged', 'failed', 'max_steps', 'cancelled'].includes(entry.status)) fail(`PhaseEnergySet.entries[${i}]: invalid task status.`);
      if (entry.status === 'converged') {
        if (!finite(entry.totalEnergyEv) || !Number.isSafeInteger(entry.atomCount) || entry.atomCount < 1 || entry.atomCount !== phases.get(entry.phaseId).structure.atoms.length) fail(`PhaseEnergySet.entries[${i}]: converged energy/atom count is invalid.`);
        if (!/^[a-f0-9]{64}$/i.test(entry.initialGeometrySha256 || '') || !/^[a-f0-9]{64}$/i.test(entry.finalGeometrySha256 || '')) fail(`PhaseEnergySet.entries[${i}]: geometry hashes are required.`);
        if (!entry.relax || !['fire', 'lbfgs', 'cg'].includes(entry.relax.optimizer) || !['fixed-cell', 'isif3'].includes(entry.relax.mode) || !finite(entry.relax.forceToleranceEvA) || entry.relax.forceToleranceEvA <= 0 || !Number.isSafeInteger(entry.evaluations) || entry.evaluations < 0 || !finite(entry.elapsedSeconds) || entry.elapsedSeconds < 0) fail(`PhaseEnergySet.entries[${i}]: relax settings or accounting are invalid.`);
      }
    }
    return clone(input);
  }
  function validateReferences(input, dataset, energySet) {
    validateHeader(input, SCHEMAS.references, 'ElementReferenceSet');
    if (!nonempty(input.referenceSetId) || input.energySetId !== energySet.energySetId || !Array.isArray(input.references)) fail('ElementReferenceSet: energy-set identity and references are required.');
    const byPhase = new Map(energySet.entries.filter(e => e.status === 'converged').map(e => [e.phaseId, e])), elements = new Set();
    for (const row of input.references) {
      if (!row || !dataset.chemicalSystem.includes(row.element) || elements.has(row.element) || !nonempty(row.phaseId) || !byPhase.has(row.phaseId) || !finite(row.mu0EvPerAtom) || row.unit !== 'eV/atom' || !nonempty(row.source)) fail('ElementReferenceSet: reference must identify one converged phase and finite eV/atom chemical potential per element.');
      const referencePhase = dataset.phases.find(p => p.phaseId === row.phaseId);
      if (referencePhase.structure.atoms.some(atom => atom.element !== row.element || (atom.occupancy !== undefined && atom.occupancy !== 1))) fail(`ElementReferenceSet: ${row.element} reference must be an ordered, unary elemental phase.`);
      elements.add(row.element);
    }
    if (elements.size !== dataset.chemicalSystem.length) fail('ElementReferenceSet: one reference is required for every chemical-system element.');
    return clone(input);
  }
  function validateExtension(input, schema, label, required) {
    validateHeader(input, schema, label);
    for (const key of required) if (!own(input, key)) fail(`${label}: missing ${key}.`);
    return clone(input);
  }
  function validateBundle(input, options = {}) {
    canonicalStringify(input);
    if (!input || input.schema !== 'macer-thermo-defect-bundle-v1' || input.schemaVersion !== VERSION) fail('Unsupported thermo/defect bundle schema.');
    const dataset = validateDataset(input.phaseDataset);
    const energySet = validateEnergySet(input.phaseEnergySet, dataset, options.expectedModel);
    const elementReferences = input.elementReferenceSet ? validateReferences(input.elementReferenceSet, dataset, energySet) : null;
    const extensions = {};
    if (input.cpdResult) extensions.cpdResult = validateExtension(input.cpdResult, SCHEMAS.cpd, 'CpdResult', ['phaseDatasetSha256', 'phaseEnergySetSha256', 'elementReferenceSetSha256', 'constraints', 'vertices', 'facets', 'missingRows']);
    if (input.defectSet) extensions.defectSet = validateExtension(input.defectSet, SCHEMAS.defects, 'DefectSet', ['hostPhaseId', 'supercellMatrix', 'siteIds', 'defects']);
    if (input.defectEnergySet) extensions.defectEnergySet = validateExtension(input.defectEnergySet, SCHEMAS.defectEnergies, 'DefectEnergySet', ['defectSetSha256', 'perfectEnergyEv', 'entries']);
    if (input.reservoirSelection) extensions.reservoirSelection = validateExtension(input.reservoirSelection, SCHEMAS.reservoir, 'ReservoirSelection', ['source', 'chemicalPotentialsEv']);
    if (input.thermalGrid) extensions.thermalGrid = validateExtension(input.thermalGrid, SCHEMAS.thermal, 'ThermalGrid', ['states', 'temperatureK', 'qMesh']);
    if (input.finiteTemperatureIteration) extensions.finiteTemperatureIteration = validateExtension(input.finiteTemperatureIteration, SCHEMAS.finiteTemperature, 'FiniteTemperatureIteration', ['seed', 'ensembleSha256', 'cycles']);
    return clone({ ...input, phaseDataset: dataset, phaseEnergySet: energySet, elementReferenceSet: elementReferences, ...extensions });
  }
  async function bundleHash(bundle) { return sha256(validateBundle(bundle)); }
  async function importBundle(currentProject, raw, options = {}) {
    // Stage every parse/validation/hash operation before returning replacement state.
    // Callers swap the returned value into active UI state only after this resolves.
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const staged = validateBundle(parsed, options);
    const digest = await bundleHash(staged);
    return { ...currentProject, thermoDefectBundle: staged, thermoDefectBundleSha256: digest };
  }

  const api = Object.freeze({ VERSION, SCHEMAS, canonicalStringify, sha256, validateStructure, validateDataset, isChemicalSystemCompound, validateEnergySet, validateReferences, validateBundle, bundleHash, importBundle });
  root.PhaseDatasetContract = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
