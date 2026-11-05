/* Nonperiodic, exploratory bond-response estimates for molecular normal modes. */
(function(root){
 'use strict';
 const P=root.RamanParameters,UFF=root.UniversalIRCT1Model?.elements||{};
 const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),norm=a=>Math.hypot(...a);
 const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]);
 const CM_PER_THz=33.35640951981521;
 function geometry(structure){
  if(!structure||!Array.isArray(structure.pbc)||structure.pbc.some(Boolean))throw Error('Molecular response requires a nonperiodic structure (PBC off).');
  if(!Array.isArray(structure.atoms)||!structure.atoms.length)throw Error('Molecular response requires atoms.');
  return structure.atoms.map((a,i)=>{const style=root.ElementStyles?.[a.element],position=a.position,mass=a.mass??root.MacerAtomicMasses?.[style?.atomic_number];if(!style||!Array.isArray(position)||position.length!==3||!position.every(Number.isFinite)||!Number.isFinite(mass)||mass<=0)throw Error(`Invalid molecular atom ${i+1}.`);return {element:a.element,z:style.atomic_number,radius:style.covalent_radius_angstrom,mass,position:position.slice()};});
 }
 function bonds(atoms,positions){
  const out=[];for(let i=0;i<atoms.length;i++)for(let j=i+1;j<atoms.length;j++){const delta=sub(positions[j],positions[i]),r=norm(delta),scale=atoms[i].radius+atoms[j].radius;if(!Number.isFinite(r)||r<1e-8)throw Error('Coincident atoms in molecular response.');if(r<1.35*scale){const pair=P.pair(atoms[i].element,atoms[j].element,r);out.push({i,j,scale,pair});}}
  if(!out.length&&atoms.length>1)throw Error('No molecular bonds fall within the bond-response cutoff.');return out;
 }
 function switchValue(r,p){if(r<=p.on)return [1,0];if(r>=p.off)return [0,0];const t=(r-p.on)/(p.off-p.on);return [1-10*t**3+15*t**4-6*t**5,(-30*t*t+60*t**3-30*t**4)/(p.off-p.on)];}
 function ramanTensor(atoms,positions,bondList,displacement){
  const out=Array(9).fill(0);
  for(const bond of bondList){const {i,j,pair:p}=bond,v=sub(positions[j],positions[i]),r=norm(v),n=v.map(x=>x/r),du=sub(displacement[j],displacement[i]),dr=dot(n,du),dn=du.map((x,k)=>(x-n[k]*dr)/r),[w,dw]=switchValue(r,p),perp=p.perp0+p.perpSlope*(r-p.r0),anis=p.anis0+p.anisSlope*(r-p.r0);
   for(let a=0;a<3;a++)for(let c=0;c<3;c++){const nn=n[a]*n[c],dnn=dn[a]*n[c]+n[a]*dn[c];out[3*a+c]+=dw*dr*((a===c?perp:0)+anis*nn)+w*((a===c?p.perpSlope*dr:0)+p.anisSlope*dr*nn+anis*dnn);}
  }return out;
 }
 function activity(real,imag=Array(9).fill(0)){
  const sq=(a,b)=>a*a+b*b,mean=[(real[0]+real[4]+real[8])/3,(imag[0]+imag[4]+imag[8])/3],gamma=.5*([[0,4],[4,8],[8,0]].reduce((s,[a,b])=>s+sq(real[a]-real[b],imag[a]-imag[b]),0)+6*[1,2,5].reduce((s,k)=>s+sq(real[k],imag[k]),0));return 45*sq(...mean)+7*gamma;
 }
 function raman(structure,modes){
  const atoms=geometry(structure),positions=atoms.map(a=>a.position),bondList=bonds(atoms,positions);
  return modes.map((mode,index)=>{const u=Array.from({length:atoms.length},(_,i)=>mode.eigenvector_cartesian.slice(3*i,3*i+3)),t=ramanTensor(atoms,positions,bondList,u),imag=Array(9).fill(0),value=activity(t,imag);return {...mode,mode_index:index,raman_tensor_real:t,raman_tensor_imag:imag,raman_activity:value,response_model:'Fixed bond-polarizability estimate',response_status:'exploratory molecular approximation'};});
 }
 function gaussian(r,center,width){const z=(r-center)/width,v=Math.exp(-.5*z*z);return [v,-z/width*v];}
 function cutoff(r,rc){if(r>=rc)return [0,0];const t=r/rc,t2=t*t,t3=t2*t,t4=t3*t,t5=t4*t;return [1-10*t3+15*t4-6*t5,(-30*t2+60*t3-30*t4)/rc];}
 function dipole(atoms,positions){
  const env=atoms.map(()=>[]);for(let i=0;i<atoms.length;i++)for(let j=0;j<atoms.length;j++)if(i!==j){const v=sub(positions[j],positions[i]),r=norm(v),a=UFF[atoms[i].element],b=UFF[atoms[j].element];if(!a||!b)throw Error(`Molecular IR estimate has no UFF prior for ${!a?atoms[i].element:atoms[j].element}.`);const rc=6,width=.35,center=a.radiusUFF+b.radiusUFF;if(r<rc){const [g]=gaussian(r,center,width),[c]=cutoff(r,rc);env[i].push({j,w:g*c});}}
  const beta=root.UniversalIRCT1Model.parameters.beta,centers=root.UniversalIRCT1Model.parameters.radialCentersAngstrom,chi=atoms.map((atom,i)=>{const p=UFF[atom.element],features=Array(16).fill(0);for(const e of env[i]){const q=UFF[atoms[e.j].element];for(let s=0;s<4;s++){const [g]=gaussian(norm(sub(positions[e.j],positions[i])),centers[s],.35),[c]=cutoff(norm(sub(positions[e.j],positions[i])),6),weight=g*c;features[s*4]+=weight*q.xiUFF;features[s*4+1]+=weight*q.hardnessUFF;features[s*4+2]+=weight*q.radiusUFF;features[s*4+3]+=weight;}}let value=p.xiUFF;for(let s=0;s<4;s++){const den=Math.max(features[s*4+3],1e-12),f=[features[s*4]/den,features[s*4+1]/den,features[s*4+2]/den,1];for(let c=0;c<4;c++)value+=beta[s*4+c]*f[c];}return value;});
  const mu=[0,0,0],scale=root.UniversalIRCT1Model.parameters.scale;
  for(let i=0;i<atoms.length;i++)for(let j=i+1;j<atoms.length;j++){const ai=UFF[atoms[i].element],aj=UFF[atoms[j].element],v=sub(positions[j],positions[i]),r=norm(v),center=ai.radiusUFF+aj.radiusUFF,[g,gp]=gaussian(r,center,.35),[c,cp]=cutoff(r,6),rad=g*c,transfer=scale*Math.tanh((chi[i]-chi[j])/Math.max(ai.hardnessUFF+aj.hardnessUFF,1e-8))*rad;for(let k=0;k<3;k++)mu[k]+=transfer*v[k];}
  return mu;
 }
 function ir(structure,modes,{stepA=1e-4}={}){
  const atoms=geometry(structure),positions=atoms.map(a=>a.position);if(!Number.isFinite(stepA)||stepA<=0||stepA>.01)throw Error('Molecular dipole derivative step must be between 0 and 0.01 Å.');
  return modes.map((mode,index)=>{const u=Array.from({length:atoms.length},(_,i)=>mode.eigenvector_cartesian.slice(3*i,3*i+3)),plus=positions.map((p,i)=>add(p,u[i].map(x=>x*stepA))),minus=positions.map((p,i)=>sub(p,u[i].map(x=>x*stepA))),a=dipole(atoms,plus),b=dipole(atoms,minus),derivative=a.map((x,k)=>(x-b[k])/(2*stepA)),strength=dot(derivative,derivative);return {...mode,mode_index:index,ir_dipole_derivative_e_sqrt_amu:derivative,ir_strength_e2_amu:strength,response_model:'UFF bond charge-transfer estimate',response_status:'exploratory molecular approximation'};});
 }
 function spectra(modes,fwhm=10){if(!Number.isFinite(fwhm)||fwhm<=0||fwhm>200)throw Error('Linewidth must be between 0 and 200 cm⁻¹.');const max=Math.max(100,...modes.filter(m=>m.frequency_cm1>0).map(m=>m.frequency_cm1+8*fwhm)),step=Math.max(.25,max/8000),out={};for(const [key,activityKey] of [['raman','raman_activity'],['ir','ir_strength_e2_amu']]){const points=[];for(let x=0;x<=max;x+=step){let y=0;for(const m of modes)if(m.frequency_cm1>0&&m[activityKey]>0){const h=fwhm/2;y+=m[activityKey]*h/Math.PI/((x-m.frequency_cm1)**2+h*h);}points.push([x,y,0]);}const peak=points.reduce((v,p)=>Math.max(v,p[1]),0);for(const p of points)p[2]=peak>0?100*p[1]/peak:0;out[key]=points;}return out;}
 root.MolecularResponse=Object.freeze({raman,ir,spectra,activity});if(typeof module!=='undefined')module.exports=root.MolecularResponse;
})(globalThis);
