/* Fit and inspect saved QHA volumes without starting model workers. */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const eos=root.PhononQhaEos;
let project=null,fit=null,attached=false;
const display=(v,digits)=>Number.isFinite(v)?v.toFixed(digits):'—';
const issues={
  'outside-grid':'Minimum is at or beyond the sampled range. Extend the volume grid.',
  nonconvex:'The fitted curve is non-convex over the sampled range.',
};
function svg(tag,attributes={},label){
  const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attributes))el.setAttribute(key,value);
  if(label!==undefined)el.textContent=label;
  return el;
}

function plot(row){
  const chart=$('qha-fit-plot');
  chart.replaceChildren(svg('title',{id:'qha-fit-plot-title'},
    `Free energy versus primitive-cell volume at ${row.temperatureK} K`));
  const [v0,v1]=row.volumeRangeA3;
  const curve=Array.from({length:121},(_,i)=>{
    const volume=v0+(v1-v0)*i/120;
    return [volume,eos.energyAt(row,volume)];
  });
  const energies=[...row.samplesEv,...curve.map(p=>p[1])];
  const low=Math.min(...energies),high=Math.max(...energies);
  const padding=Math.max((high-low)*0.08,1e-8);
  const min=low-padding,max=high+padding;
  const x=v=>73+(v-v0)/(v1-v0)*505;
  const y=e=>256-(e-min)/(max-min)*228;
  for(let i=0;i<=4;i++){
    const energy=min+(max-min)*i/4;
    const height=y(energy);
    chart.append(svg('line',{x1:73,x2:578,y1:height,y2:height,class:'qha-plot-grid'}),
      svg('text',{x:65,y:height+4,'text-anchor':'end'},energy.toFixed(3)));
    const volume=v0+(v1-v0)*i/4;
    chart.append(svg('text',{x:x(volume),y:276,'text-anchor':'middle'},volume.toFixed(2)));
  }
  chart.append(svg('path',{d:'M73 28V256H578',class:'qha-plot-axis'}),
    svg('text',{x:73,y:17},'Free energy (eV/primitive cell)'),
    svg('text',{x:325,y:301,'text-anchor':'middle'},'Volume (Å³/primitive cell)'),
    svg('polyline',{points:curve.map(([v,e])=>`${x(v)},${y(e)}`).join(' '),class:'qha-plot-curve'}));
  row.samplesEv.forEach((energy,i)=>{
    const v=fit.volumesA3[i];
    const dot=svg('circle',{cx:x(v),cy:y(energy),r:4,class:'qha-plot-sample'});
    dot.append(svg('title',{},`${v.toFixed(5)} Å³ · ${energy.toFixed(7)} eV`));
    chart.append(dot);
  });
  if(row.status==='valid'){
    const px=x(row.equilibriumVolumeA3),py=y(row.gibbsEvPerCell);
    chart.append(svg('line',{x1:px,x2:px,y1:py,y2:256,class:'qha-plot-guide'}));
    const minimum=svg('path',{id:'qha-fit-minimum',d:`M${px} ${py-6}l6 6-6 6-6-6z`});
    minimum.append(svg('title',{},`Minimum at ${row.equilibriumVolumeA3.toFixed(5)} Å³`));
    chart.append(minimum);
  }
}
function trendChart(id,key,label,scale=1){
  const chart=$(id),rows=fit.rows;
  chart.replaceChildren(svg('title',{},label));
  const points=rows.map((row,index)=>({row,index,value:row[key]===null?NaN:row[key]*scale}));
  const valid=points.filter(p=>p.row.status==='valid'&&Number.isFinite(p.value));
  if(!valid.length){chart.append(svg('text',{x:65,y:80},'No valid values in this range'));return;}
  const lo=Math.min(...valid.map(p=>p.value)),hi=Math.max(...valid.map(p=>p.value));
  const pad=Math.max((hi-lo)*.12,Math.abs(lo)*1e-5,1e-8);
  const t0=rows[0].temperatureK,t1=rows.at(-1).temperatureK;
  const x=t=>73+(t-t0)/(t1-t0||1)*505;
  const y=v=>256-(v-lo+pad)/(hi-lo+2*pad)*220;
  chart.append(svg('text',{x:73,y:20},label));
  for(let i=0;i<=2;i++){
    const v=lo+(hi-lo)*i/2;
    chart.append(svg('line',{x1:73,x2:578,y1:y(v),y2:y(v),class:'qha-plot-grid'}),svg('text',{x:65,y:y(v)+4,'text-anchor':'end'},Number(v.toPrecision(4))));
    const t=t0+(t1-t0)*i/2;
    chart.append(svg('text',{x:x(t),y:278,'text-anchor':'middle'},Math.round(t)));
  }
  chart.append(svg('text',{x:578,y:301,'text-anchor':'end'},'Temperature (K)'));
  if(lo<0&&hi>0)chart.append(svg('line',{x1:73,x2:578,y1:y(0),y2:y(0),class:'qha-zero-line'}));
  const selectedRow=rows[$('qha-fit-temperature').selectedIndex];
  chart.append(svg('line',{x1:x(selectedRow.temperatureK),x2:x(selectedRow.temperatureK),y1:30,y2:256,class:'qha-temperature-guide'}));
  let last=null;
  for(const point of points){
    if(point.row.status!=='valid'||!Number.isFinite(point.value)){last=null;continue;}
    const px=x(point.row.temperatureK),py=y(point.value);
    if(last)chart.append(svg('line',{x1:last[0],y1:last[1],x2:px,y2:py,class:'qha-plot-curve'}));
    last=[px,py];
    const dot=svg('circle',{cx:px,cy:py,r:point.index===$('qha-fit-temperature').selectedIndex?5:3.5,
      class:'qha-trend-point',tabindex:0,role:'button','aria-label':`${point.row.temperatureK} K, ${label} ${point.value}`});
    dot.append(svg('title',{},`${point.row.temperatureK} K · ${point.value}`));
    const choose=()=>{$('qha-fit-temperature').selectedIndex=point.index;selected();};
    dot.addEventListener('click',choose);
    dot.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose();}});
    chart.append(dot);
  }
}

