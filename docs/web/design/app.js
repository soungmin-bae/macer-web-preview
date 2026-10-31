'use strict';
// Structure display is local; energy/force histories come from the WASM engine.
const S = Structures;
const $ = id => document.getElementById(id);
const dof = { positions:true, shape:true, volume:true };
let taskMode='relax';
const sample = 'Si diamond\n1.0\n5.43 0 0\n0 5.43 0\n0 0 5.43\nSi\n8\nDirect\n0 0 0\n0 .5 .5\n.5 0 .5\n.5 .5 0\n.25 .25 .25\n.25 .75 .75\n.75 .25 .75\n.75 .75 .25\n';
const DRAFT_STORAGE_KEY=`macer-browser-relax-draft-v1:${location.pathname}`;
const LAST_VALID_STORAGE_KEY=`macer-browser-relax-valid-v1:${location.pathname}`;
let accepted = null, revision = 0, lastText = '', lastFormat = 'poscar';
let draftState = 'pending', checkTimer = null, atomEditTimer = null, readSeq = 0;
let draftSaveTimer=null;
const EDIT_HISTORY_LIMIT=50;
let editHistory=[],editCursor=-1,restoringEditHistory=false;
let inputProvenance=null;
const runRecords=new Map();
let sessionId=crypto.randomUUID(),inputMaskOverride=null;
let run = null, runNumber = 0, worker = null, workerModelKey = null, workerReadyModelKey = null;
let historyRowsRunId=null,historyRowsCount=0,historyRowElements=[],historySelectedRow=null,historyRenderedSelection=-1;
let workerWasmLinearMemoryBytes = null;
let workerGpuAdapter = null;
let modelLoadMs = null, modelCatalog = null, selectedModel = null, loadNumber = 0;
const localModelFiles = new Map(), localModelFileErrors = new Map();
const localModelFilePending = new Set();
const workerBootstrap = MacerWorkerBootstrap.create({ digest: sha256Hex });
let workerBlobUrl = null;
let timer = null, selected = 0, selectedAtoms=[], selectionOperation='replace', viewerMode='rotate', viewMode = 'input', followLatest = true, editMode = false, historyPlayback = null;
const canvas = $('crystal');
const viewer = CrystalViewer.create(canvas, atomIndex => {
  if(atomIndex<$('atom').options.length){$('atom').value=String(atomIndex);settings();syncAtomEditor();}
}, atomIndex => {
  if(!accepted||timer||viewMode!=='input'||!editMode)return;
  commitAcceptedEdit(`Move atom ${atomIndex+1}`);
}, (atomIndex,position) => {
  if(!accepted||timer||viewMode!=='input'||!editMode)return;
  draftState='pending';
  $('input-status').textContent='Editing · release to apply';$('input-status').className='pill pending';
  $('input-note').textContent=`Moving atom ${atomIndex+1}. Release to apply the edit.`;
  $('atom-edit-note').textContent=`Moving atom ${atomIndex+1}`;
  $('run').disabled=true;syncAtomEditor();updateEditHistoryControls();updateExport();
}, atomIds=>{
  selectedAtoms=atomIds;
  if(atomIds.length){$('atom').value=String(atomIds[0]);selected=atomIds[0];}
  $('selection-count').textContent=`${atomIds.length} input atom${atomIds.length===1?'':'s'} selected`;
  $('fix-selected').disabled=!atomIds.length||timer!==null||viewMode!=='input';$('free-selected').disabled=$('fix-selected').disabled;
  syncAtomEditor();settings();viewer.setSelectionIds(atomIds);
});
let displayRepeats=[1,1,1],viewerStyleOverrides={};
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
async function sha256Hex(value){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
// Inputs stay in this page; projects are opened only by explicit user action.
function scheduleStructureDraftSave(){}
function saveLastValidStructure(){}
function bytesLabel(bytes){return bytes>=1048576?(bytes/1048576).toFixed(2)+' MiB':(bytes/1024).toFixed(1)+' KiB';}
function modelIdentity(model){return Object.fromEntries(['model_id','version','engine_format','model_format','weights_sha256','manifest_sha256','engine_sha256'].map(key=>[key,model[key]]));}
async function validateModelCatalog(catalog){
  if(catalog?.schema_version!=='macer-browser-model-catalog-v1'||!Array.isArray(catalog.models)||!Array.isArray(catalog.in_development))throw new Error('The model catalog has an invalid format.');
  const workerAsset=catalog.runtime_assets?.worker;
  if(!workerAsset)throw new Error('Browser worker asset metadata is missing.');
  const workerUrl=new URL(workerAsset.url,location.href);
  if(workerUrl.origin!==location.origin||!Number.isSafeInteger(workerAsset.size_bytes)||workerAsset.size_bytes<1||!/^[0-9a-f]{64}$/.test(workerAsset.sha256))throw new Error('Browser worker asset metadata is invalid.');
  const ids=new Set();
  for(const model of catalog.models){
    if(!model.model_id||ids.has(model.model_id)||model.status!=='available')throw new Error('Model ID or availability status is invalid.');ids.add(model.model_id);
    if(await sha256Hex(canonical(modelIdentity(model)))!==model.model_key)throw new Error(`${model.model_id} model key does not match its asset metadata.`);
    if(!model.assets||Object.keys(model.assets).length===0)throw new Error(`${model.model_id} has no model assets.`);
    const constructorAssets=model.adapter?.constructor_assets||['manifest','weights'];
    if(!Array.isArray(constructorAssets)||constructorAssets.length===0||constructorAssets.some(name=>typeof name!=='string'||!model.assets[name]))throw new Error(`${model.model_id} is missing required model constructor assets.`);
    for(const [name,asset] of Object.entries(model.assets)){
      if(!Number.isSafeInteger(asset.size_bytes)||asset.size_bytes<0||!/^[0-9a-f]{64}$/.test(asset.sha256))throw new Error(`${model.model_id} ${name} asset metadata is invalid.`);
      if(asset.source==='user-file'){
        if(asset.url!==undefined||asset.size_bytes<1||typeof asset.filename!=='string'||!asset.filename)throw new Error(`${model.model_id} ${name} local file metadata is invalid.`);
      }else{
        if(asset.source!==undefined&&asset.source!=='same-origin')throw new Error(`${model.model_id} ${name} asset source type is unsupported.`);
        const url=new URL(asset.url,location.href);
        if(url.origin!==location.origin)throw new Error(`${model.model_id} ${name} asset origin is invalid.`);
      }
    }
    if(!model.capabilities?.energy||!model.capabilities?.forces||!Array.isArray(model.supported_atomic_numbers)||!Array.isArray(model.supported_atomic_symbols))throw new Error(`${model.model_id} is missing capability metadata.`);
    const testedCase=model.browser_validation?.largest_tested_case;
    if(!testedCase||!Number.isSafeInteger(testedCase.atom_count)||testedCase.atom_count<1||typeof testedCase.structure!=='string'||typeof testedCase.browser!=='string'||typeof testedCase.evidence!=='string')throw new Error(`${model.model_id} is missing browser validation case metadata.`);
  }
  return catalog;
}
async function loadWorkerSource(){
  const asset=modelCatalog.runtime_assets.worker,url=new URL(asset.url,location.href);
  return workerBootstrap.load(asset,url);
}
function destroyWorker(){
  workerBootstrap.abort();
  try{worker?.terminate();}catch{}
  if(workerBlobUrl){URL.revokeObjectURL(workerBlobUrl);workerBlobUrl=null;}
  worker=null;workerModelKey=null;workerReadyModelKey=null;workerWasmLinearMemoryBytes=null;
  workerGpuAdapter=null;
}
function modelBytes(model){return Object.values(model.assets).reduce((sum,asset)=>sum+(asset.transport?.size_bytes??asset.size_bytes),0);}
function updateModelPanel(){
  const model=selectedModel;
  if(!model){$('model-name').textContent='Model unavailable';$('model-state').textContent='Unable to load models';$('model-backend').textContent='—';$('model-description').textContent='';return;}
  const localAssets=Object.entries(model.assets).filter(([,asset])=>asset.source==='user-file');
  const localAssetKey=localAssets.length?`${model.model_key}:${localAssets[0][0]}`:null;
  const localFile=localAssetKey?localModelFiles.get(localAssetKey):null;
  $('model-name').textContent=model.display_name;
  $('model-icon').textContent=model.display_name.startsWith('MatterSim')?'M':'N';
  $('model-backend').textContent=model.backend;
  const notice=$('model-notice');notice.hidden=!model.source?.notice_url;
  if(model.source?.notice_url){const url=new URL(model.source.notice_url,location.href);if(url.origin!==location.origin)throw new Error('Model notices must be served from this origin.');notice.href=url.href;}
  $('model-description').textContent='';
  $('model-validation-scope').textContent='';
  $('model-memory-controls').hidden=!(workerReadyModelKey||workerModelKey);
  $('release-model-memory').disabled=timer!==null;
  $('local-model-file-controls').hidden=localAssets.length===0;
  $('choose-model-file').disabled=timer!==null||!!localAssetKey&&localModelFilePending.has(localAssetKey);
  $('local-model-file-status').textContent=localAssets.length===0?'':localModelFilePending.has(localAssetKey)?'Verifying model file…':localFile?`${localFile.name} · verified`:localModelFileErrors.get(localAssetKey)||`Choose ${localAssets[0][1].filename}`;
  if(workerReadyModelKey===model.model_key)$('model-state').textContent='Ready';
  else if(workerModelKey&&workerModelKey!==model.model_key)$('model-state').textContent='Switches when you run';
  else $('model-state').textContent=localAssets.length?'Choose model file':'Ready to run';
}
async function loadModelCatalog(){
  const response=await fetch('./model-catalog.json',{cache:'no-cache'});
  if(!response.ok)throw new Error(`Could not load the model catalog (${response.status}).`);
  modelCatalog=await validateModelCatalog(await response.json());
  const select=$('model-select');select.replaceChildren();
  for(const model of modelCatalog.models){const option=document.createElement('option');option.value=model.model_key;option.textContent=model.display_name;select.append(option);}
  for(const model of modelCatalog.in_development){const option=document.createElement('option');option.value='';option.disabled=true;option.textContent=model.display_name+' · experimental';select.append(option);}
  selectedModel=modelCatalog.models[0]||null;select.disabled=!selectedModel; if(selectedModel)select.value=selectedModel.model_key;
  updateModelPanel();settings();
}
const activeDof = () => accepted?.cell ? {...dof} : {positions:dof.positions,shape:false,volume:false};
const hasRelaxDof = (active=activeDof()) => !!accepted && (
  active.shape || active.volume || (active.positions && accepted.atoms.some(atom=>(atom.mask||[true,true,true]).some(Boolean)))
);
const formula = s => {
  const counts = new Map();
  s.atoms.forEach(a=>counts.set(a.element,(counts.get(a.element)||0)+1));
  return [...counts].map(([e,n])=>e+(n>1?n:'')).join(' ');
};
function shownStructure() {
  if(viewMode==='result'&&run&&run.history.length)return snapshotStructure(run.history[selected]||run.history.at(-1));
  return accepted;
}
function snapshotStructure(snapshot) {
  return RelaxSession.geometry(run,snapshot);
}
function calculateStructure(s) {
  return {atomic_numbers:s.atoms.map(a=>S.atomicNumber(a.element)),positions_a:s.atoms.map(a=>a.position),
    cell_a:s.cell||[[0,0,0],[0,0,0],[0,0,0]],pbc:s.pbc||[false,false,false]};
}
function lockInputs(busy) {
  document.querySelectorAll('.settings-panel input,.settings-panel select,.settings-panel .toggle button').forEach(x=>x.disabled=busy);
  ['structure','format','browse','reset-input','restore-input','defaults','model-select'].forEach(id=>$(id).disabled=busy||id==='model-select'&&!selectedModel);
  $('task-relax').disabled=busy;$('task-single').disabled=busy;
  $('stop').disabled=!busy;
  settings();
}
function recordEditState(text,format){
  if(restoringEditHistory)return;
  const state={text,format,provenance:clone(inputProvenance),maskOverride:clone(inputMaskOverride)};
  if(JSON.stringify(editHistory[editCursor])===JSON.stringify(state))return;
  editHistory=editHistory.slice(0,editCursor+1);editHistory.push(state);
  if(editHistory.length>EDIT_HISTORY_LIMIT)editHistory.shift();editCursor=editHistory.length-1;
}
function updateEditHistoryControls(){
  const unavailable=timer!==null;
  $('undo-structure').disabled=unavailable||editCursor<=0;
  $('redo-structure').disabled=unavailable||editCursor<0||editCursor>=editHistory.length-1;
}
function restoreEditState(cursor){
  if(timer!==null||cursor<0||cursor>=editHistory.length)return;
  const state=editHistory[cursor],previousIndex=Number($('atom').value||0),previousAtom=accepted?.atoms[previousIndex];
  const previousOccurrence=previousAtom?accepted.atoms.slice(0,previousIndex).filter(atom=>atom.element===previousAtom.element).length:0;
  editCursor=cursor;restoringEditHistory=true;
  readSeq++;clearTimeout(checkTimer);clearTimeout(atomEditTimer);
  inputProvenance=clone(state.provenance||null);inputMaskOverride=clone(state.maskOverride||null);
  $('structure').value=state.text;$('format').value=state.format;
  parseDraft();restoringEditHistory=false;updateEditHistoryControls();
  const atoms=accepted?.atoms||[];let restoredIndex=-1,occurrence=0;
  if(previousAtom){
    restoredIndex=atoms.findIndex(atom=>atom.element===previousAtom.element&&occurrence++===previousOccurrence);
  }
  if(restoredIndex<0&&atoms.length)restoredIndex=Math.min(previousIndex,atoms.length-1);
  if(restoredIndex>=0){$('atom').value=String(restoredIndex);settings();syncAtomEditor();viewer.setSelection(restoredIndex);draw();}
  $('input-note').textContent+=' · edit history applied';
}
function settings() {
  const periodic=accepted?.cell!=null;
  const active=activeDof();
  const dofNames={positions:'atomic positions',shape:'cell shape',volume:'cell volume'};
  document.querySelectorAll('[data-dof]').forEach(group=>{
    const key=group.dataset.dof;
    group.querySelectorAll('button').forEach(b=>{
      const chosen=(b.dataset.value==='optimize')===active[key];
      b.classList.toggle('selected',chosen); b.setAttribute('aria-pressed',String(chosen));
      b.setAttribute('aria-label',`${b.dataset.value==='optimize'?'Optimize':'Fix'} ${dofNames[key]}`);
      b.disabled=timer!==null || (!periodic && key!=='positions');
    });
  });
  const key=[active.positions,active.shape,active.volume].map(Number).join('');
  const modes={'111':'3','100':'2','110':'4','010':'5','011':'6','001':'7','101':'8','000':'—'};
  $('isif').textContent=periodic?'ISIF '+modes[key]:'Nonperiodic · atoms only';
  const canRelax=hasRelaxDof(active);
  const activeLabels=[];
  if(active.positions&&accepted?.atoms.some(atom=>(atom.mask||[true,true,true]).some(Boolean)))activeLabels.push('Positions');
  if(active.shape)activeLabels.push('Shape');
  if(active.volume)activeLabels.push('Volume');
  $('dof-summary').textContent=canRelax?activeLabels.join(' + ')+' optimization':'All degrees of freedom fixed · Relax unavailable';
  const localAssetsReady=!!selectedModel&&Object.entries(selectedModel.assets).filter(([,asset])=>asset.source==='user-file').every(([name])=>{
    const key=`${selectedModel.model_key}:${name}`;return localModelFiles.has(key)&&!localModelFilePending.has(key);
  });
  $('run').disabled=timer!==null || draftState!=='valid' || !selectedModel || !localAssetsReady || (taskMode==='relax'&&!canRelax);
  $('run').textContent=taskMode==='relax'?'▶ Run Relax':'▶ Run Single Point';
  $('task-relax').classList.toggle('selected',taskMode==='relax');$('task-relax').setAttribute('aria-pressed',String(taskMode==='relax'));
  $('task-single').classList.toggle('selected',taskMode==='single_point');$('task-single').setAttribute('aria-pressed',String(taskMode==='single_point'));
  document.querySelectorAll('[data-dof] button').forEach(button=>button.disabled=timer!==null||taskMode==='single_point'||(!periodic&&button.closest('[data-dof]').dataset.dof!=='positions'));
  $('pressure').disabled=timer!==null || !active.volume;
  $('smax').disabled=timer!==null || !periodic;
  $('atom').disabled=timer!==null || !accepted?.atoms.length;
  $('model-select').disabled=timer!==null || !selectedModel;
  updateModelPanel();
  $('constraint-basis').textContent=periodic?'Motion allowed along lattice vectors':'Motion allowed along Cartesian axes';
  $('fix-description').textContent=periodic?'Fix locks a, b, c motion':'Fix locks x, y, z motion';
  const constraintAxes=periodic?['a','b','c']:['x','y','z'];
  document.querySelectorAll('[data-axis]').forEach((input,index)=>{
    const axis=constraintAxes[index];input.setAttribute('aria-label',`Allow motion along ${axis}`);
    const label=document.querySelector(`[data-axis-label="${index}"]`);if(label)label.textContent=axis;
  });
  const atomIndex=Number($('atom').value||0),atom=accepted?.atoms[atomIndex];
  $('selection-count').textContent=`${selectedAtoms.length} input atom${selectedAtoms.length===1?'':'s'} selected`;
  $('fix-selected').disabled=!selectedAtoms.length||timer!==null||viewMode!=='input';$('free-selected').disabled=$('fix-selected').disabled;
  document.querySelectorAll('[data-axis]').forEach(input=>{
    const axis=Number(input.dataset.axis),states=(selectedAtoms.length?selectedAtoms:[atomIndex]).map(index=>accepted?.atoms[index]?.mask?.[axis]??true);input.indeterminate=states.some(value=>value!==states[0]);input.checked=states[0]??true;input.disabled=timer!==null||!atom;
  });
  const editable=draftState==='valid'&&!timer&&viewMode==='input';
  document.querySelectorAll('[id^="atom-"][type="number"]').forEach(input=>input.disabled=!editable||!atom);
  $('focus-atom-coordinates').disabled=!editable||!atom;
  document.querySelectorAll('[id^="cell-"][type="number"],#apply-cell').forEach(input=>input.disabled=!editable||!periodic);
  $('cell-editor').hidden=!periodic;
  viewer.setAtomDragEnabled(draftState==='valid'&&!timer&&viewMode==='input'&&viewerMode==='move');
  updateEditHistoryControls();
  updateExport();
}
function syncAtomEditor(){
  const index=Number($('atom').value||0),atom=shownStructure()?.atoms[index];
  $('selected-atom-label').textContent=atom?`Selected atom coordinates (Å) · ${atom.element} ${index+1}`:'Selected atom coordinates (Å)';
  for(let axis=0;axis<3;axis++){
    const input=$(`atom-${'xyz'[axis]}`),name=`${'xyz'[axis]} Cartesian coordinate`;
    input.value=atom?Number(atom.position[axis]).toFixed(6):'';
    input.setAttribute('aria-label',atom?`${atom.element} atom ${index+1} ${name} in angstroms`:`Atom ${name} in angstroms`);
  }
}
function syncCellEditor(){
  const cell=shownStructure()?.cell;
  for(let row=0;row<3;row++)for(let axis=0;axis<3;axis++)$(`cell-${'abc'[row]}-${'xyz'[axis]}`).value=cell?Number(cell[row][axis]).toFixed(6):'';
}
function serializeAccepted(){
  if(lastFormat==='xyz')return S.toXyz(accepted,accepted.comment);
  if(lastFormat==='cif')return S.toCif(accepted,accepted.comment||'browser structure');
  return S.toPoscar(accepted,accepted.comment);
}
function commitAcceptedEdit(note){
  try{
    const text=serializeAccepted(),format=accepted.format||lastFormat;inputMaskOverride={text,format,masks:accepted.atoms.map(a=>[...(a.mask||[true,true,true])])};recordEditState(text,format);$('structure').value=text;lastText=text;lastFormat=format;revision++;
    scheduleStructureDraftSave();
    accepted.format=lastFormat;draftState='valid';viewMode='input';$('export-source').value='input';
    $('input-status').textContent=`Valid · input r${revision}`;$('input-status').className='pill valid';
    $('input-note').textContent=`${accepted.atoms.length} atoms · ${note} · input r${revision} applied to the viewer and calculations.`;
    $('atom-edit-note').textContent=`${note} · input r${revision}`;syncAtomEditor();syncCellEditor();
    settings();updateResults();renderStructure();
  }catch(error){$('atom-edit-note').textContent=error.message;syncAtomEditor();syncCellEditor();}
}
for(let axis=0;axis<3;axis++)$(`atom-${'xyz'[axis]}`).addEventListener('input',()=>{
  if(!accepted||timer||viewMode!=='input')return;
  clearTimeout(atomEditTimer);draftState='pending';$('run').disabled=true;
  $('input-status').textContent='Editing coordinates · waiting to apply';$('input-status').className='pill pending';
  updateExport();updateResults();
  atomEditTimer=setTimeout(()=>{
    const index=Number($('atom').value),atom=accepted.atoms[index],position=[0,1,2].map(i=>Number($(`atom-${'xyz'[i]}`).value));
    if(!position.every(Number.isFinite)){$('atom-edit-note').textContent='Coordinates must be finite numbers.';draftState='valid';$('input-status').textContent=`Valid · input r${revision}`;$('input-status').className='pill valid';syncAtomEditor();settings();updateResults();return;}
    atom.position=position;commitAcceptedEdit(`Edit atom ${index+1} coordinates`);
  },250);
});
$('apply-cell').onclick=()=>{
  if(!accepted?.cell||timer||draftState!=='valid'||viewMode!=='input')return;
  const cell=Array.from({length:3},(_,row)=>Array.from({length:3},(_,axis)=>Number($(`cell-${'abc'[row]}-${'xyz'[axis]}`).value)));
  if(!cell.flat().every(Number.isFinite)||Math.abs(S.determinant(cell))<1e-10){$('cell-edit-note').textContent='Cell values must be finite and the volume must be nonzero.';syncCellEditor();return;}
  accepted.cell=cell;accepted.pbc=[true,true,true];$('cell-edit-note').textContent='Cell changes applied.';commitAcceptedEdit('Edit lattice cell');
};
function setTask(mode){if(timer)return;taskMode=mode;settings();}
$('task-relax').onclick=()=>setTask('relax');$('task-single').onclick=()=>setTask('single_point');
function parseDraft() {
  clearTimeout(checkTimer); checkTimer=null;
  if(timer) return false;
  try {
    const text=$('structure').value,format=$('format').value;
    const next=S.parse(text,format);
    if(inputMaskOverride?.text===text&&inputMaskOverride.format===format&&inputMaskOverride.masks.length===next.atoms.length){next.atoms.forEach((a,i)=>a.mask=[...inputMaskOverride.masks[i]]);next.selective=next.atoms.some(a=>a.mask.some(v=>!v));}else inputMaskOverride=null;
    saveLastValidStructure(text,format);
    scheduleStructureDraftSave();
    if(!accepted || text!==lastText || format!==lastFormat) revision++;
    if(inputProvenance&&text!==inputProvenance.appliedText)inputProvenance.modified=true;
    recordEditState(text,format);next.provenance=clone(inputProvenance);
    accepted=next; selectedAtoms=[]; lastText=text; lastFormat=format; draftState='valid'; viewMode='input';viewerMode='rotate';editMode=false;
    $('input-status').textContent=`Valid · input r${revision}`;
    $('input-status').className='pill valid';
    $('input-note').textContent=`${next.atoms.length} atoms · input r${revision} applied to the 3D viewer.`+(next.cell?'':' Nonperiodic XYZ.')+(next.atoms.length>400?' Bond lines are hidden above 400 atoms.':'');
    $('structure').setAttribute('aria-invalid','false');
    $('restore-input').hidden=true; $('stale-overlay').hidden=true;
    $('export-source').value='input';
    $('atom').replaceChildren(...next.atoms.map((a,i)=>new Option(`${a.element} ${i+1}`,String(i))));
    syncElementStyleControls(next);
    syncAtomEditor();syncCellEditor();
    updateResults(); settings(); renderStructure(); return true;
  } catch(error) {
    draftState='invalid';
    $('input-status').textContent='Invalid input · Run unavailable'; $('input-status').className='pill invalid';
    $('input-note').textContent=`${error.line?'Line '+error.line+': ':''}${error.message} `+(accepted?`Showing last valid input r${revision}. This draft cannot be used to run.`:'Enter a valid structure to display it.');
    $('structure').setAttribute('aria-invalid','true');
    $('restore-input').hidden=!accepted; $('stale-overlay').hidden=!accepted;
    viewMode='input'; settings(); updateResults(); renderStructure(); return false;
  }
}
function draftChanged() {
  readSeq++; clearTimeout(checkTimer); draftState='pending'; viewMode='input';
  scheduleStructureDraftSave();
  $('input-status').textContent='Editing · validation pending'; $('input-status').className='pill pending';
  $('input-note').textContent='Pause typing to validate the structure. Run is unavailable until validation finishes.';
  $('stale-overlay').hidden=!accepted; $('export-source').value='input';
  settings(); updateResults(); renderStructure();
  checkTimer=setTimeout(parseDraft,250);
}
$('structure').addEventListener('input',draftChanged);
$('format').onchange=draftChanged;
$('undo-structure').onclick=()=>restoreEditState(editCursor-1);
$('redo-structure').onclick=()=>restoreEditState(editCursor+1);
window.addEventListener('keydown',event=>{
  if(!(event.metaKey||event.ctrlKey)||event.altKey)return;
  const target=event.target;
  if(target instanceof HTMLElement&&(target.isContentEditable||target.matches('input,textarea,select,[role="textbox"]')))return;
  const key=event.key.toLowerCase();
  const redo=key==='y'||(key==='z'&&event.shiftKey);
  if(key!=='z'&&key!=='y')return;
  const button=redo?$('redo-structure'):$('undo-structure');
  if(button.disabled)return;
  event.preventDefault();
  restoreEditState(editCursor+(redo?1:-1));
});
$('restore-input').onclick=()=>{readSeq++;$('structure').value=lastText;$('format').value=lastFormat;parseDraft();};
$('reset-input').onclick=()=>{readSeq++;$('structure').value=sample;$('format').value='poscar';parseDraft();};
$('browse').onclick=()=>$('file').click();
$('file').onchange=async()=>{
  const file=$('file').files[0]; if(!file)return;
  draftChanged(); clearTimeout(checkTimer); const ticket=readSeq;
  try {
    const text=await file.text();
    if(ticket!==readSeq || timer)return;
    $('structure').value=text;
    $('format').value=/\.xyz$/i.test(file.name)?'xyz':/\.cif$/i.test(file.name)?'cif':'poscar';
    parseDraft();
  } catch(error) {
    draftState='invalid';$('input-status').textContent='Could not read file';
    $('input-note').textContent='Could not read file: '+error.message;settings();
  }
  $('file').value='';
};

document.querySelectorAll('[data-dof] button').forEach(b=>b.onclick=()=>{
  dof[b.parentElement.dataset.dof]=b.dataset.value==='optimize'; settings();
});
$('defaults').onclick=()=>{
  if(timer)return;
  Object.assign(dof,{positions:true,shape:true,volume:true});
  $('max-steps').value=500;$('fmax').value=.01;$('smax').value=.1;$('pressure').value=0;settings();
};
$('atom').onchange=()=>{selectedAtoms=accepted?.atoms.length?[Number($('atom').value||0)]:[];settings();syncAtomEditor();viewer.setSelection(Number($('atom').value||0));viewer.setSelectionIds(selectedAtoms);};
document.querySelectorAll('[data-axis]').forEach(input=>input.onchange=()=>{
  const ids=selectedAtoms.length?selectedAtoms:[Number($('atom').value||0)];if(!accepted?.atoms.length)return;
  for(const id of ids){const atom=accepted.atoms[id];if(!atom)continue;atom.mask=atom.mask||[true,true,true];atom.mask[Number(input.dataset.axis)]=input.checked;}
  accepted.selective=accepted.atoms.some(a=>a.mask?.some(v=>!v));commitAcceptedEdit(ids.length>1?`Edit constraints for ${ids.length} atoms`:'Edit atom constraints');
});
function graph(id,key,color,threshold=null,scaleMode='linear',unavailable=false) {
  const w=420,h=170,l=58,r=12,t=15,b=28,total=Math.max(0,(run?.history.length||0)-1),xDomain=Math.max(total,1);
  const x=n=>l+n/xDomain*(w-l-r),raw=run?.history.map(item=>key==='e'?item.evaluation.energy_ev:key==='f'?item.max_force_ev_per_a:item.max_stress_residual_gpa)||[];
  const transform=scaleMode==='log'?v=>Math.log10(Math.max(v,1e-12)):v=>v;
  const valid=raw.filter(Number.isFinite).map(transform),limit=Number.isFinite(threshold)?transform(threshold):null;
  if(unavailable){$(id).innerHTML='<text x="210" y="84" text-anchor="middle" fill="#9aa7b5" font-size="11">Not applicable · cell fixed</text>';return;}
  if(!raw.length){$(id).innerHTML='<text x="210" y="84" text-anchor="middle" fill="#9aa7b5" font-size="11">Run to see model evaluations</text>';return;}
  const domain=valid.concat(limit==null?[]:[limit]),low=Math.min(...domain),high=Math.max(...domain);
  const pad=high===low?Math.max(Math.abs(high)*.08,scaleMode==='log'?.25:1e-7):(high-low)*.08;
  const min=low-pad,max=high+pad,yv=v=>t+(max-transform(v))/(max-min)*(h-t-b),yDomain=v=>t+(max-v)/(max-min)*(h-t-b);
  const format=v=>scaleMode==='log'?`1e${Math.round(v)}`:key==='f'||key==='s'?Number(v).toExponential(1):Number(v).toFixed(Math.abs(max-min)<.01?5:2);
  let svg='';
  for(let i=0;i<4;i++){const val=min+(max-min)*i/3,yy=yDomain(val);svg+=`<line x1="${l}" y1="${yy}" x2="${w-r}" y2="${yy}" stroke="#e8edf3"/><text x="${l-7}" y="${yy+3}" text-anchor="end" fill="#98a4b3" font-size="9">${format(scaleMode==='log'?val:val)}</text>`;}
  if(limit!=null){const yy=yv(threshold);svg+=`<line x1="${l}" y1="${yy}" x2="${w-r}" y2="${yy}" stroke="#b88839" stroke-dasharray="5 3"/><text x="${l+5}" y="${Math.max(t+9,yy-3)}" text-anchor="start" fill="#a47a36" font-size="8">limit ${format(threshold)}</text>`;}
  for(const n of [...new Set(Array.from({length:5},(_,i)=>Math.round(xDomain*i/4)))])svg+=`<text x="${x(n)}" y="${h-10}" text-anchor="middle" fill="#98a4b3" font-size="9">${n}</text>`;
  let segment=[];const flush=()=>{if(segment.length>1)svg+=`<polyline points="${segment.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;segment=[];};
  raw.forEach((v,n)=>{if(!Number.isFinite(v)){flush();return;}segment.push(`${x(n)},${yv(v)}`);});flush();
  const selectedValue=raw[selected];if(Number.isFinite(selectedValue))svg+=`<line x1="${x(selected)}" x2="${x(selected)}" y1="${t}" y2="${h-b}" stroke="#bdcbd9" stroke-dasharray="3 3"/><circle cx="${x(selected)}" cy="${yv(selectedValue)}" r="3" fill="${color}"/>`;
  $(id).innerHTML=svg;
}
function updateHistoryRows(){
  const body=$('history-rows'),history=run?.history||[],runId=run?.id??null;
  if(historyRowsRunId!==runId||history.length<historyRowsCount){
    body.replaceChildren();historyRowsRunId=runId;historyRowsCount=0;historyRowElements=[];historySelectedRow=null;historyRenderedSelection=-1;
  }
  for(let index=historyRowsCount;index<history.length;index++){
    const item=history[index],prev=history[Math.max(index-1,0)];
    const volume=item.structure.pbc.some(Boolean)?Math.abs(S.determinant(item.structure.cell_a)).toFixed(3):'—';
    const energy=item.evaluation.energy_ev,delta=energy-prev.evaluation.energy_ev;
    const row=document.createElement('tr');row.dataset.historyIndex=String(index);row.tabIndex=0;row.setAttribute('aria-label',`Select step ${item.step}`);
    row.innerHTML=`<td>${item.step}</td><td>${energy.toFixed(6)}</td><td>${delta.toFixed(6)}</td><td>${item.max_force_ev_per_a.toExponential(3)}</td><td>${item.max_stress_residual_gpa==null?'—':item.max_stress_residual_gpa.toFixed(4)}</td><td>${volume}</td>`;
    body.append(row);historyRowElements[index]=row;
  }
  historyRowsCount=history.length;
  if(historyRenderedSelection!==selected){
    historySelectedRow?.classList.remove('current');historySelectedRow=historyRowElements[selected]||null;
    historySelectedRow?.classList.add('current');historyRenderedSelection=selected;
  }
}
function updateRunSummary(){
  const panel=$('run-summary'),history=run?.history||[];
  if(timer!==null||history.length===0){panel.hidden=true;return;}
  const first=history[0],last=history.at(-1),periodic=first.structure.pbc.some(Boolean)&&last.structure.pbc.some(Boolean);
  const labels={converged:'Converged',max_steps:'Step limit reached',stopped:'Stopped by user',failed:'Failed',single_point:'Single point complete'};
  const energyDelta=last.evaluation.energy_ev-first.evaluation.energy_ev;
  $('summary-status').textContent=`Run ${run.id} · input r${run.revision} · ${labels[run.state]||run.state}`;
  $('summary-energy').textContent=`${first.evaluation.energy_ev.toFixed(5)} → ${last.evaluation.energy_ev.toFixed(5)} eV (Δ ${energyDelta>=0?'+':''}${energyDelta.toFixed(5)} eV)`;
  $('summary-force').textContent=`${last.max_force_ev_per_a.toExponential(3)} eV/Å · limit ${run.settings.forceTolerance} eV/Å`;
  const cellRelax=!!(run.settings.dof?.shape||run.settings.dof?.volume);
  $('summary-stress').textContent=cellRelax&&last.max_stress_residual_gpa!=null?`${last.max_stress_residual_gpa.toExponential(3)} GPa · limit ${run.settings.stressTolerance} GPa`:'Not applicable';
  if(periodic){
    const initialVolume=Math.abs(S.determinant(first.structure.cell_a)),finalVolume=Math.abs(S.determinant(last.structure.cell_a));
    const deltaVolume=finalVolume-initialVolume,percent=initialVolume?deltaVolume/initialVolume*100:0;
    const maxCellDelta=Math.max(...last.structure.cell_a.flatMap((vector,row)=>vector.map((value,column)=>Math.abs(value-first.structure.cell_a[row][column]))));
    $('summary-volume').textContent=`${initialVolume.toFixed(4)} → ${finalVolume.toFixed(4)} Å³ (Δ ${deltaVolume>=0?'+':''}${deltaVolume.toFixed(4)} Å³, ${percent>=0?'+':''}${percent.toFixed(3)}%)`;
    $('summary-cell').textContent=`${maxCellDelta.toExponential(2)} Å maximum vector-component change`;
  }else{$('summary-volume').textContent='Not applicable · nonperiodic';$('summary-cell').textContent='Not applicable · nonperiodic';}
  $('summary-steps').textContent=`${history.length} snapshots · ${Math.max(0,history.length-1)} updates (Step ${first.step}–${last.step})`;
  $('summary-time').textContent=`${(run.elapsed/1000).toFixed(2)} s`;
  panel.hidden=false;
}
function updateConvergence(){
  const latest=run?.history.at(-1),panel=$('convergence-panel');
  panel.hidden=!latest||run.settings.task==='single_point';
  $('viewer-criterion-note').textContent='';
  if(panel.hidden)return;
  const forceLimit=run.settings.forceTolerance,stressLimit=run.settings.stressTolerance;
  const forceMet=latest.max_force_ev_per_a<=forceLimit;
  const cellRelax=!!(run.settings.dof.shape||run.settings.dof.volume)&&latest.structure.pbc.some(Boolean);
  const stress=latest.max_stress_residual_gpa,stressMet=!cellRelax||(Number.isFinite(stress)&&stress<=stressLimit);
  const value=n=>Number.isFinite(n)?(Math.abs(n)<.001?n.toExponential(2):Number(n.toPrecision(4)).toString()):'—';
  $('criteria-step').textContent=`Latest Step ${latest.step}`;
  $('force-criterion').textContent=`Force ${value(latest.max_force_ev_per_a)} / ${value(forceLimit)} eV/Å · ${forceMet?'met':'pending'}`;
  $('force-criterion').dataset.state=forceMet?'met':'pending';
  $('stress-criterion').textContent=cellRelax?`Cell stress ${value(stress)} / ${value(stressLimit)} GPa · ${stressMet?'met':'pending'}`:'Cell fixed · stress not required';
  $('stress-criterion').dataset.state=cellRelax?(stressMet?'met':'pending'):'na';
  const message=forceMet&&!stressMet?'Force target met; cell stress is still above its limit.':!forceMet&&stressMet?(cellRelax?'Cell stress target met; atomic forces are still above their limit.':'Atomic forces are still above their limit.'):forceMet&&stressMet?(cellRelax?'Force and cell stress targets met.':'Force target met.'):'Atomic forces and cell stress are still above their limits.';
  $('convergence-note').textContent=message;
  $('viewer-criterion-note').textContent=`Latest Step ${latest.step}: ${message}`;
}
function updateViewerTimeline(){
  const available=!!run?.history.length,snapshot=run?.history[selected];
  $('viewer-timeline').hidden=!available;$('show-result-structure').disabled=!available;
  $('show-input-structure').setAttribute('aria-pressed',String(viewMode==='input'));
  $('show-result-structure').setAttribute('aria-pressed',String(viewMode==='result'));
  $('atom-lock-label').textContent=viewMode==='result'?'Result · read only':viewerMode==='move'?'Atom dragging enabled':viewerMode==='select'?`${selectedAtoms.length} atoms selected`:'Atoms locked';
  $('atom-lock-label').dataset.state=viewerMode==='move'&&viewMode==='input'?'editing':'locked';
  if(!available)return;
  const last=run.history.at(-1),viewing=viewMode==='input'?'Input structure':`Viewing Step ${snapshot.step} of ${last.step}`;
  const execution=timer?(followLatest?'Following latest':'History view · calculation continues'):run.state==='stopped'?`Stopped at Step ${last.step}`:run.state==='failed'?`Failed after Step ${last.step}`:run.state==='converged'?'Converged':'Result history';
  $('viewer-frame-state').textContent=viewMode==='input'?(editMode?'Input · atom dragging enabled':'Input · atoms locked'):`${execution} · read only`;
  $('viewer-step-metrics').textContent=viewMode==='input'?`Input · ${accepted?.atoms.length||0} atoms`:`${viewing} · E ${snapshot.evaluation.energy_ev.toFixed(5)} eV · Fmax ${snapshot.max_force_ev_per_a.toExponential(2)} eV/Å`+(snapshot.max_stress_residual_gpa==null?'':` · cell stress ${Number(snapshot.max_stress_residual_gpa.toPrecision(4))} GPa`);
  $('history').setAttribute('aria-valuetext',`Step ${snapshot.step} of ${last.step}`);
}
function updateResults() {
  updateRunSelector();
  const stale=run&&(run.revision!==revision || draftState!=='valid');
  $('status').className='status '+(timer?'running':run?.state==='stopped'?'stopped':'');
  const labels={running:'Running',converged:'Converged',max_steps:'Step limit reached',stopped:'Stopped by user',failed:'Failed',loading:'Loading model',single_point:'Single point complete'};
  $('status').textContent=!run?'Not started':stale?'Previous run · input has changed':labels[run.state]||'Running';
  const snapshot=run?.history[selected];
  $('run-bar-status').textContent=!run?'Ready':stale?'Previous run · input changed':labels[run.state]||'Running';
  $('run-bar-step').textContent=snapshot?'Step '+snapshot.step+(run?.history.length?` / ${run.history.at(-1).step}`:''):'No steps';
  $('step').textContent=snapshot?snapshot.step:'—';$('step-max').textContent=run?'/ '+run.limit:'';
  $('energy').textContent=snapshot?snapshot.evaluation.energy_ev.toFixed(5):'—';
  $('force').textContent=snapshot?snapshot.max_force_ev_per_a.toFixed(5):'—';
  const cellRelax=!!(run?.settings.dof?.shape||run?.settings.dof?.volume);
  $('stress-residual').textContent=!run?'—':!cellRelax?'N/A':snapshot?.max_stress_residual_gpa==null?'—':snapshot.max_stress_residual_gpa.toFixed(3);
  $('elapsed').textContent=run?(run.elapsed/1000).toFixed(1)+' s':'—';
  $('model-load-time').textContent=modelLoadMs==null?'—':modelLoadMs.toFixed(1)+' ms';
  $('step-time').textContent=snapshot?.evaluation_time_ms==null?'—':snapshot.evaluation_time_ms.toFixed(1)+' ms';
  $('history').disabled=!run?.history.length;$('latest').disabled=!run?.history.length;
  const lastIndex=(run?.history.length||0)-1;
  $('history-prev').disabled=lastIndex<=0||selected<=0;
  $('history-next').disabled=lastIndex<=0||selected>=lastIndex;
  $('history-play').disabled=lastIndex<=0;
  $('history-play').textContent=historyPlayback?'Pause':'Play';
  $('new-steps').hidden=followLatest||selected>=lastIndex;
  $('download-trajectory').disabled=!run?.history.length;
  $('history').max=Math.max(0,lastIndex);$('history').value=selected;
  $('history-label').textContent=snapshot?'Step '+snapshot.step:'Not started';
  graph('energy-chart','e','#c39137');
  graph('force-chart','f','#3b89be',run?.settings.forceTolerance??null,$('force-scale').value);
  graph('stress-chart','s','#8b68a8',cellRelax?run?.settings.stressTolerance??null:null,'linear',!!run&&(!cellRelax||!snapshot?.structure.pbc.some(Boolean)));
  if(snapshot&&snapshot.structure.pbc.some(Boolean)){
    const stress=snapshot.evaluation.stress_ev_per_a3,scale=160.21766208;
    const components=[['xx',stress[0][0]],['yy',stress[1][1]],['zz',stress[2][2]],['yz',(stress[1][2]+stress[2][1])/2],['xz',(stress[0][2]+stress[2][0])/2],['xy',(stress[0][1]+stress[1][0])/2]];
    $('stress-readout').innerHTML='Stress (GPa) · '+components.map(([name,value])=>`<span>${name} ${((value*scale)).toFixed(3)}</span>`).join('');
  }else $('stress-readout').textContent=snapshot?'Nonperiodic · stress not applicable':'Stress (GPa) · Shown after evaluation';
  updateRunSummary();updateConvergence();updateViewerTimeline();
  const historyWrap=$('history-rows').closest('.step-table-wrap');
  const wasAtLatest=historyWrap.scrollHeight-historyWrap.scrollTop-historyWrap.clientHeight<8;
  updateHistoryRows();
  if(followLatest&&wasAtLatest)historyWrap.scrollTop=historyWrap.scrollHeight;
  updateExport();
}
function finish(state) {
  if(!run||timer===null)return;
  const discard=state==='stopped'||state==='failed';
  if(discard){try{worker?.postMessage({type:'stop',loadId:run.loadId,runId:run.id,inputRevision:run.revision,modelKey:run.modelKey});}catch{}destroyWorker();}
  timer=null;run.state=state;editMode=false;viewerMode='rotate';
  run.elapsed=performance.now()-run.began;
  if(run.history.length){
    if(followLatest){selected=run.history.length-1;viewMode='result';$('export-source').value='result';}
    const completionLabels={converged:'converged',max_steps:'step limit reached',stopped:'stopped by user',failed:'failed',single_point:'single point complete'};
    $('run-note').textContent=`Run ${run.id} · input r${run.revision} · preserved complete Step ${run.history.at(-1).step}. Status: ${completionLabels[state]||state}.`;
    const last=run.history.at(-1);
    if(run.model.adapter.runtime_backend==='webgpu'&&last.evaluation_backend==='cpu-final-audit')$('run-note').textContent+=last.cpu_final_audit?.passed?' Final CPU convergence check passed.':' Final CPU convergence check failed.';
    if(run.model.adapter.runtime_backend==='webgpu'&&last.evaluation_backend==='cpu-refinement')$('run-note').textContent+=' CPU refinement was applied after GPU evaluation.';
  }else{
    selected=0;viewMode='input';editMode=false;viewerMode='rotate';$('export-source').value='input';
    $('run-note').textContent=state==='failed'?'Could not start calculation. The last valid input is preserved.':'Stopped before the first complete evaluation. No result snapshot is available.';
  }
  lockInputs(false);updateResults();renderStructure();updateModelPanel();
}
$('model-select').onchange=()=>{
  const key=$('model-select').value;
  selectedModel=modelCatalog?.models.find(model=>model.model_key===key)||null;
  modelLoadMs=null;updateModelPanel();settings();
};
$('choose-model-file').onclick=()=>{
  if(timer!==null||!selectedModel)return;
  $('model-file').click();
};
$('model-file').onchange=async()=>{
  const file=$('model-file').files?.[0];
  const model=selectedModel;
  if(!file||!model)return;
  const [assetName,asset]=Object.entries(model.assets).find(([,candidate])=>candidate.source==='user-file')||[];
  if(!assetName){$('local-model-file-status').textContent='This model does not require a local weights file.';$('model-file').value='';return;}
  const fileKey=`${model.model_key}:${assetName}`;
  localModelFiles.delete(fileKey);localModelFileErrors.delete(fileKey);localModelFilePending.add(fileKey);
  $('choose-model-file').disabled=true;
  $('local-model-file-status').textContent=`${file.name} · verifying size and SHA-256`;
  settings();
  try{
    if(file.size!==asset.size_bytes)throw new Error(`File size mismatch. Required size: ${asset.size_bytes.toLocaleString()} bytes.`);
    const bytes=await file.arrayBuffer();
    const digest=await sha256Hex(bytes);
    if(digest!==asset.sha256)throw new Error('File SHA-256 does not match the selected model.');
    if(selectedModel?.model_key!==model.model_key)return;
    localModelFiles.set(fileKey,file);
    localModelFileErrors.delete(fileKey);
    $('local-model-file-status').textContent=`${file.name} · verified against pinned SHA-256`;
    $('run-note').textContent=`${model.display_name} weights were verified in the browser. Select Run to load them.`;
  }catch(error){
    localModelFiles.delete(fileKey);localModelFileErrors.set(fileKey,`${file.name} · ${error.message}`);
    $('local-model-file-status').textContent=localModelFileErrors.get(fileKey);
    $('run-note').textContent='Could not use local model file: '+error.message;
  }finally{
    localModelFilePending.delete(fileKey);
    $('model-file').value='';
    updateModelPanel();settings();
  }
};
loadModelCatalog().catch(error=>{
  modelCatalog=null;selectedModel=null;$('model-select').disabled=true;
  $('model-select').replaceChildren(new Option('Model catalog error',''));
  updateModelPanel();settings();$('run-note').textContent='Could not load the model catalog: '+error.message;
});
$('run').onclick=async()=>{
  if(globalThis.PhononJob?.running){$('run-note').textContent='Stop the active Phonons calculation first.';return;}
  if(timer || !parseDraft())return;
  if(!selectedModel){$('run-note').textContent='No model is available to run.';return;}
  const atomNumbers=accepted.atoms.map(atom=>S.atomicNumber(atom.element));
  if(atomNumbers.some(number=>!selectedModel.supported_atomic_numbers.includes(number))){
    $('run-note').textContent=`${selectedModel.display_name} does not support one or more elements in this structure.`;return;
  }
  const periodic=!!accepted.cell;
  if(periodic&&!selectedModel.capabilities.periodic||!periodic&&!selectedModel.capabilities.nonperiodic){
    $('run-note').textContent=`${selectedModel.display_name} does not support this periodic boundary configuration.`;return;
  }
  const limit=Number($('max-steps').value);
  if(!Number.isInteger(limit)||limit<1||limit>500){$('run-note').textContent='Maximum steps must be an integer from 1 to 500.';return;}
  const forceTolerance=Number($('fmax').value),pressure=Number($('pressure').value);
  const stressTolerance=Number($('smax').value);
  if(!Number.isFinite(forceTolerance)||forceTolerance<=0||!Number.isFinite(stressTolerance)||stressTolerance<=0||!Number.isFinite(pressure)){$('run-note').textContent='Force and stress tolerances must be positive; pressure must be finite.';return;}
  if(pressure!==0&&!activeDof().volume){$('run-note').textContent='External pressure requires cell-volume optimization.';return;}
  const dofs=activeDof();
  if(taskMode==='relax'&&!hasRelaxDof(dofs)){$('run-note').textContent='No degrees of freedom are enabled. Choose Single point instead.';return;}
  const reusableWasmMemory=workerReadyModelKey===selectedModel.model_key&&Number.isSafeInteger(workerWasmLinearMemoryBytes)&&workerWasmLinearMemoryBytes>0;
  run={id:++runNumber,loadId:++loadNumber,revision,input:clone(accepted),model:clone(selectedModel),modelKey:selectedModel.model_key,settings:{task:taskMode,dof:dofs,optimizer:$('optimizer').value,forceTolerance,stressTolerance,pressure,maxSteps:limit},history:[],wasm_linear_memory_samples:reusableWasmMemory?[{event:'worker-reuse',step:null,bytes:workerWasmLinearMemoryBytes}]:[],step:0,limit,state:'loading',started_at_utc:new Date().toISOString(),began:performance.now(),elapsed:0};
  run.session_id=sessionId;run.parent=inputProvenance?.relaxOrigin?{...clone(inputProvenance.relaxOrigin),input_modified:!!inputProvenance.modified}:null;
  runRecords.set(run.id,run);
  run.backend=selectedModel.adapter.runtime_backend==='webgpu'?'webgpu-evaluation-wasm-graph':'cpu-wasm';
  run.gpu_adapter=workerReadyModelKey===run.modelKey?workerGpuAdapter:null;
  selected=0;followLatest=true;viewMode='result';editMode=false;viewerMode='rotate';$('export-source').value='result';
  const settings={max_steps:limit,fmax_ev_per_a:forceTolerance,smax_gpa:stressTolerance,pressure_gpa:pressure,
    optimize_positions:dofs.positions,optimize_cell_shape:dofs.shape,optimize_cell_volume:dofs.volume,
    fractional_constraints:!!accepted.cell,movable:accepted.atoms.map(atom=>atom.mask||[true,true,true])};
  const nativeStructure=calculateStructure(accepted);
  const needsModel=!worker||workerReadyModelKey!==run.modelKey;
  const thisRunId=run.id;
  viewerMode='rotate';editMode=false;if(needsModel){destroyWorker();timer={pending:true};}else timer=worker;
  updateModelPanel();
  const handleWorkerMessage=({data})=>{
    if(!run||timer===null||(data.modelKey&&data.modelKey!==run.modelKey)||(data.runId!=null&&data.runId!==run.id)||(data.inputRevision!=null&&data.inputRevision!==run.revision)||(data.loadId!=null&&data.loadId!==run.loadId))return;
    if(Number.isSafeInteger(data.wasmLinearMemoryBytes)&&data.wasmLinearMemoryBytes>0){
      workerWasmLinearMemoryBytes=data.wasmLinearMemoryBytes;
      run.wasm_linear_memory_samples.push({event:data.type,step:Number.isSafeInteger(data.step)?data.step:null,bytes:data.wasmLinearMemoryBytes});
    }
    if(data.type==='model-progress'){
      const label=data.phase==='downloading'?`Downloading model assets · ${bytesLabel(data.downloaded_bytes||0)} / ${bytesLabel(data.total_bytes||0)}`:data.phase==='verifying'?'Verifying downloaded SHA-256':data.phase==='verifying-local-file'?'Verifying selected local model file':data.phase==='loading-engine'?'Loading model WASM engine':'Loading model weights';
      $('model-state').textContent=label;$('run-note').textContent=`${run.model.display_name} · ${label}`;
    }else if(data.type==='ready'){
      workerModelKey=run.modelKey;workerReadyModelKey=run.modelKey;
      modelLoadMs=data.modelLoadMs;run.model_load_ms=modelLoadMs;
      workerGpuAdapter=data.gpuAdapter??null;run.gpu_adapter=workerGpuAdapter;
      run.backend=data.backend||run.backend;run.gpu_prepare_ms=data.gpuPrepareMs??null;
      updateModelPanel();
      startWorkerCalculation();
    }else if(data.type==='step'||data.type==='batch'){
      if(data.inputRevision!==run.revision)return;
      const snapshots=data.type==='batch'?data.snapshots:[data.snapshot];
      for(const snapshot of snapshots)run.history.push({...snapshot,runId:data.runId,inputRevision:data.inputRevision,
        evaluation_time_ms:data.type==='step'?data.evaluationMs:null,
        gpu_batch_timing:snapshot.gpu_batch_timing??null});
      const latest=snapshots.at(-1);if(!latest)return;
      if(run.history.length===snapshots.length)$('run-note').textContent='';
      run.step=latest.step;run.elapsed=performance.now()-run.began;
      if(followLatest){selected=run.history.length-1;viewMode='result';$('export-source').value='result';}run.state='running';
      if(latest.status!=='running')finish(latest.status==='converged'?'converged':'max_steps');
      else{
        updateResults();renderStructure();
        if(run.model.adapter.runtime_backend==='webgpu')worker?.postMessage({type:'continue',loadId:run.loadId,runId:run.id,inputRevision:run.revision,modelKey:run.modelKey,step:latest.step});
      }
    }else if(data.type==='finished'){
      if(timer)finish(data.state==='converged'?'converged':'max_steps');
    }else if(data.type==='evaluation'){
      if(data.inputRevision!==run.revision)return;
      const evaluation=data.evaluation,maxForce=evaluation.forces_ev_per_a.map(f=>Math.hypot(...f)).reduce((a,b)=>Math.max(a,b),0);
      run.history.push({step:0,runId:data.runId,inputRevision:data.inputRevision,structure:data.structure,evaluation,max_force_ev_per_a:maxForce,status:'converged',evaluation_time_ms:data.evaluationMs,evaluation_backend:data.evaluationBackend,gpu_timing:data.gpuTiming});
      run.step=0;finish('single_point');
    }else if(data.type==='cache-warning'){
      $('run-note').textContent=data.message+' This session can continue, but offline reuse is not guaranteed.';
    }else if(data.type==='error'){
      finish('failed');$('run-note').textContent='Browser calculation error: '+data.message;
    }
  };
  const handleWorkerError=event=>{const detail=event.message||'WASM calculation error';finish('failed');$('run-note').textContent='Worker error: '+detail;};
  const handleWorkerMessageError=()=>{finish('failed');$('run-note').textContent='Could not read the result sent by the worker.';};
  lockInputs(true);updateResults();renderStructure();
  $('run-note').textContent=`Run ${run.id} · input r${revision} and relax settings are locked. Loading the model in your browser.`;
  if(needsModel){
    try{
      const source=await loadWorkerSource();
      if(!run||run.id!==thisRunId||timer===null)return;
      const providedAssets={};
      for(const [assetName,asset] of Object.entries(run.model.assets)){
        if(asset.source!=='user-file')continue;
        const file=localModelFiles.get(`${run.modelKey}:${assetName}`);
        if(!file)throw new Error(`${asset.filename} local weights file must be selected.`);
        providedAssets[assetName]=await file.arrayBuffer();
      }
      if(!run||run.id!==thisRunId||timer===null)return;
      workerBlobUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
      worker=new Worker(workerBlobUrl);
      timer=worker;
      workerModelKey=null;workerReadyModelKey=null;
      worker.onmessage=handleWorkerMessage;worker.onerror=handleWorkerError;worker.onmessageerror=handleWorkerMessageError;
      worker.postMessage({type:'loadModel',loadId:run.loadId,runId:run.id,inputRevision:run.revision,modelKey:run.modelKey,model:run.model,assetBase:new URL('./',location.href).href,providedAssets},Object.values(providedAssets));
    }catch(error){
      if(run&&run.id===thisRunId&&timer!==null){finish('failed');$('run-note').textContent='Browser calculation asset error: '+error.message;}
    }
  }else{
    worker.onmessage=handleWorkerMessage;worker.onerror=handleWorkerError;worker.onmessageerror=handleWorkerMessageError;
    startWorkerCalculation();
  }
  function startWorkerCalculation(){
    if(!run||!timer||timer!==worker)return;
    run.state='running';
    $('run-note').textContent=`Evaluating initial structure · ${run.input.atoms.length.toLocaleString()} atoms`;
    updateResults();
    const envelope={loadId:run.loadId,runId:run.id,inputRevision:run.revision,modelKey:run.modelKey,modelId:run.model.model_id,structure:nativeStructure};
    if(taskMode==='single_point')worker.postMessage({type:'evaluate',...envelope});
    else worker.postMessage({type:'start',...envelope,settings,waitForStepAcknowledgement:run.model.adapter.runtime_backend==='webgpu'});
  }
};
$('stop').onclick=()=>finish('stopped');
$('release-model-memory').onclick=()=>{
  if(timer!==null||(!worker&&!workerReadyModelKey&&!workerModelKey))return;
  const preserved=!!run?.history.length;
  destroyWorker();modelLoadMs=null;
  $('model-load-time').textContent='—';
  updateModelPanel();updateResults();
  $('run-note').textContent='Model unloaded.';
};
function selectHistory(index){if(!run?.history.length)return;editMode=false;viewerMode='rotate';selected=Math.max(0,Math.min(index,run.history.length-1));followLatest=selected===run.history.length-1;viewMode='result';$('export-source').value='result';settings();updateResults();renderStructure();}
$('history').oninput=()=>{if(historyPlayback){clearInterval(historyPlayback);historyPlayback=null;}selectHistory(Number($('history').value));};
$('history-rows').addEventListener('click',event=>{const row=event.target.closest('tr[data-history-index]');if(!row||!run)return;selectHistory(Number(row.dataset.historyIndex));});
$('history-rows').addEventListener('keydown',event=>{if(event.key!=='Enter'&&event.key!==' ')return;const row=event.target.closest('tr[data-history-index]');if(!row||!run)return;event.preventDefault();row.click();});
$('history-prev').onclick=()=>selectHistory(selected-1);
$('history-next').onclick=()=>selectHistory(selected+1);
$('new-steps').onclick=()=>selectHistory((run?.history.length||1)-1);
$('latest').onclick=()=>selectHistory((run?.history.length||1)-1);
$('history-play').onclick=()=>{if(historyPlayback){clearInterval(historyPlayback);historyPlayback=null;updateResults();return;}historyPlayback=setInterval(()=>{if(!run?.history.length||selected>=run.history.length-1){clearInterval(historyPlayback);historyPlayback=null;updateResults();return;}selectHistory(selected+1);},650);updateResults();};
$('force-scale').onchange=()=>{graph('force-chart','f','#3b89be',run?.settings.forceTolerance??null,$('force-scale').value);};
function exportStructure(){return $('export-source').value==='result'?run?.history[selected]&&snapshotStructure(run.history[selected]):accepted;}
function updateExport(){
  const result=$('export-source').options[1];result.disabled=!run;
  result.disabled=!run?.history.length;
  result.textContent=run?.history.length?`Run ${run.id} · input r${run.revision} · Step ${run.history[selected]?.step??'—'}`:'Calculated result · Not run';
  const fromResult=$('export-source').value==='result',s=exportStructure();
  const blocked=!s||(!fromResult&&draftState!=='valid');
  $('export-step').textContent=fromResult&&run?`Run ${run.id} · Step ${run.history[selected]?.step??'—'}`:`Input r${revision}`;
  document.querySelectorAll('[data-format]').forEach(b=>b.disabled=blocked||(!s?.cell&&b.dataset.format!=='xyz'));
  $('reuse-selected-step').disabled=timer!==null||!run?.history.length;
  $('reuse-selected-step').textContent=run?.history.length?`Use step ${run.history[selected]?.step??run.history.at(-1).step} as input`:'Use selected step as input';
  $('reuse-final-step').disabled=timer!==null||!run?.history.length;
  $('reuse-final-step').textContent=RelaxSession.action(run?.state);
}
$('export-source').onchange=()=>{viewMode=$('export-source').value;updateExport();renderStructure();};
function updateRunSelector(){
  const select=$('run-selector');
  if(select.options.length!==runRecords.size||select.dataset.active!==String(run?.id||'')||select.dataset.busy!==String(timer!==null)){
    select.replaceChildren(...[...runRecords.values()].map(r=>new Option(`Run ${r.id}${r.parent?` ← Run ${r.parent.run_id}, Step ${r.parent.step}`:''}`,String(r.id))));
    select.value=String(run?.id||'');select.dataset.active=String(run?.id||'');select.dataset.busy=String(timer!==null);
  }
  select.disabled=timer!==null||runRecords.size<2;
  $('save-relax-project').disabled=timer!==null||runRecords.size===0;
  $('open-relax-project').disabled=timer!==null;
}
function applyRunStructure(index){
  if(timer!==null||!run?.history.length)return;
  const snapshot=run.history[index];if(!snapshot)return;
  const structure=snapshotStructure(snapshot),format=structure.cell?'poscar':'xyz';
  const text=format==='poscar'?S.toPoscar(structure,`Run ${run.id} Step ${snapshot.step}`):S.toXyz(structure,`Run ${run.id} Step ${snapshot.step}`);
  // Capture the actual text, including an unfinished invalid draft, before replacing it.
  recordEditState($('structure').value,$('format').value);
  inputProvenance={provider:'macer-relax',relaxOrigin:{session_id:run.session_id||sessionId,run_id:run.id,step:snapshot.step},modified:false,appliedText:text};
  inputMaskOverride={text,format,masks:structure.atoms.map(a=>[...a.mask])};
  readSeq++;clearTimeout(checkTimer);clearTimeout(atomEditTimer);
  $('format').value=format;$('structure').value=text;parseDraft();
  document.querySelector('.structure-panel .editor').hidden=false;
  $('run-note').textContent=`Run ${run.id} · Step ${snapshot.step} is now input r${revision}. Starts a new relaxation from this geometry.`;
}
$('reuse-selected-step').onclick=()=>applyRunStructure(selected);
$('reuse-final-step').onclick=()=>applyRunStructure((run?.history.length||0)-1);
$('run-selector').onchange=()=>{
  if(timer!==null)return;
  const previous=runRecords.get(Number($('run-selector').value));if(!previous)return;
  if(historyPlayback){clearInterval(historyPlayback);historyPlayback=null;}
  run=previous;selected=Math.max(0,run.history.length-1);followLatest=true;viewMode=run.history.length?'result':'input';
  $('export-source').value=viewMode;viewerMode='rotate';editMode=false;settings();updateResults();renderStructure();
};
function currentRelaxControls(){return {modelKey:selectedModel?.model_key||null,task:taskMode,dof:clone(dof),values:Object.fromEntries(['max-steps','fmax','smax','pressure','optimizer','preserve-symmetry'].filter(id=>$(id)).map(id=>[id,$(id).type==='checkbox'?$(id).checked:$(id).value]))};}
function relaxProjectDocument(){return {schema:'macer-relax-session-project-v1',sessionId,input:{text:$('structure').value,format:$('format').value,provenance:clone(inputProvenance),maskOverride:clone(inputMaskOverride)},lastValid:{text:lastText,format:lastFormat},controls:currentRelaxControls(),runs:clone([...runRecords.values()]),selectedRun:run?.id||null,selectedStep:selected};}
function saveRelaxJson(value,filename){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('save-relax-project').onclick=()=>{if(timer!==null)return;saveRelaxJson(relaxProjectDocument(),'macer-relax-project.json');};
function openRelaxProject(document){
  if(timer!==null)throw Error('Stop the calculation before opening a project.');
  const p=RelaxSession.validateProject(document),controls=p.controls;
  const valid=p.lastValid||p.input;S.parse(valid.text,valid.format);
  if(p.input.maskOverride&&(!Array.isArray(p.input.maskOverride.masks)||!p.input.maskOverride.masks.every(m=>m.length===3&&m.every(v=>typeof v==='boolean'))))throw Error('Invalid project constraints.');
  if(controls){
    if(!['relax','single_point'].includes(controls.task)||!['positions','shape','volume'].every(k=>typeof controls.dof?.[k]==='boolean'))throw Error('Invalid project settings.');
    for(const id of ['max-steps','fmax','smax','pressure'])if(!Number.isFinite(Number(controls.values?.[id])))throw Error('Invalid project settings.');
  }
  const projectModel=controls?[...(modelCatalog?.models||[]),...(modelCatalog?.compatibility_models||[])].find(m=>m.model_key===controls.modelKey):null;
  if(controls&&!projectModel)throw Error('The saved model runtime is unavailable. The current input and records have been preserved.');
  // Validation finishes before any current input or history is changed.
  destroyWorker();sessionId=crypto.randomUUID();runRecords.clear();
  for(const r of p.runs)runRecords.set(r.id,r);
  runNumber=Math.max(runNumber,0,...p.runs.map(r=>r.id));run=runRecords.get(p.selectedRun)||p.runs.at(-1)||null;
  inputProvenance=clone(p.input.provenance||null);inputMaskOverride=clone(p.input.maskOverride||null);
  editHistory=[];editCursor=-1;readSeq++;$('structure').value=valid.text;$('format').value=valid.format;parseDraft();
  if(valid.text!==p.input.text||valid.format!==p.input.format){$('structure').value=p.input.text;$('format').value=p.input.format;parseDraft();}
  if(controls){
    Object.assign(dof,controls.dof);taskMode=controls.task;
    for(const [id,value] of Object.entries(controls.values))if(['max-steps','fmax','smax','pressure','optimizer','preserve-symmetry'].includes(id)&&$(id)){if($(id).type==='checkbox')$(id).checked=!!value;else $(id).value=String(value);}
    const model=projectModel;
    if(model){if(![...$('model-select').options].some(o=>o.value===model.model_key))$('model-select').add(new Option(`${model.display_name} · saved runtime`,model.model_key));selectedModel=model;$('model-select').value=model.model_key;updateModelPanel();}
  }
  selected=Math.min(Math.max(0,Number.isSafeInteger(p.selectedStep)?p.selectedStep:0),Math.max(0,(run?.history.length||1)-1));
  viewMode=run?.history.length?'result':'input';$('export-source').value=viewMode;followLatest=selected===(run?.history.length||0)-1;
  settings();updateResults();renderStructure();$('run-note').textContent='Project opened. No calculation has started.';
}
$('open-relax-project').onchange=async()=>{try{const file=$('open-relax-project').files?.[0];if(!file)return;if(file.size>128*1024*1024)throw Error('Relax project exceeds the 128 MiB import limit.');openRelaxProject(JSON.parse(await file.text()));}catch(error){$('run-note').textContent=error.message;}finally{$('open-relax-project').value='';}};

function trajectoryDocument(){
  if(!run?.history.length)return null;
  const assets=Object.fromEntries(Object.entries(run.model.assets||{}).map(([name,asset])=>[name,{sha256:asset.sha256||null,size_bytes:asset.size_bytes||null}]));
  return {
    schema:'macer-browser-relax-trajectory-v1',
    exported_at_utc:new Date().toISOString(),
    run:{
      session_id:run.session_id||sessionId,parent:clone(run.parent||null),
      id:run.id,input_revision:run.revision,started_at_utc:run.started_at_utc,
      model:{id:run.model.model_id,display_name:run.model.display_name,version:run.model.version||null,key:run.modelKey,assets},
      backend:run.backend||run.model.backend,gpu_adapter:run.gpu_adapter??null,gpu_prepare_ms:run.gpu_prepare_ms??null,settings:{task:run.settings.task,optimizer:run.settings.optimizer,
        max_steps:run.settings.maxSteps,force_tolerance_ev_per_a:run.settings.forceTolerance,
        stress_tolerance_gpa:run.settings.stressTolerance,external_pressure_gpa:run.settings.pressure,
        optimize_positions:run.settings.dof.positions,optimize_cell_shape:run.settings.dof.shape,
        optimize_cell_volume:run.settings.dof.volume},
      status:run.state,completed_step:run.history.at(-1).step,elapsed_ms:run.elapsed,
      model_load_ms:run.model_load_ms??null,wasm_linear_memory_samples:run.wasm_linear_memory_samples,
      input_structure:run.input,
    },
    snapshots:run.history.map(snapshot=>({
      run_id:snapshot.runId,input_revision:snapshot.inputRevision,step:snapshot.step,
      status:snapshot.status,evaluation_time_ms:snapshot.evaluation_time_ms,
      structure:snapshot.structure,
      evaluation:snapshot.evaluation,
      max_force_ev_per_a:snapshot.max_force_ev_per_a,
      max_stress_residual_gpa:snapshot.max_stress_residual_gpa??null,
      evaluation_backend:snapshot.evaluation_backend??'cpu-wasm',
      gpu_timing:snapshot.gpu_timing??null,
      gpu_batch_timing:snapshot.gpu_batch_timing??null,
      gpu_batch_fallback_reason:snapshot.gpu_batch_fallback_reason??null,
      gpu_evaluation:snapshot.gpu_evaluation??null,
      cpu_final_audit:snapshot.cpu_final_audit??null,
      cpu_refinement_required:snapshot.cpu_refinement_required??false,
    })),
  };
}
$('download-trajectory').onclick=()=>{
  const trajectory=trajectoryDocument();if(!trajectory)return;
  const content=JSON.stringify(trajectory,null,2);
  const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=`macer_run${run.id}_r${run.revision}_trajectory.json`;a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  $('run-note').textContent=`Run ${run.id} · ${trajectory.snapshots.length} complete trajectory snapshots saved as JSON in the browser.`;
};
document.querySelectorAll('[data-format]').forEach(b=>b.onclick=()=>{
  const fromResult=$('export-source').value==='result';
  if(!fromResult && draftState!=='valid')return;
  const s=exportStructure();if(!s)return;
  const tag=fromResult?`macer-rust ${run.model.model_id} ${run.modelKey} run ${run.id} input-r${run.revision} step ${run.history[selected].step}`:`input r${revision}`;
  const kind=b.dataset.format;
  try {
    const content=kind==='poscar'?S.toPoscar(s,tag):kind==='cif'?S.toCif(s,tag):S.toXyz(s,tag);
    const url=URL.createObjectURL(new Blob([content],{type:'text/plain;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=fromResult?`run-${String(run.id).padStart(3,'0')}-step-${String(run.history[selected].step).padStart(4,'0')}.${kind==='poscar'?'vasp':kind}`:`input-r${revision}.${kind==='poscar'?'vasp':kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    $('download-note').textContent=tag+' · '+kind.toUpperCase()+' saved.'+(kind==='xyz'?' Standard XYZ does not preserve the cell, periodicity or constraints.':kind==='cif'&&s.selective?' CIF does not preserve atom constraints.':'');
  }catch(e){$('download-note').textContent=e.message;}
});
function renderStructure(){
  updateViewerTimeline();
  const s=shownStructure();if(!s)return;
  const result=viewMode==='result'&&run;
  syncAtomEditor();syncCellEditor();
  document.querySelector('.viewer-label').textContent=result?`Run ${run.id} · r${run.revision} · Step ${selected}`:`${formula(s)} · input r${revision}`;
  $('revision-label').textContent=timer?`Run input r${run.revision} · editing locked`:`Input r${revision} · valid edits update automatically`;
  $('atom-count').textContent=s.atoms.length+' · '+formula(s);
  $('cell-size').textContent=s.cell?S.lengths(s).map(v=>v.toFixed(3)).join(' / ')+' Å':'No cell';
  $('volume').textContent=s.cell?Math.abs(S.determinant(s.cell)).toFixed(3)+' Å³':'—';
  $('boundary').textContent=s.cell?'PBC · a b c':'Nonperiodic · no PBC';
  for(const [id,mode] of [['view-mode','rotate'],['select-mode','select'],['edit-mode','move']]){const button=$(id);button.classList.toggle('selected',viewerMode===mode);button.setAttribute('aria-pressed',String(viewerMode===mode));if(mode!=='rotate')button.disabled=!!timer||viewMode!=='input'||draftState!=='valid';}
  $('viewer-mode-note').textContent=viewerMode==='move'?'Drag atoms to edit · use Rotate to lock positions':viewerMode==='select'?'Drag to select atoms · Shift adds · Alt removes':'Atoms locked · drag to rotate · right-drag to pan · scroll to zoom';
  $('bond-toggle').hidden=$('style-preset').value==='space-filling';
  $('show-cell').disabled=!s.cell;
  document.querySelector('.viewer-legend').textContent=[...new Set(s.atoms.map(a=>a.element))].join(' · ');
  $('stale-overlay').hidden=result || draftState==='valid';
  draw();
}
function draw(){
  const s=shownStructure();if(!s)return;
  const frame={
    structure:s,
    display:{showCell:$('show-cell').checked,showBonds:$('show-bonds').checked,showBoundary:$('show-boundary').checked,showNeighbors:$('show-neighbors').checked,bondMode:$('bond-mode').value,atomScale:Number($('atom-size').value),bondScale:Number($('bond-size').value),elementStyles:viewerStyleOverrides,repeats:displayRepeats,stylePreset:$('style-preset').value,...(['ball-and-stick','phonon-vesta'].includes($('style-preset').value)?CommonDisplay.frame():{})},
    atomDragEnabled:draftState==='valid'&&!timer&&viewMode==='input'&&viewerMode==='move',interactionMode:viewerMode,selectionIds:selectedAtoms,
    selection:Number($('atom').value||0),
  };
  if(typeof viewer.setFrame==='function')viewer.setFrame(frame);
  else{viewer.setDisplaySettings(frame.display);viewer.setStructure(s);viewer.setAtomDragEnabled(frame.atomDragEnabled);viewer.setSelection(frame.selection);}
  const stats=viewer.getDisplayStats?.();
  $('display-count').textContent=stats?`${s.atoms.length} atoms · ${stats.atomInstances} shown`:'';
  viewer.setInteractionMode(viewerMode);viewer.setSelectionOptions({operation:selectionOperation,through:$('selection-through').checked});viewer.setSelectionIds(selectedAtoms);
  $('fix-selected').disabled=!selectedAtoms.length||timer!==null||viewMode!=='input';$('free-selected').disabled=$('fix-selected').disabled;
  document.querySelectorAll('#repeat-a,#repeat-b,#repeat-c,#apply-repeat,[data-repeat-preset],#show-boundary,#show-neighbors').forEach(control=>control.disabled=!s.cell);
  document.querySelectorAll('[data-repeat-preset]').forEach(button=>button.setAttribute('aria-pressed',String(displayRepeats.every(value=>value===Number(button.dataset.repeatPreset)))));
}
function setRepeatControls(values){['repeat-a','repeat-b','repeat-c'].forEach((id,index)=>$(id).value=values[index]);}
function setViewerMode(mode){
  viewerMode=mode==='move'&&!timer&&viewMode==='input'&&draftState==='valid'?'move':mode==='select'&&!timer&&viewMode==='input'&&draftState==='valid'?'select':'rotate';editMode=viewerMode==='move';
  for(const [id,value] of [['view-mode','rotate'],['select-mode','select'],['edit-mode','move']]){const button=$(id);button.classList.toggle('selected',viewerMode===value);button.setAttribute('aria-pressed',String(viewerMode===value));}
  $('viewer-mode-note').textContent=viewerMode==='move'?'Drag atoms to edit · use Rotate to lock positions':viewerMode==='select'?'Drag to select atoms · Shift adds · Alt removes':'Atoms locked · drag to rotate · right-drag to pan · scroll to zoom';draw();
}
$('show-input-structure').onclick=()=>{if(historyPlayback){clearInterval(historyPlayback);historyPlayback=null;}viewMode='input';followLatest=false;editMode=false;$('export-source').value='input';settings();updateResults();renderStructure();};
$('show-result-structure').onclick=()=>selectHistory(selected);
$('home-view').onclick=()=>viewer.fitCamera();$('view-mode').onclick=()=>setViewerMode('rotate');$('select-mode').onclick=()=>setViewerMode('select');
$('edit-mode').onclick=()=>setViewerMode('move');$('fix-selected').onclick=()=>applySelectionConstraint(false);$('free-selected').onclick=()=>applySelectionConstraint(true);
for(const [id,operation] of [['selection-replace','replace'],['selection-add','add'],['selection-remove','remove']])$(id).onclick=()=>{selectionOperation=operation;for(const [buttonId,value] of [['selection-replace','replace'],['selection-add','add'],['selection-remove','remove']]){$(buttonId).classList.toggle('selected',value===operation);$(buttonId).setAttribute('aria-pressed',String(value===operation));}viewer.setSelectionOptions({operation,through:$('selection-through').checked});};
$('selection-through').onchange=()=>viewer.setSelectionOptions({operation:selectionOperation,through:$('selection-through').checked});
function applySelectionConstraint(free){const ids=selectedAtoms;if(!accepted||!ids.length||timer||viewMode!=='input')return;for(const id of ids){const atom=accepted.atoms[id];if(atom)atom.mask=[free,free,free];}accepted.selective=accepted.atoms.some(atom=>atom.mask?.some(value=>!value));commitAcceptedEdit(`${free?'Freed':'Fixed'} ${ids.length} atom${ids.length===1?'':'s'}`);settings();draw();}
$('focus-atom-coordinates').onclick=()=>{setViewerMode('move');$('atom-x').focus();};
document.querySelectorAll('[data-camera-axis]').forEach(button=>button.onclick=()=>viewer.setCameraAxis(Number(button.dataset.cameraAxis)));
$('projection-toggle').onclick=()=>{const orthographic=$('projection-toggle').getAttribute('aria-pressed')!=='true';$('projection-toggle').setAttribute('aria-pressed',String(orthographic));$('projection-toggle').textContent=orthographic?'Orthographic':'Perspective';viewer.setProjection(orthographic?'orthographic':'perspective');};
$('style-preset').onchange=()=>{$('bond-toggle').hidden=$('style-preset').value==='space-filling';draw();};
$('show-cell').onchange=draw;$('show-bonds').onchange=draw;$('bond-mode').onchange=updatePeriodicDisplay;
$('atom-size').oninput=()=>{$('atom-size-value').value=Number($('atom-size').value).toFixed(2)+'×';draw();};
$('bond-size').oninput=()=>{$('bond-size-value').value=Number($('bond-size').value).toFixed(2)+'×';draw();};
function syncElementStyleControls(structure){
  const elements=[...new Set((structure?.atoms||[]).map(atom=>atom.element))],select=$('style-element'),previous=select.value;
  select.replaceChildren(...elements.map(element=>new Option(element,element)));
  if(elements.includes(previous))select.value=previous;
  syncElementStyleInputs();
}
function syncElementStyleInputs(){
  const element=$('style-element').value,base=window.ElementStyles?.[element];if(!base)return;
  const override=viewerStyleOverrides[element];$('element-color').value=override?.color||base.color;
  const ratio=override?.radius_scale??(override?.display_radius_angstrom||base.display_radius_angstrom)/base.display_radius_angstrom;
  $('element-radius').value=String(Math.max(.5,Math.min(2,ratio)));$('element-radius-value').value=Number($('element-radius').value).toFixed(2)+'×';
}
function applySelectedElementStyle(){
  const element=$('style-element').value,base=window.ElementStyles?.[element];if(!base)return;

  viewerStyleOverrides[element]={...base,color:$('element-color').value,radius_scale:Number($('element-radius').value),display_radius_angstrom:base.display_radius_angstrom*Number($('element-radius').value)};
  CommonDisplay.patch({elementStyles:structuredClone(viewerStyleOverrides)});$('element-radius-value').value=Number($('element-radius').value).toFixed(2)+'×';draw();
}
$('style-element').onchange=syncElementStyleInputs;$('element-color').oninput=applySelectedElementStyle;
$('element-radius').oninput=applySelectedElementStyle;
function applyDisplayRepeat(){
  const proposed=['repeat-a','repeat-b','repeat-c'].map(id=>Number($(id).value));
  const note=message=>{$('viewer-note').textContent=message;$('viewer-note').hidden=!message;};
  if(proposed.some(value=>!Number.isInteger(value)||value<1||value>4)){note('Each repeat count must be an integer from 1 to 4.');setRepeatControls(displayRepeats);return;}
  const structure=shownStructure();
  const copies=structure?CrystalViewer.displayInstances(structure,proposed,$('show-boundary').checked,$('show-neighbors').checked,$('bond-mode').value).length:0;
  if(copies>5000){note(`${copies.toLocaleString()} displayed atoms exceeds the 5,000-atom display limit.`);setRepeatControls(displayRepeats);return;}
  if(!structure?.cell&&proposed.some(value=>value!==1)){note('Display repeats are unavailable for nonperiodic XYZ.');displayRepeats=[1,1,1];setRepeatControls(displayRepeats);draw();return;}
  displayRepeats=proposed;note('');draw();
}
$('apply-repeat').onclick=applyDisplayRepeat;
function updatePeriodicDisplay(){
  const structure=shownStructure();if(!structure)return;
  const count=()=>CrystalViewer.displayInstances(structure,displayRepeats,$('show-boundary').checked,$('show-neighbors').checked,$('bond-mode').value).length;
  if(count()>5000){
    $('show-neighbors').checked=false;if(count()>5000)$('show-boundary').checked=false;
    $('viewer-note').hidden=false;$('viewer-note').textContent='Periodic images exceed the 5,000-atom display limit.';
  }else{$('viewer-note').hidden=true;$('viewer-note').textContent='';}
  draw();
}
$('show-boundary').onchange=updatePeriodicDisplay;$('show-neighbors').onchange=updatePeriodicDisplay;
document.querySelectorAll('[data-repeat-preset]').forEach(button=>button.onclick=()=>{setRepeatControls([1,1,1].map(()=>Number(button.dataset.repeatPreset)));applyDisplayRepeat();});
document.querySelectorAll('#repeat-a,#repeat-b,#repeat-c').forEach(input=>input.addEventListener('change',applyDisplayRepeat));
new ResizeObserver(draw).observe(canvas.parentElement);
$('structure').value=sample;$('format').value='poscar';parseDraft();

// Explicit snapshot bridge for the Phonons input.
globalThis.MacerRelax=Object.freeze({displayedStructure(){
  if(viewMode==='result'&&run?.history.length)return clone(snapshotStructure(run.history[selected]||run.history.at(-1)));
  return accepted?clone(accepted):null;
}});

CommonDisplay.subscribe(value=>{viewerStyleOverrides=value.elementStyles;syncElementStyleInputs();draw();});
CommonDisplay.bind();

setInterval(()=>{if(timer&&run)$('elapsed').textContent=((performance.now()-run.began)/1000).toFixed(1)+' s';},250);
