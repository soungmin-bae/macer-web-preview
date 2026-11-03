/* Client-only Fitted BPM / CGCNN comparison; both numerical kernels run in Rust/WASM. */
(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const panel = $('raman-panel');
  if (!panel || !root.PhononBand || root.RamanModelComparison) return;

  const section = document.createElement('details');
  section.id = 'raman-model-comparison';
  section.className = 'raman-comparison';
  section.open = true;
  section.setAttribute('aria-label', 'Compare Raman response models');
  section.innerHTML = `
    <summary>Compare Fitted BPM and CGCNN</summary>
    <p class="raman-comparison-note">Both use the same analytic Γ modes. Phonons and forces are not recalculated.</p>
    <div class="phonon-toolbar">
      <label>Model <select id="raman-compare-model">
        <option value="fere">Fitted BPM · RamanDB</option>
        <option value="cgcnn">CGCNN</option>
      </select></label>
      <button type="button" id="raman-compare-run" class="primary">Calculate selected</button>
      <button type="button" id="raman-compare-both">Compare both</button>
      <button type="button" id="raman-compare-stop" disabled>Stop</button>
      <label>Curve scale <select id="raman-compare-normalization">
        <option value="common">Same scale</option><option value="individual">Scale each curve</option>
      </select></label>
    </div>
    <p id="raman-compare-service" role="status">Both model responses run in this browser using Rust/WASM.</p>
    <p id="raman-compare-status" role="status">Open a Γ phonon result with eigenvectors to compare.</p>
    <div class="raman-comparison-legend">
      <span><i class="raman-legend-fere"></i>Fitted BPM · RamanDB-fitted bond polarizability</span>
      <span><i class="raman-legend-cgcnn"></i>CGCNN · learned polarizability model</span>
    </div>
    <p id="raman-compare-failures" class="raman-comparison-note" role="status"></p>
    <p id="raman-compare-numerical" class="raman-comparison-note" role="status"></p>
    <canvas id="raman-compare-plot" aria-label="Fitted BPM and CGCNN Raman comparison" tabindex="0"></canvas>
    <div class="raman-comparison-table-wrap"><table class="raman-comparison-table">
      <thead><tr><th>Mode</th><th>Frequency [cm⁻¹]</th><th>Fitted BPM [a.u.]</th><th>CGCNN [a.u.]</th><th>CGCNN / Fitted BPM</th></tr></thead>
      <tbody id="raman-compare-rows"></tbody>
    </table></div>
    <details><summary>Model details</summary>
      <p id="raman-compare-identity">Fitted BPM is the RamanDB coefficient-regression model also listed in the main Raman menu. Environment BPM is a separate local-environment model.</p>
      <p>Fitted BPM uses the RamanDB-fitted global and element bond-polarizability coefficients (candidate abf824bf). It is the same model as the main-menu “Fitted BPM”; it is not “Environment BPM” (R4). CGCNN uses checkpoint 972dfa5c through Rust/F64 WebAssembly in this browser. It remains an experimental candidate without independent accuracy qualification.</p>
      <p>Curves show relative powder activity, not absolute experimental cross sections. The comparison reuses the current Γ frequencies and eigenvectors.</p>
      <p>Fitted BPM candidate: <code>abf824bf1874fc7a154afaff21f97cc6932278edfe313a191f933850fcbb81ce</code>. CGCNN checkpoint: <code>972dfa5c77a99369a91878c97928941506d3dba4deb3ab2e9c9cddd64b61ca6a</code>.</p>
    </details>`;
  panel.append(section);

  const CM = 33.35640951981521;
  const COLORS = { fere: '#197bb5', cgcnn: '#c45165' };
  const LABELS = { fere: 'Fitted BPM', cgcnn: 'CGCNN' };
  const CGCNN_SHA = '972dfa5c77a99369a91878c97928941506d3dba4deb3ab2e9c9cddd64b61ca6a';
  let phonons = root.PhononBand.getData() || null;
  let revision = 0, currentHash = null, geometryHash = null, currentGamma = -1;
  let selection = { qIndex: 0, modeIndex: 0, source: 'band' };
  let resultsByPhonon = new Map(), failuresByPhonon = new Map();
  let job = null, service = null, plot = null, phononIdentityTask = Promise.resolve();
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(x => x.toString(16).padStart(2, '0')).join('');
  const status = text => { $('raman-compare-status').textContent = text; };

  function gammaData(value) {
    if (!value?.qpoints?.length) return null;
    const index = value.qpoints.findIndex(point => point.q?.every(x => Math.abs(x) < 1e-8));
    if (index < 0) return null;
    const point = value.qpoints[index];
    const usesAnalytic = !!(value.nac && Array.isArray(value.analyticGamma?.bands));
    return { index, source: usesAnalytic ? 'analytic-gamma' : 'gamma', point: usesAnalytic ? { ...point, bands: value.analyticGamma.bands } : point };
  }
  function visibleResults() { return currentHash ? resultsByPhonon.get(currentHash) || {} : {}; }
  function readyError() {
    if (!phonons) return 'Open or calculate phonons first.';
    if (phonons.nac && !Array.isArray(phonons.analyticGamma?.bands)) return 'This result has directional NAC Γ modes but no saved analytic Γ modes.';
    const g = gammaData(phonons);
    if (!g) return 'The phonon result has no q=(0,0,0) point.';
    if (g.point.bands.length !== 3 * phonons.atoms.length || g.point.bands.some(b => !Array.isArray(b.eigenvector))) return 'Complete 3N Γ eigenvectors are required.';
    if (phonons.atoms.some(a => !Number.isFinite(a.mass) || a.mass <= 0)) return 'Positive finite atomic masses are required.';
    return null;
  }
  function serviceLine() {
    $('raman-compare-service').textContent = service?.ok
      ? `Rust/WASM browser inference · CGCNN ${CGCNN_SHA.slice(0, 12)}… · no calculation service`
      : 'CGCNN runtime metadata is unavailable. Fitted BPM can still run.';
  }
  async function checkService() {
    const runtime = root.CgcnnRamanRuntime;
    service = { ok: runtime?.checkpointSHA256 === CGCNN_SHA && runtime?.browserInferenceOnly === true, model: runtime };
    serviceLine(); controls();
  }
  async function updatePhonons(value) {
    phonons = value;
    const updateRevision = ++revision;
    const prior = job;
    if (prior) cancelJob(prior, false);
    const g = gammaData(value);
    currentGamma = g?.index ?? -1;
    currentHash = null; geometryHash = null; render(); controls();
    phononIdentityTask = (async () => {
      if (value && g) {
        const input = { lattice: value.lattice, atoms: value.atoms, q: g.point.q, bands: g.point.bands, gammaSource: g.source };
        const [nextHash, nextGeometryHash] = await Promise.all([digest(input), digest({ lattice: value.lattice, atoms: value.atoms })]);
        if (updateRevision !== revision || value !== phonons) return;
        currentHash = nextHash; geometryHash = nextGeometryHash;
      }
      if (updateRevision === revision && value === phonons) { render(); controls(); }
    })();
    await phononIdentityTask;
  }
  function controls() {
    const error = readyError(), busy = !!job;
    $('raman-compare-model').disabled = busy;
    $('raman-compare-run').disabled = busy || !!error || !currentHash || ($('raman-compare-model').value === 'cgcnn' && !service?.ok);
    $('raman-compare-both').disabled = busy || !!error || !currentHash;
    $('raman-compare-stop').disabled = !busy;
  }
  function modelModes() { const g = gammaData(phonons); return g?.point.bands || []; }
  function commonIdentity(modelId, conditions) {
    return { modelId, modelLabel: LABELS[modelId], gammaSource: gammaData(phonons)?.source, geometryHash, nAtoms: phonons.atoms.length,
      nModes: modelModes().length, phononHash: currentHash, revision, conditions };
  }
  function conditionSnapshot() {
    return { fwhmCm: Number($('raman-width')?.value) || 10, range: root.SpectrumView.options(), normalization: $('raman-compare-normalization').value };
  }
  function startFitted(request, conditions, activeJob) {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const worker = new Worker('./raman-model-comparison-worker.js?v=ec475cdbdc1f8a83');
      activeJob.worker = worker;
      activeJob.cancelActive = () => { worker.terminate(); activeJob.worker = null; reject(new DOMException('Stopped', 'AbortError')); };
      worker.onmessage = ({ data: message }) => {
        if (job !== activeJob || message.requestId !== request.requestId || message.revision !== revision || message.phononHash !== currentHash) return;
        if (message.type === 'error') { worker.terminate(); activeJob.worker = null; reject(Error(message.message)); return; }
        if (message.type === 'result') {
          worker.terminate(); activeJob.worker = null;
          resolve({ identity: { ...commonIdentity('fere', conditions), candidateId: message.model.candidateId, candidateSHA256: message.model.candidateSHA256, kernel: message.model.kernel, runtime: message.model.runtime, qualification: message.model.qualification },
            diagnostics: { ...message.diagnostics, responseInferenceMs: performance.now() - started }, modes: message.modes, completedAt: new Date().toISOString() });
        }
      };
      worker.onerror = () => { worker.terminate(); activeJob.worker = null; reject(Error('Fitted BPM comparison worker failed.')); };
      const g = gammaData(phonons);
      worker.postMessage({ requestId: request.requestId, revision, phononHash: currentHash, geometryHash, q: g.point.q, nac: false,
        data: { lattice: phonons.lattice, atoms: phonons.atoms }, bands: g.point.bands });
    });
  }
  async function startCgcnn(request, conditions, activeJob) {
    if (!service?.ok) throw Error('CGCNN browser WASM runtime metadata is unavailable.');
    const runtime = root.CgcnnRamanRuntime, parameterHash = await digest(runtime);
    if (job !== activeJob || activeJob.stopped) throw new DOMException('Stopped', 'AbortError');
    const started = performance.now(), g = gammaData(phonons);
    return new Promise((resolve, reject) => {
      const url = new URL('./cgcnn-response-worker.js', location.href);
      url.searchParams.set('v', runtime.workerSHA256);
      url.searchParams.set('runtime', runtime.wasmSHA256);
      const worker = new Worker(url, { type: 'module' });
      activeJob.worker = worker;
      const modes = []; let responseSummary = null;
      const finish = () => { worker.terminate(); activeJob.worker = null; };
      activeJob.cancelActive = () => { finish(); reject(new DOMException('Stopped', 'AbortError')); };
      worker.onerror = () => { finish(); reject(Error('CGCNN Rust/WASM Worker failed.')); };
      worker.onmessage = ({ data: message }) => {
        if (job !== activeJob || message.jobId !== request.requestId || message.revision !== revision || message.phononHash !== currentHash || message.parameterHash !== parameterHash) return;
        if (message.type === 'progress') { status('CGCNN · ' + message.stage); return; }
        if (message.type === 'error') { finish(); reject(Error(message.message)); return; }
        if (message.type === 'modes') { for (const row of message.results) modes[row.modeIndex] = row.result; responseSummary = message.responseSummary; return; }
        if (message.type === 'finished') {
          finish();
          if (modes.length !== g.point.bands.length || Array.from({ length: modes.length }, (_, i) => modes[i]).some(row => !row)) { reject(Error('CGCNN returned incomplete mode results.')); return; }
          resolve({ identity: { ...commonIdentity('cgcnn', conditions), checkpointSHA256: runtime.checkpointSHA256, bundleSHA256: runtime.bundleSHA256,
            kernel: runtime.kernel, runtime: runtime.dtype + ' Rust/WASM browser Worker', qualification: runtime.qualification },
            diagnostics: { ...responseSummary, responseInferenceMs: performance.now() - started }, modes, completedAt: new Date().toISOString() });
        }
      };
      worker.postMessage({ jobId: request.requestId, revision, phononHash: currentHash, parameterHash, parameterId: runtime.id,
        data: { lattice: phonons.lattice, atoms: phonons.atoms }, bands: g.point.bands, q: g.point.q, nacEnabled: false, startIndex: 0 });
    });
  }
  function cancelJob(activeJob, showStatus = true) {
    if (!activeJob) return;
    activeJob.stopped = true;
    activeJob.controller?.abort(); activeJob.cancelActive?.(); activeJob.worker?.terminate();
    if (job === activeJob) job = null;
    controls();
    if (showStatus) status('Stopped. Completed model results are preserved.');
  }
  async function calculate(which) {
    const error = readyError();
    if (error) { status(error); return; }
    if (job) return;
    if (which === 'cgcnn' && !service?.ok) { status('CGCNN browser WASM metadata is unavailable. Fitted BPM remains available.'); return; }
    const rev = revision, phononHash = currentHash, conditions = conditionSnapshot();
    const models = which === 'both' ? ['fere', 'cgcnn'] : [which];
    const activeJob = { requestId: crypto.randomUUID(), revision: rev, phononHash, stopped: false };
    job = activeJob; controls();
    let completed = [], failed = [];
    for (let index = 0; index < models.length; index++) {
      const modelId = models[index];
      if (job !== activeJob || revision !== rev || currentHash !== phononHash) return;
      activeJob.requestId = crypto.randomUUID();
      status(`${LABELS[modelId]} · ${index + 1} / ${models.length} · current Γ phonons only`);
      try {
        const request = { requestId: activeJob.requestId };
        const result = modelId === 'fere' ? await startFitted(request, conditions, activeJob) : await startCgcnn(request, conditions, activeJob);
        if (job !== activeJob || revision !== rev || currentHash !== phononHash) return;
        const bucket = resultsByPhonon.get(phononHash) || {};
        bucket[modelId] = result; resultsByPhonon.set(phononHash, bucket); completed.push(modelId);
        const failures = failuresByPhonon.get(phononHash); if (failures) delete failures[modelId];
        render(); document.dispatchEvent(new Event('macer-project-response-change'));
      } catch (failure) {
        if (job !== activeJob || activeJob.stopped || revision !== rev || currentHash !== phononHash) return;
        if (failure.name === 'AbortError') return;
        const failures = failuresByPhonon.get(phononHash) || {};
        failures[modelId] = failure.message || String(failure); failuresByPhonon.set(phononHash, failures); failed.push(modelId);
        render();
      }
    }
    if (job === activeJob && revision === rev) {
      if (failed.length && completed.length) status(`${completed.map(id => LABELS[id]).join(' and ')} completed; ${failed.map(id => LABELS[id]).join(' and ')} failed. Completed results are preserved.`);
      else if (failed.length) status(`${LABELS[failed[0]]} failed. Retry it or select the other model.`);
      else status(which === 'both' ? 'Both responses completed with the same Γ modes and display settings.' : `${LABELS[completed[0]]} response completed.`);
      job = null; controls(); render();
    }
  }
  function notifyProjectDirty() { document.dispatchEvent(new Event('macer-project-response-change')); }
  function draw() {
    const canvas = $('raman-compare-plot'), box = canvas.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const ctx = canvas.getContext('2d'), dpr = devicePixelRatio || 1, w = box.width, h = box.height;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    const models = visibleResults(); $('raman-compare-numerical').textContent = '';
    if (!models.fere && !models.cgcnn) { ctx.fillStyle = '#718096'; ctx.font = '13px system-ui'; ctx.fillText('Choose a model and calculate, or compare both.', 18, 28); plot = null; return; }
    const modes = modelModes(), frequencies = modes.map(b => b.frequencyTHz * CM), sets = {};
    const width = Number($('raman-width')?.value) || 10, options = root.SpectrumView.options();
    for (const key of ['fere', 'cgcnn']) if (models[key]) sets[key] = root.RamanCore.spectrum(models[key].modes, width, { ...options, fullFrequenciesCm: frequencies });
    const resolved = Object.fromEntries(Object.entries(sets).map(([key, rows]) => [key, rows.some(row => row[2] > 0)]));
    const below = Object.keys(sets).filter(key => !resolved[key]);
    $('raman-compare-numerical').textContent = below.length ? below.map(key => LABELS[key]).join(' and ') + ': activity is below numerical resolution; raw values remain in the table.' : '';
    const maxRaw = Math.max(0, ...Object.entries(sets).flatMap(([key, rows]) => resolved[key] ? rows.map(row => row[1]) : [0]));
    const scale = $('raman-compare-normalization').value, left = 58, right = 20, top = 18, bottom = 42;
    const first = Object.values(sets)[0], minX = first[0][0], maxX = first.at(-1)[0];
    const px = x => left + (x - minX) / (maxX - minX) * (w - left - right), py = y => h - bottom - y / 105 * (h - top - bottom);
    ctx.font = '11px system-ui'; ctx.strokeStyle = '#e1e7ee'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'right';
    for (const y of [0, 25, 50, 75, 100]) { ctx.beginPath(); ctx.moveTo(left, py(y)); ctx.lineTo(w - right, py(y)); ctx.stroke(); ctx.fillText(String(y), left - 8, py(y) + 4); }
    for (let i = 0; i <= 4; i++) { const x = minX + (maxX - minX) * i / 4; ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center'; ctx.fillText(x.toFixed(maxX - minX < 10 ? 2 : 0), px(x), h - bottom + 17); }
    ctx.textAlign = 'center'; ctx.fillText('Frequency [cm⁻¹]', w / 2, h - 5); ctx.save(); ctx.beginPath(); ctx.rect(left, top, w - left - right, h - top - bottom); ctx.clip();
    for (const [key, rows] of Object.entries(sets)) { const peak = resolved[key] ? (scale === 'common' ? maxRaw : Math.max(0, ...rows.map(row => row[1]))) : 0; ctx.strokeStyle = COLORS[key]; ctx.lineWidth = 2; ctx.beginPath(); rows.forEach((row, i) => { const y = peak > 0 ? 100 * row[1] / peak : 0; i ? ctx.lineTo(px(row[0]), py(y)) : ctx.moveTo(px(row[0]), py(y)); }); ctx.stroke(); }
    if (selection && Number.isInteger(selection.modeIndex) && selection.qIndex === currentGamma) { const f = frequencies[selection.modeIndex]; ctx.strokeStyle = '#8a5a1f'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(px(f), top); ctx.lineTo(px(f), h - bottom); ctx.stroke(); }
    ctx.restore(); canvas.setAttribute('aria-label', `Fitted BPM and CGCNN Raman comparison, ${scale === 'common' ? 'same scale' : 'each curve scaled'}, ${minX.toFixed(2)} to ${maxX.toFixed(2)} inverse centimeters.`); plot = { minX, maxX, w, h, pad: { l: left, r: right, t: top, b: bottom } };
  }
  function chooseMode(index) {
    if (currentGamma < 0) return;
    if (gammaData(phonons)?.source === 'analytic-gamma') root.PhononBand.selectAnalyticGamma?.(index);
    else root.PhononBand.select(currentGamma, index);
    draw();
  }
  function renderRows() {
    const body = $('raman-compare-rows'), models = visibleResults(); body.replaceChildren();
    if (!models.fere && !models.cgcnn) return;
    const f = models.fere?.modes, c = models.cgcnn?.modes, bands = modelModes();
    for (let i = 0; i < bands.length; i++) {
      const fr = bands[i].frequencyTHz * CM, fa = f?.[i]?.activity, ca = c?.[i]?.activity, tr = document.createElement('tr');
      tr.dataset.mode = String(i); tr.tabIndex = 0;
      tr.innerHTML = `<td>${i + 1}</td><td>${fr.toFixed(3)}</td><td>${Number.isFinite(fa) ? fa.toExponential(3) : '—'}</td><td>${Number.isFinite(ca) ? ca.toExponential(3) : '—'}</td><td>${Number.isFinite(fa) && Math.abs(fa) > 1e-30 && Number.isFinite(ca) ? (ca / fa).toPrecision(3) + '×' : '—'}</td>`;
      tr.onclick = () => chooseMode(i); tr.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseMode(i); } }; body.append(tr);
    }
  }
  function renderIdentity() {
    const models = visibleResults(), lines = [];
    for (const key of ['fere', 'cgcnn']) { const row = models[key]; if (!row) continue; const id = row.identity; lines.push(`${LABELS[key]} · ${key === 'cgcnn' ? 'checkpoint ' + id.checkpointSHA256 : 'RamanDB candidate ' + id.candidateId} · ${id.gammaSource || 'Γ'} · phonon ${id.phononHash}`); }
    if (models['fere-r4']) lines.push('Legacy Environment BPM comparison result is preserved in this project.');
    const failureLines = Object.entries(failuresByPhonon.get(currentHash) || {}).map(([key, message]) => `${LABELS[key] || key} unavailable: ${message}`);
    lines.push(...failureLines); $('raman-compare-failures').textContent = failureLines.join('\n');
    $('raman-compare-identity').textContent = lines.length ? lines.join('\n') : 'No response calculated for this Γ result yet.';
  }
  function render() { renderRows(); renderIdentity(); draw(); serviceLine(); }
  function selected(event) { selection = event.detail || selection; draw(); }

  $('raman-compare-run').onclick = () => calculate($('raman-compare-model').value);
  $('raman-compare-both').onclick = () => calculate('both');
  $('raman-compare-stop').onclick = () => cancelJob(job, true);
  $('raman-compare-normalization').onchange = draw;
  $('raman-model-comparison').addEventListener('change', controls);
  $('raman-compare-plot').onclick = event => {
    if (!plot || currentGamma < 0) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const frequency = plot.minX + (x - plot.pad.l) / (plot.w - plot.pad.l - plot.pad.r) * (plot.maxX - plot.minX);
    const active = modelModes().map((band, i) => ({ i, f: band.frequencyTHz * CM })).filter(mode => mode.f >= 0.1);
    if (!active.length) return;
    chooseMode(active.reduce((a, b) => Math.abs(b.f - frequency) < Math.abs(a.f - frequency) ? b : a).i);
  };
  document.addEventListener('macer-phonon-result', event => { void updatePhonons(event.detail.data); });
  document.addEventListener('macer-phonon-clear', () => { void updatePhonons(null); });
  document.addEventListener('macer-phonon-selection', selected);
  document.addEventListener('macer-spectrum-view-change', draw);
  $('raman-width')?.addEventListener('input', draw);
  root.addEventListener('resize', draw);

  function projectState() { return { schema: 'macer-raman-model-comparison-v1', normalization: $('raman-compare-normalization').value, results: [...resultsByPhonon.entries()].map(([phononHash, models]) => ({ phononHash, models })) }; }
  async function restoreProject(saved) {
    await phononIdentityTask;
    if (!saved) { if (currentHash) resultsByPhonon.delete(currentHash); $('raman-compare-normalization').value = 'common'; render(); controls(); return; }
    if (saved.schema !== 'macer-raman-model-comparison-v1' || !Array.isArray(saved.results) || !['common', 'individual'].includes(saved.normalization)) throw Error('Invalid saved Raman model-comparison data.');
    const restored = new Map();
    for (const entry of saved.results) {
      if (!entry || typeof entry.phononHash !== 'string' || !entry.models || typeof entry.models !== 'object' || restored.has(entry.phononHash)) throw Error('Invalid or duplicate saved Raman comparison result.');
      const models = {};
      // Keep old FERE R4 records readable; new comparisons use the RamanDB-fitted Fitted BPM key.
      for (const key of ['fere', 'fere-r4', 'cgcnn']) {
        const item = entry.models[key]; if (!item) continue;
        const nModes = item.identity?.nModes ?? item.modes?.length, nAtoms = item.identity?.nAtoms ?? nModes / 3;
        if (item.identity?.phononHash !== entry.phononHash || !Array.isArray(item.modes) || !Number.isInteger(nModes) || item.modes.length !== nModes || !Number.isInteger(nAtoms) || nAtoms * 3 !== nModes || item.modes.some((m, i) => m.modeIndex !== i || !Number.isFinite(m.frequencyTHz) || !Number.isFinite(m.activity) || m.activity < 0)) throw Error(`Saved ${key} result does not match its phonon identity or mode data.`);
        if (key === 'cgcnn' && item.identity.checkpointSHA256 !== CGCNN_SHA) throw Error('Saved CGCNN result uses an unknown checkpoint identity.');
        models[key] = item;
      }
      restored.set(entry.phononHash, models);
    }
    resultsByPhonon = restored; $('raman-compare-normalization').value = saved.normalization; render(); controls();
  }
  const api = { projectState, restoreProject, calculate, refresh: render, get service() { return service; } };
  root.RamanModelComparison = Object.freeze(api);
  void checkService();
  if (phonons) void updatePhonons(phonons); else { render(); controls(); }
})(globalThis);