function selected(){
  if(!fit)return;
  const i=$('qha-fit-temperature').selectedIndex;
  const row=fit.rows[i];
  $('qha-metric-volume').textContent=display(row.equilibriumVolumeA3,4);
  $('qha-metric-expansion').textContent=display(row.expansionPerK===null?NaN:row.expansionPerK*1e6,3);
  $('qha-metric-bulk').textContent=display(row.bulkModulusGpa,2);
  $('qha-fit-quality').textContent=row.status==='valid'
    ? `${row.temperatureK} K · Minimum within the sampled volume range${row.expansionPerK===null?' · Expansion unavailable at this endpoint':''}`
    : issues[row.status];
  $('qha-fit-quality').dataset.valid=String(row.status==='valid');
  plot(row);
  trendChart('qha-volume-plot','equilibriumVolumeA3','Equilibrium volume (Å³/cell)');
  trendChart('qha-expansion-plot','expansionPerK','Volumetric expansion (10⁻⁶/K)',1e6);
  trendChart('qha-bulk-plot','bulkModulusGpa','Isothermal bulk modulus (GPa)');
  $('qha-fit-selection').textContent=row.status==='valid'
    ? `Minimum ${display(row.equilibriumVolumeA3,5)} Å³ · fit SE ${display(row.volumeStdErrorA3,5)} Å³ · RMS residual ${display(1000*row.rmsResidualEv,3)} meV`
    : issues[row.status];
}

