/* Harmonic thermal postprocessing for the currently displayed force constants. */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const fieldIds=['thermal-mesh-a','thermal-mesh-b','thermal-mesh-c','thermal-max-temperature','thermal-temperature-step'];
let source=null,worker=null,result=null,lastStable=null;

function controls(){
  $('phonon-thermal-panel').hidden=!source;
  $('thermal-run').disabled=!source||!!worker;
  $('thermal-stop').disabled=!worker;
  $('thermal-download').disabled=!result;
  for(const id of fieldIds)$(id).disabled=!!worker;
}

function releaseWorker(){
  worker?.terminate();
  worker=null;
}

function setSource(value){
  if(source===value&&!value)return;
  releaseWorker();
  source=value?.forceConstants?.values?value:null;
  result=null;lastStable=null;
  $('thermal-summary').textContent='';
  $('thermal-convergence').textContent='';
  $('thermal-result').hidden=true;
  $('thermal-status').textContent='Choose a q-mesh and calculate from the existing force constants.';
  controls();
}

function options(){
  const mesh=fieldIds.slice(0,3).map(id=>$(id).valueAsNumber);
  const maximum=$('thermal-max-temperature').valueAsNumber;
  const step=$('thermal-temperature-step').valueAsNumber;
  if(fieldIds.some(id=>!$(id).reportValidity())||Math.ceil(maximum/step)>500){
    throw Error('Enter valid mesh and temperature settings, with at most 501 temperatures.');
  }
  const temperatures=Array.from({length:Math.floor(maximum/step)+1},(_,i)=>i*step);
  if(temperatures.at(-1)<maximum)temperatures.push(maximum);
  return {mesh,temperatures};
}

function render(value,prior){
  const summary=`${value.mesh.join(' × ')} · ${value.qWeightSum} q-points · ${value.primitiveAtomCount} primitive atoms · ${value.supercellAtomCount} supercell atoms`;
  const gamma=value.gamma?' · 3 Γ translations excluded':'';
  $('thermal-summary').textContent=`${summary}${gamma} · ZPE ${value.zpe_ev_per_atom.toPrecision(8)} eV/atom`;
  const body=$('thermal-table').tBodies[0];
  body.replaceChildren();
  for(const row of value.rows){
    const tr=body.insertRow();
    for(const number of Object.values(row))tr.insertCell().textContent=Number(number.toPrecision(8));
  }
  const sameTemperatures=prior&&prior.rows.length===value.rows.length&&
    prior.rows.every((row,i)=>row.temperature_k===value.rows[i].temperature_k);
  if(sameTemperatures&&prior.meshHash!==value.meshHash){
    const delta=key=>Math.max(...value.rows.map((row,i)=>Math.abs(row[key]-prior.rows[i][key])));
    $('thermal-convergence').textContent=
      `Change from ${prior.mesh.join(' × ')} (max over temperatures) · ΔZPE ${Math.abs(value.zpe_ev_per_atom-prior.zpe_ev_per_atom).toExponential(2)} eV/atom · ΔF ${delta('free_energy_ev_per_atom').toExponential(2)} eV/atom · ΔS ${delta('entropy_kb_per_atom').toExponential(2)} kB/atom · ΔCv ${delta('heat_capacity_kb_per_atom').toExponential(2)} kB/atom`;
  }
  $('thermal-result').hidden=false;
}

function start(){
  if(!source||worker)return;
  try{
    const settings=options();
    const owner=source;
    const id=crypto.randomUUID();
    const nacEnabled=owner.activeNacEnabled??owner.settings?.nacEnabled??false;
    const phononSettings={...owner.settings,nacEnabled};
    const plan=owner.plan&&(nacEnabled?owner.plan.nac:true)?
      {...owner.plan,settings:phononSettings,nac:nacEnabled?owner.plan.nac:null}:null;
    const running=new Worker('./phonon-worker.js?v=9e37c9999bfcde9f');
    worker=running;
    const current=()=>worker===running&&source===owner;
    const finish=message=>{releaseWorker();$('thermal-status').textContent=message;controls();};
    running.onmessage=({data:m})=>{
      if(!current()||m.jobId!==id)return;
      if(m.type==='error')finish(m.message);
      if(m.type==='thermal-progress')$('thermal-status').textContent=`${m.stage} · ${m.done}/${m.total}`;
      if(m.type==='thermal-result'){
        result=m.result;
        $('thermal-convergence').textContent='';
        if(result.stability.status==='unstable'){
          const {imaginaryCount,unstableQPoints,minimumMode}=result.stability;
          $('thermal-result').hidden=true;
          finish(`${result.mesh.join(' × ')} · ${imaginaryCount} imaginary modes at ${unstableQPoints} q-points; lowest ${minimumMode.frequencyTHz.toFixed(5)} THz at q (${minimumMode.q.map(v=>v.toFixed(5)).join(', ')}). Harmonic thermodynamics is undefined for this mesh.`);
          return;
        }
        render(result,lastStable);
        lastStable=result;
        finish('Thermal properties calculated from the existing force constants.');
      }
    };
    running.onerror=event=>{if(current())finish(event.message||'Thermal Worker failed.');};
    running.onmessageerror=()=>{if(current())finish('Could not read the thermal result.');};
    $('thermal-status').textContent='Preparing thermal q-mesh…';
    controls();
    running.postMessage({type:'thermal',jobId:id,inputRevision:owner.revision,plan,
      structure:owner.preparedInput,settings:phononSettings,forceConstants:owner.forceConstants,
      modelKey:owner.model?.model_key,options:settings});
  }catch(error){
    releaseWorker();
    $('thermal-status').textContent=error.message;
    controls();
  }
}
$('thermal-run').onclick=start;
$('thermal-stop').onclick=()=>{
  releaseWorker();
  $('thermal-status').textContent='Thermal mesh stopped.';
  controls();
};
$('thermal-download').onclick=()=>{
  if(!result)return;
  const href=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=href;link.download='harmonic-thermal.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(href),1000);
};
root.PhononThermalUi={setSource,options};
})(globalThis);
