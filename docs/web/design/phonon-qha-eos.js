/* Isotropic QHA using third-order Birch–Murnaghan on a fixed volume grid. */
(function(root){
'use strict';

const EV_A3_TO_GPA=160.2176634;
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const polynomial=(c,x)=>c.reduceRight((sum,k)=>sum*x+k,0);

// In Eulerian strain, BM3 is a cubic. An affine change of strain
// improves conditioning and leaves the fitted EOS family unchanged.
function design(xs){
  const q=[],r=[];
  for(let j=0;j<4;j++){
    const col=xs.map(x=>x**j);
    for(let i=0;i<j;i++){
      r[i][j]=dot(q[i],col);
      for(let k=0;k<col.length;k++)col[k]-=r[i][j]*q[i][k];
    }
    const norm=Math.sqrt(dot(col,col));
    if(!Number.isFinite(norm)||norm<1e-10)throw Error('The sampled volumes are too closely spaced to fit an equation of state.');
    r[j]=Array(4).fill(0);
    r[j][j]=norm;
    q[j]=col.map(v=>v/norm);
  }
  return {q,r};
}

function fitGrid(volumes,energies){
  const reference=volumes[Math.floor(volumes.length/2)];
  const strain=v=>(reference/v)**(2/3)-1;
  const scale=Math.max(...volumes.map(v=>Math.abs(strain(v))));
  const xs=volumes.map(v=>strain(v)/scale);
  const zero=energies[Math.floor(energies.length/2)];
  const {q,r}=design(xs);
  const c=q.map(row=>dot(row,energies.map(e=>e-zero)));
  for(let i=3;i>=0;i--){
    for(let j=i+1;j<4;j++)c[i]-=r[i][j]*c[j];
    c[i]/=r[i][i];
  }
  const [lo,hi]=[xs.at(-1),xs[0]];
  const residuals=energies.map((e,i)=>polynomial(c,xs[i])+zero-e);
  const rss=dot(residuals,residuals);
  const fit={strainReferenceA3:reference,strainScale:scale,energyOffsetEv:zero,coefficients:c,
    volumeRangeA3:[volumes[0],volumes.at(-1)],rmsResidualEv:Math.sqrt(rss/volumes.length)};
  // The sign of d²E/dV² is the sign of the quadratic below.
  const curvature=[8*c[2]+10*scale*c[1],24*c[3]+28*scale*c[2],54*scale*c[3]];
  const turn=-curvature[1]/(2*curvature[2]);
  const probes=turn>lo&&turn<hi?[lo,hi,turn]:[lo,hi];
  if(probes.some(x=>polynomial(curvature,x)<=0))return {...fit,status:'nonconvex'};
  const gradient=x=>c[1]+x*(2*c[2]+3*c[3]*x);
  const edgeTolerance=1e-12*Math.max(1,...c.map(Math.abs));
  if(gradient(lo)>=-edgeTolerance||gradient(hi)<=edgeTolerance)return {...fit,status:'outside-grid'};

  let left=lo,right=hi;
  for(let i=0;i<52;i++){
    const x=(left+right)/2;
    if(gradient(x)>0)right=x;else left=x;
  }
  const x=(left+right)/2;
  const stretch=1+scale*x;
  const volume=reference/stretch**1.5;
  const dxdv=-2*stretch/(3*volume*scale);
  const curvatureX=2*c[2]+6*c[3]*x;
  // Residual-based standard error from linearized stationary-point motion.
  const response=[0,1,2*x,3*x*x];
  for(let i=0;i<4;i++){
    for(let j=0;j<i;j++)response[i]-=r[j][i]*response[j];
    response[i]/=r[i][i];
  }
  const volumeStdErrorA3=Math.sqrt(rss/(volumes.length-4)*dot(response,response))/Math.abs(curvatureX*dxdv);
  return {...fit,status:'valid',equilibriumVolumeA3:volume,gibbsEvPerCell:polynomial(c,x)+zero,
    bulkModulusGpa:volume*curvatureX*dxdv**2*EV_A3_TO_GPA,volumeStdErrorA3};
}

function energyAt(fit,volume){
  const x=((fit.strainReferenceA3/volume)**(2/3)-1)/fit.strainScale;
  return polynomial(fit.coefficients,x)+fit.energyOffsetEv;
}

function expectedInput(project){
  const tasks=project?.tasks;
  if(!Array.isArray(tasks)||tasks.length<5||tasks.length>21||tasks.some(t=>t.type!=='qha-volume'||t.status!=='completed')){
    throw Error('Complete 5–21 volume calculations before fitting.');
  }
  const results=tasks.map(t=>t.result).sort((a,b)=>a.qha.volumeAngstrom3-b.qha.volumeAngstrom3);
  if(results.some(r=>r.qha.thermal.stability.status!=='stable')){
    throw Error('At least one volume has imaginary modes. Choose a stable volume grid before fitting.');
  }
  const first=results[0];
  const temperatures=first.qha.thermal.rows.map(row=>row.temperature_k);
  if(!temperatures.length||temperatures.some((t,i)=>!Number.isFinite(t)||t<0||(i>0&&t<=temperatures[i-1])))throw Error('Invalid temperature grid.');
  const volumes=results.map(r=>r.qha.volumeAngstrom3);
  if(volumes.some((v,i)=>!Number.isFinite(v)||v<=0||(i>0&&v<=volumes[i-1])))throw Error('Invalid volume grid.');
  const count=first.atomCount;
  if(!Number.isSafeInteger(count)||count<1)throw Error('Invalid primitive atom count.');
  const mesh=first.qha.thermal.mesh;
  if(results.some(r=>{
    const thermal=r.qha.thermal;
    return r.atomCount!==count||thermal.primitiveAtomCount!==count||
      JSON.stringify(thermal.mesh)!==JSON.stringify(mesh)||!Number.isFinite(r.totalEnergyEv)||
      thermal.rows.length!==temperatures.length||thermal.rows.some((row,i)=>row.temperature_k!==temperatures[i]||
        !Number.isFinite(row.free_energy_ev_per_atom)||!Number.isFinite(row.heat_capacity_kb_per_atom));
  }))throw Error('Volume results must have matching primitive atom counts, q-meshes and temperatures, with finite energies and heat capacities.');
  return {results,volumes,temperatures,count,mesh};
}

function samplesAt(results,volumes,count,i,pressureGpa){
  return results.map((r,j)=>r.totalEnergyEv+count*r.qha.thermal.rows[i].free_energy_ev_per_atom+
    pressureGpa*volumes[j]/EV_A3_TO_GPA);
}

function validateSaved(project,fit){
  const input=expectedInput(project);
  const {results,volumes,temperatures,count,mesh}=input;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  if(fit?.schema!=='macer-qha-eos-v1'||fit.equationOfState!=='birch_murnaghan'||fit.projectId!==project.projectId||
    !Number.isFinite(fit.pressureGpa)||fit.primitiveAtomCount!==count||!same(fit.mesh,mesh)||!same(fit.volumesA3,volumes)||
    !same(fit.sourceHashes,results.map(r=>r.qhaSha256))||fit.rows?.length!==temperatures.length){
    throw Error('Saved QHA fit does not match the volume results.');
  }
  for(const [i,row] of fit.rows.entries()){
    const valid=row.status==='valid';
    if(row.temperatureK!==temperatures[i]||!same(row.volumeRangeA3,[volumes[0],volumes.at(-1)])||
      !same(row.samplesEv,samplesAt(results,volumes,count,i,fit.pressureGpa))||
      !Array.isArray(row.coefficients)||row.coefficients.length!==4||!row.coefficients.every(Number.isFinite)||
      ![row.strainReferenceA3,row.strainScale].every(v=>Number.isFinite(v)&&v>0)||
      ![row.energyOffsetEv,row.rmsResidualEv].every(Number.isFinite)||row.rmsResidualEv<0||
      !['valid','nonconvex','outside-grid'].includes(row.status)||
      (valid&&(![row.gibbsEvPerCell,row.bulkModulusGpa,row.volumeStdErrorA3,row.cvKbPerAtom].every(Number.isFinite)||
        row.bulkModulusGpa<=0||row.volumeStdErrorA3<0||row.equilibriumVolumeA3<=volumes[0]||
        !Number.isFinite(row.equilibriumVolumeA3)||row.equilibriumVolumeA3>=volumes.at(-1)))||
      (row.expansionPerK!==null&&(!valid||!Number.isFinite(row.expansionPerK)))){
      throw Error('Saved QHA fit contains invalid values.');
    }
  }
  return fit;
}

function calculate(project,pressureGpa){
  if(!Number.isFinite(pressureGpa))throw Error('Enter a finite pressure in GPa.');
  const {results,volumes,temperatures,count,mesh}=expectedInput(project);
  const rows=temperatures.map((temperatureK,i)=>{
    const samplesEv=samplesAt(results,volumes,count,i,pressureGpa);
    if(!samplesEv.every(Number.isFinite))throw Error('The pressure or free energies exceed the fit’s numerical range.');
    const fit=fitGrid(volumes,samplesEv);
    const row={temperatureK,samplesEv,...fit,expansionPerK:null,cvKbPerAtom:null};
    if(fit.status==='valid'){
      const j=volumes.findIndex(v=>v>=fit.equilibriumVolumeA3);
      const f=(fit.equilibriumVolumeA3-volumes[j-1])/(volumes[j]-volumes[j-1]);
      const cv=k=>results[k].qha.thermal.rows[i].heat_capacity_kb_per_atom;
      row.cvKbPerAtom=(1-f)*cv(j-1)+f*cv(j);
    }
    return row;
  });
  for(let i=0;i<rows.length;i++){
    const row=rows[i];
    if(row.status!=='valid')continue;
    if(row.temperatureK===0)row.expansionPerK=0;
    else if(rows[i-1]?.status==='valid'&&rows[i+1]?.status==='valid'){
      const [a,b]=[rows[i-1],rows[i+1]];
      row.expansionPerK=(b.equilibriumVolumeA3-a.equilibriumVolumeA3)/(b.temperatureK-a.temperatureK)/row.equilibriumVolumeA3;
    }
  }
  return {schema:'macer-qha-eos-v1',equationOfState:'birch_murnaghan',pressureGpa,volumeUnit:'angstrom^3/primitive cell',
    energyUnit:'eV/primitive cell',volumeUncertainty:'linearized, residual-based fit standard error',
    expansionMethod:'centered neighbor difference; zero at 0 K; unavailable without valid neighbors',
    cvMethod:'linear interpolation of harmonic Cv at the equilibrium volume',
    projectId:project.projectId,model:project.model,
    sourceHashes:results.map(r=>r.qhaSha256),primitiveAtomCount:count,mesh,volumesA3:volumes,rows};
}

const api={calculate,validateSaved,energyAt,EV_A3_TO_GPA};
root.PhononQhaEos=api;
if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