function showFit(next){
  fit=next;
  $('qha-fit-results').hidden=!fit;
  $('qha-fit-download').disabled=!fit;
  $('qha-fit-save-project').hidden=!attached;
  $('qha-fit-save-project').disabled=!fit;
  if(!fit)return;
  $('qha-fit-material').textContent=`${fit.model?.modelId||'Saved model'} · ${fit.volumesA3.length} volumes · ${fit.mesh.join(' × ')} q-mesh`;
  const temperatures=$('qha-fit-temperature');
  const previous=temperatures.value;
  temperatures.replaceChildren(...fit.rows.map(row=>new Option(`${row.temperatureK} K`,row.temperatureK)));
  temperatures.value=previous;
  if(temperatures.selectedIndex<0)temperatures.selectedIndex=Math.max(0,fit.rows.findIndex(row=>row.temperatureK===300));
  const body=$('qha-fit-table').tBodies[0];
  body.replaceChildren();
  for(const row of fit.rows){
    const tr=body.insertRow();
    const temperature=document.createElement('th');
    temperature.scope='row';
    temperature.textContent=row.temperatureK;
    tr.append(temperature);
    for(const field of [display(row.equilibriumVolumeA3,5),display(row.gibbsEvPerCell,7),
      display(row.bulkModulusGpa,4),display(row.expansionPerK===null?NaN:1e6*row.expansionPerK,4),
      display(row.cvKbPerAtom,5),row.status==='valid'?display(1000*row.rmsResidualEv,3):issues[row.status]]){
      tr.insertCell().textContent=field;
    }
  }
  selected();
}

function status(message){$('qha-fit-status').textContent=message;}
function run(){
  showFit(null);
  try{
    const field=$('qha-fit-pressure');
    if(!field.reportValidity()){status('Enter a finite pressure in GPa.');return;}
    const output=eos.calculate(project,field.valueAsNumber);
    showFit(output);
    const valid=output.rows.filter(row=>row.status==='valid').length;
    status(`${valid}/${output.rows.length} temperatures with an interior minimum · ${output.pressureGpa} GPa · ${output.mesh.join(' × ')} q-mesh`);
  }catch(error){status(error.message);}
}
function load(value,fromPhonons=false){
  project=value;
  attached=fromPhonons;
  showFit(null);
  $('qha-fit-run').disabled=!project;
  if(project)run();
}
function open(value){
  load(value,true);
  const panel=$('phonon-qha-fit-panel');
  panel.open=true;
  panel.scrollIntoView({block:'start'});
}
$('qha-fit-open').onchange=async event=>{
  const input=event.target;
  const file=input.files?.[0];
  if(!file)return;
  input.disabled=true;
  try{
    const value=await root.CalculationProject.verifyTaskIdentities(JSON.parse(await file.text()));
    if(value.tasks.length!==7||!value.tasks.every(task=>task.type==='qha-volume'))throw Error('Choose a QHA volume results file.');
    load(value);
  }catch(error){status(error.message);}
  finally{input.value='';input.disabled=false;}
};
for(const button of document.querySelectorAll('[data-qha-chart]'))button.onclick=()=>{
  document.querySelector('.qha-result-grid').dataset.mobileChart=button.dataset.qhaChart;
  for(const item of document.querySelectorAll('[data-qha-chart]'))item.setAttribute('aria-pressed',String(item===button));
};
$('qha-fit-run').onclick=run;
$('qha-fit-pressure').onchange=()=>{if(project)run();};
$('qha-fit-temperature').onchange=selected;
$('qha-fit-download').onclick=()=>{
  if(!fit)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(fit,null,2)],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;link.download='qha-fit.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('qha-fit-save-project').onclick=()=> $('phonon-project-download').click();

function projectFields(volumes){
  return attached&&volumes&&volumes.projectId===project?.projectId&&fit
    ? {fit,temperatureK:Number($('qha-fit-temperature').value)}
    : {};
}

function reset(){
  if(!attached)return;
  load(null);
  status('Open saved QHA volumes or use View free-energy fit after the volume calculations finish.');
}

function restore(volumes,saved){
  project=volumes;
  attached=true;
  $('qha-fit-run').disabled=false;
  $('qha-fit-pressure').value=saved.fit.pressureGpa;
  showFit(saved.fit);
  $('qha-fit-temperature').value=saved.temperatureK;
  selected();
  $('phonon-qha-fit-panel').open=true;
  status(`Saved fit reopened · ${saved.fit.pressureGpa} GPa · ${saved.fit.mesh.join(' × ')} q-mesh`);
}

root.PhononQhaFitUi={open,projectFields,reset,restore};
})(globalThis);
