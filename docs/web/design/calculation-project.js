/* Immutable task identities and one-document atomic persistence for thermo/defect calculations. */
(function (root) {
  'use strict';
  const fail = message => { throw new TypeError(message); };
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/i.test(x);
  const clone = x => JSON.parse(JSON.stringify(x));
  const contract = () => {
    const api = root.PhaseDatasetContract || (typeof require === 'function' ? require('./phase-dataset.js') : null);
    if (!api) fail('Phase dataset canonical hash support is unavailable.');
    return api;
  };
  async function hash(value) { return contract().sha256(value); }
  function validateModel(model) {
    if (!model || typeof model.modelKey !== 'string' || !model.modelKey || typeof model.modelId !== 'string' || !model.modelId || !sha(model.weightsSha256)) fail('Project model identity is invalid.');
    return model;
  }
  function validateGeometry(g, label = 'geometry') {
    if (!g || !Array.isArray(g.atomic_numbers) || !g.atomic_numbers.length || !g.atomic_numbers.every(z => Number.isSafeInteger(z) && z > 0)
      || !Array.isArray(g.positions_a) || g.positions_a.length !== g.atomic_numbers.length || !g.positions_a.every(v => Array.isArray(v) && v.length === 3 && v.every(finite))
      || !Array.isArray(g.cell_a) || g.cell_a.length !== 3 || !g.cell_a.every(v => Array.isArray(v) && v.length === 3 && v.every(finite))
      || !Array.isArray(g.pbc) || g.pbc.length !== 3 || !g.pbc.every(x => typeof x === 'boolean') || !g.pbc.some(Boolean)) fail(`${label} is invalid.`);
  }
  function validateTaskDefinition(t) {
    if (!t || typeof t.taskId !== 'string' || !t.taskId || !['phase-relax', 'qha-volume'].includes(t.type) || typeof t.phaseId !== 'string' || !t.phaseId) fail('Task definition is invalid.');
    validateGeometry(t.structure, `Task ${t.taskId} input geometry`);
    const mode = t.type === 'qha-volume' ? 'fixed-cell' : 'isif3';
    if (!t.settings || t.settings.mode !== mode || !['fire', 'lbfgs', 'cg'].includes(t.settings.optimizer)
      || !Number.isSafeInteger(t.settings.maxSteps) || t.settings.maxSteps < 1
      || !finite(t.settings.forceToleranceEvA) || t.settings.forceToleranceEvA <= 0
      || !finite(t.settings.stressToleranceGpa) || t.settings.stressToleranceGpa <= 0) fail(`Task ${t.taskId} settings must describe a valid ${mode} relaxation.`);
  }
  const identityFor = (plan, definition) => ({ schema: 'macer-phase-relax-task-identity-v1', datasetSha256: plan.datasetSha256,
    model: plan.model, taskId: definition.taskId, phaseId: definition.phaseId, structure: definition.structure, settings: definition.settings });
  async function createProject(plan) {
    if (!plan || !plan.projectId || !sha(plan.datasetSha256) || !Array.isArray(plan.tasks) || !plan.tasks.length) fail('Calculation project plan is invalid.');
    validateModel(plan.model);
    const ids = new Set(), tasks = [];
    for (const definition of plan.tasks) {
      validateTaskDefinition(definition);
      if (ids.has(definition.taskId)) fail('Task IDs must be unique.');
      ids.add(definition.taskId);
      tasks.push({ ...clone(definition), taskKey: await hash(identityFor(plan, definition)), status: 'queued', attempts: 0, restartCount: 0,
        attemptedEvaluations: 0, partial: null, attemptSummary: null, result: null });
    }
    return { schema: 'macer-thermo-defect-calculation-project-v1', schemaVersion: 1, projectId: plan.projectId,
      datasetSha256: plan.datasetSha256, model: clone(plan.model), state: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metrics: { completed: 0, reused: 0, forceStressEvaluations: 0, elapsedSeconds: 0 }, tasks };
  }
  function validateCompletedResult(project, task) {
    const r = task.result;
    if (!r || r.status !== 'converged' || r.taskKey !== task.taskKey || r.phaseId !== task.phaseId || !finite(r.totalEnergyEv)
      || !Number.isSafeInteger(r.atomCount) || r.atomCount !== task.structure.atomic_numbers.length || !Number.isSafeInteger(r.evaluations) || r.evaluations < 1
      || !sha(r.initialGeometrySha256) || !sha(r.finalGeometrySha256) || !r.relaxSettings
      || JSON.stringify(r.model) !== JSON.stringify(project.model)) fail(`Completed task ${task.taskId} result identity is invalid.`);
    validateGeometry(r.geometry, `Task ${task.taskId} final geometry`);
    if (r.geometry.atomic_numbers.length !== task.structure.atomic_numbers.length) fail(`Task ${task.taskId} atom count changed.`);
    if (task.type === 'qha-volume') {
      if (JSON.stringify(r.geometry.cell_a) !== JSON.stringify(task.structure.cell_a) ||
          JSON.stringify(r.geometry.atomic_numbers) !== JSON.stringify(task.structure.atomic_numbers)) fail('QHA fixed cell or atom order changed.');
      const qha = r.qha;
      if (!sha(r.qhaSha256) || !qha?.forceConstants?.values?.length || !qha?.thermal?.stability ||
          !Number.isSafeInteger(qha.forceEvaluations) || qha.forceEvaluations < 1) fail('QHA volume result is incomplete.');
    }
  }
  function validateProject(p) {
    if (!p || p.schema !== 'macer-thermo-defect-calculation-project-v1' || p.schemaVersion !== 1 || !p.projectId || !sha(p.datasetSha256) || !Array.isArray(p.tasks)) fail('Calculation project schema is invalid.');
    validateModel(p.model);
    const ids = new Set();
    for (const task of p.tasks) {
      validateTaskDefinition(task);
      if (ids.has(task.taskId) || !sha(task.taskKey) || !Number.isSafeInteger(task.attempts) || task.attempts < 0 || !Number.isSafeInteger(task.restartCount) || task.restartCount < 0
        || !Number.isSafeInteger(task.attemptedEvaluations) || task.attemptedEvaluations < 0 || !['queued', 'running', 'completed', 'failed', 'cancelled', 'max_steps'].includes(task.status)) fail('Calculation task state is invalid.');
      ids.add(task.taskId);
      if (task.status === 'completed') validateCompletedResult(p, task);
      else if (task.result != null) fail(`Non-completed task ${task.taskId} cannot publish an energy result.`);
    }
    if (!['queued', 'running', 'partial', 'failed', 'cancelled', 'completed'].includes(p.state)) fail('Calculation project state is invalid.');
    return clone(p);
  }
  async function reconcileProject(previous, plan) {
    const next = await createProject(plan), old = new Map((previous?.tasks || []).map(t => [t.taskId, t]));
    const reusedTaskIds = [], invalidatedTaskIds = [];
    for (const task of next.tasks) {
      const candidate = old.get(task.taskId);
      if (!candidate) continue;
      if (candidate.status === 'completed' && candidate.taskKey === task.taskKey && JSON.stringify(previous.model) === JSON.stringify(next.model)) {
        task.status = 'completed'; task.attempts = candidate.attempts; task.restartCount = candidate.restartCount;
        task.attemptedEvaluations = candidate.attemptedEvaluations; task.result = clone(candidate.result); reusedTaskIds.push(task.taskId);
      } else if (candidate.taskKey !== task.taskKey || JSON.stringify(previous.model) !== JSON.stringify(next.model)) invalidatedTaskIds.push(task.taskId);
    }
    for (const id of old.keys()) if (!next.tasks.some(t => t.taskId === id)) invalidatedTaskIds.push(id);
    next.metrics.completed = reusedTaskIds.length;
    next.metrics.reused = reusedTaskIds.length;
    next.state = reusedTaskIds.length === next.tasks.length ? 'completed' : 'queued';
    next.reconciliation = { reusedTaskIds, invalidatedTaskIds };
    return validateProject(next);
  }
  async function verifyTaskIdentities(project) {
    const valid = validateProject(project);
    for (const task of valid.tasks) {
      const expected = await hash(identityFor({ datasetSha256: valid.datasetSha256, model: valid.model }, task));
      if (expected !== task.taskKey) fail(`Calculation task ${task.taskId} identity hash does not match its immutable inputs.`);
      if (task.result && task.type === 'qha-volume' && task.result.qhaSha256 !== await hash(task.result.qha)) {
        fail(`QHA volume ${task.taskId} result hash does not match its payload.`);
      }
      if (task.result && (task.result.taskKey !== expected || task.result.initialGeometrySha256 !== await hash(task.structure)
        || task.result.finalGeometrySha256 !== await hash(task.result.geometry) || JSON.stringify(task.result.relaxSettings) !== JSON.stringify(task.settings))) fail(`Calculation task ${task.taskId} result identity is invalid.`);
    }
    return valid;
  }

  function createIndexedDbStore(indexedDB = root.indexedDB) {
    function open() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('macer-thermo-defect-calculations', 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('projects')) request.result.createObjectStore('projects'); };
        request.onerror = () => reject(request.error || new Error('Could not open calculation project storage.'));
        request.onblocked = () => reject(new Error('Calculation project storage is blocked by another tab.'));
        request.onsuccess = () => resolve(request.result);
      });
    }
    async function put(project) {
      const valid = validateProject(project), db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('projects', 'readwrite', { durability: 'strict' });
        tx.objectStore('projects').put(valid, valid.projectId);
        tx.oncomplete = () => { db.close(); resolve(valid); };
        tx.onabort = () => { const error = tx.error || new Error('Calculation project transaction aborted.'); db.close(); reject(error); };
        tx.onerror = () => {};
      });
    }
    return Object.freeze({
      async load(projectId) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('projects', 'readonly'), request = tx.objectStore('projects').get(projectId);
          request.onsuccess = () => { let value = request.result; try { if (value) value = validateProject(value); } catch (error) { db.close(); reject(error); return; } };
          tx.oncomplete = () => { const value = request.result; db.close(); resolve(value ? validateProject(value) : null); };
          tx.onabort = () => { db.close(); reject(tx.error || new Error('Calculation project read failed.')); };
        });
      },
      save: put,
      // Geometry and energy are fields of the same validated task/project record and
      // are written by one durable IndexedDB transaction.
      commitTask: put,
    });
  }
  function createMemoryStore(seed = []) {
    const rows = new Map(seed.map(p => [p.projectId, validateProject(p)]));
    return Object.freeze({
      async load(id) { const p = rows.get(id); return p ? clone(p) : null; },
      async save(p) { const v = validateProject(p); rows.set(v.projectId, v); return clone(v); },
      async commitTask(p) { const v = validateProject(p); rows.set(v.projectId, v); return clone(v); },
      snapshot(id) { const p = rows.get(id); return p ? clone(p) : null; },
    });
  }
  root.CalculationProject = Object.freeze({ hash, createProject, validateProject, reconcileProject, verifyTaskIdentities, createIndexedDbStore, createMemoryStore, validateGeometry });
  if (typeof module === 'object' && module.exports) module.exports = root.CalculationProject;
})(typeof globalThis === 'object' ? globalThis : this);
