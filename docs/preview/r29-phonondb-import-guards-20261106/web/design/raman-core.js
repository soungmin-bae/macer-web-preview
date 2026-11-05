/* File-I/O-free float64 periodic geometric BPM. No forces or frequency fitting. */
(function(root){'use strict';const P=root.RamanParameters,S=root.Structures;
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sub=(a,b)=>a.map((x,i)=>x-b[i]);
const positive=t=>{for(const x of t)if(x!==0)return x>0;return false;};
function switching(r,p){if(r<=p.on)return [1,0];if(r>=p.off)return [0,0];const t=(r-p.on)/(p.off-p.on);return [1-10*t**3+15*t**4-6*t**5,(-30*t*t+60*t**3-30*t**4)/(p.off-p.on)];}
function prepare(data){
 if(!Array.isArray(data.lattice)||data.lattice.length!==3||!data.lattice.every(r=>Array.isArray(r)&&r.length===3&&r.every(Number.isFinite)))throw Error('Raman requires a finite 3D lattice.');
 const volume=Math.abs(S.determinant(data.lattice));if(!Number.isFinite(volume)||volume<1e-10)throw Error('Raman lattice is singular.');
 if(!Array.isArray(data.atoms)||!data.atoms.length)throw Error('Raman needs atoms.');
 const positions=data.atoms.map(a=>{if(!P.manifest.elements[a.element])throw Error('No BPM parameters for '+a.element+'.');if(!Array.isArray(a.fractional)||a.fractional.length!==3||!a.fractional.every(Number.isFinite)||!Number.isFinite(a.mass)||a.mass<=0)throw Error('Raman requires finite fractional coordinates and positive atom masses.');return S.cartesian(a.fractional,data.lattice);});
 const [a,b,c]=data.lattice,det=S.determinant(data.lattice),recip=[cross(b,c),cross(c,a),cross(a,b)].map(v=>v.map(x=>x/det)),pairs=[];let candidates=0;
 for(let i=0;i<positions.length;i++)for(let j=i;j<positions.length;j++){
  const A=P.manifest.elements[data.atoms[i].element],B=P.manifest.elements[data.atoms[j].element],cutoff=P.manifest.switchOff*(A.radius+B.radius)+P.manifest.skin_A,df=sub(data.atoms[j].fractional,data.atoms[i].fractional),bounds=recip.map((v,k)=>{const h=cutoff*Math.hypot(...v);return [Math.ceil(-df[k]-h-1e-10),Math.floor(-df[k]+h+1e-10)];});
  candidates+=bounds.reduce((n,[lo,hi])=>n*Math.max(0,hi-lo+1),1);if(candidates>P.manifest.candidateLimit)throw Error('BPM candidate-image budget exceeded. Geometry has not been reduced.');
  for(let x=bounds[0][0];x<=bounds[0][1];x++)for(let y=bounds[1][0];y<=bounds[1][1];y++)for(let z=bounds[2][0];z<=bounds[2][1];z++){
   const t=[x,y,z];if(i===j&&!positive(t))continue;const shift=S.cartesian(t,data.lattice),v=positions[j].map((q,k)=>q+shift[k]-positions[i][k]),r0=Math.hypot(...v);if(r0>cutoff)continue;if(r0<1e-8)throw Error('Coincident periodic atoms in BPM geometry.');
   pairs.push({i,j,t,shift,...P.pair(data.atoms[i].element,data.atoms[j].element,r0)});if(pairs.length>P.manifest.pairLimit)throw Error('BPM pair budget exceeded. Geometry has not been reduced.');
  }
 }
 if(!pairs.length)throw Error('No pairs lie inside the BPM geometric cutoff.');
 return {lattice:data.lattice.map(r=>r.slice()),atoms:data.atoms.map(a=>({...a,fractional:a.fractional.slice()})),positions,pairs,volume,candidates};
}
function alpha(prepared,positions=prepared.positions){const out=Array(9).fill(0);for(const p of prepared.pairs){const v=positions[p.j].map((x,k)=>x+p.shift[k]-positions[p.i][k]),r=Math.hypot(...v);if(r<1e-8)throw Error('Coincident atoms in displaced BPM geometry.');const n=v.map(x=>x/r),[w]=switching(r,p),perp=p.perp0+p.perpSlope*(r-p.r0),anis=p.anis0+p.anisSlope*(r-p.r0);for(let i=0;i<3;i++)for(let j=0;j<3;j++)out[i*3+j]+=w*((i===j?perp:0)+anis*n[i]*n[j]);}return out;}
function derivative(prepared,u){const out=Array(9).fill(0);for(const p of prepared.pairs){const v=prepared.positions[p.j].map((x,k)=>x+p.shift[k]-prepared.positions[p.i][k]),r=Math.hypot(...v),n=v.map(x=>x/r),du=sub(u[p.j],u[p.i]),dr=dot(n,du),dn=du.map((x,k)=>(x-n[k]*dr)/r),[w,dw]=switching(r,p);for(let i=0;i<3;i++)for(let j=0;j<3;j++){const base=(i===j?p.perp0:0)+p.anis0*n[i]*n[j];out[i*3+j]+=dw*dr*base+w*((i===j?p.perpSlope*dr:0)+p.anisSlope*dr*n[i]*n[j]+p.anis0*(dn[i]*n[j]+n[i]*dn[j]));}}return out;}
function finiteDifference(prepared,u,deltaQ){const plus=prepared.positions.map((p,i)=>p.map((v,k)=>v+deltaQ*u[i][k])),minus=prepared.positions.map((p,i)=>p.map((v,k)=>v-deltaQ*u[i][k]));const a=alpha(prepared,plus),b=alpha(prepared,minus);return a.map((v,i)=>(v-b[i])/(2*deltaQ));}
function activity(real,imag=Array(9).fill(0)){const square=(a,b)=>a*a+b*b,mean=[(real[0]+real[4]+real[8])/3,(imag[0]+imag[4]+imag[8])/3];const gamma=.5*([ [0,4],[4,8],[8,0] ].reduce((sum,[a,b])=>sum+square(real[a]-real[b],imag[a]-imag[b]),0)+6*[1,2,5].reduce((sum,k)=>sum+square(real[k],imag[k]),0));return 45*square(...mean)+7*gamma;}
function mode(prepared,band,index=0,stepScale=1,auditFiniteDifference=true){
 if(!Number.isFinite(band.frequencyTHz)||!Array.isArray(band.eigenvector)||band.eigenvector.length!==prepared.atoms.length)throw Error('A complete Gamma eigenvector is required.');
 let norm=0;const real=[],imag=[];for(let i=0;i<prepared.atoms.length;i++){const e=band.eigenvector[i];if(!Array.isArray(e)||e.length!==3||e.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))throw Error('Invalid complex eigenvector.');const mass=prepared.atoms[i].mass;real.push(e.map(p=>p[0]/Math.sqrt(mass)));imag.push(e.map(p=>p[1]/Math.sqrt(mass)));for(const p of e)norm+=p[0]*p[0]+p[1]*p[1];}
 if(Math.abs(norm-1)>1e-6)throw Error('Gamma eigenvectors must be normalized (sum |e|² = 1).');
 const tensorReal=derivative(prepared,real),tensorImag=derivative(prepared,imag);let deltaQ=null,fdError=null;
 if(auditFiniteDifference){
  const maxU=Math.max(...real.map((v,i)=>Math.sqrt(dot(v,v)+dot(imag[i],imag[i]))));deltaQ=P.manifest.finiteDifferenceMaxAtom_A*stepScale/maxU;
  if(!Number.isFinite(deltaQ)||deltaQ<=0)throw Error('Invalid normal-coordinate step.');
  const fdReal=finiteDifference(prepared,real,deltaQ),fdImag=finiteDifference(prepared,imag,deltaQ),scale=Math.max(1,...tensorReal.map(Math.abs),...tensorImag.map(Math.abs));
  fdError=Math.max(...tensorReal.map((x,i)=>Math.abs(x-fdReal[i])),...tensorImag.map((x,i)=>Math.abs(x-fdImag[i])))/scale;
  if(!Number.isFinite(fdError))throw Error('Nonfinite BPM audit.');
  if(fdError>1e-5)throw Error('BPM analytic/finite-difference audit failed: '+fdError+'.');
 }
 if(!tensorReal.every(Number.isFinite)||!tensorImag.every(Number.isFinite))throw Error('Nonfinite BPM tensor.');
 const value=activity(tensorReal,tensorImag);if(!Number.isFinite(value))throw Error('Nonfinite BPM activity.');return {modeIndex:index,frequencyTHz:band.frequencyTHz,frequencyCm:band.frequencyTHz*1e12/(299792458*100),tensorReal,tensorImag,activity:value,activityPerVolume:value/prepared.volume,deltaQ_A_sqrt_amu:deltaQ,fdError,status:band.frequencyTHz<0?'Imaginary':band.frequencyTHz<P.manifest.positiveSpectrumCutoff_THz?'Near zero':'Optical-frequency'};
}
function spectrum(modes,fwhm=10,options={}){
 if(!Number.isFinite(fwhm)||fwhm<=0||fwhm>200)throw Error('Linewidth must be between 0 and 200 cm⁻¹.');
 const active=modes.filter(m=>m.frequencyTHz>=P.manifest.positiveSpectrumCutoff_THz&&m.activity>0);
 // The domain belongs to all input Gamma frequencies, not only nonzero responses.
 // The optional full list keeps the domain stable while modes finish in a Worker.
 const frequencies=options.fullFrequenciesCm||modes.map(m=>Number.isFinite(m.frequencyCm)?m.frequencyCm:m.frequencyTHz*1e12/(299792458*100));
 if(!Array.isArray(frequencies)||frequencies.some(x=>!Number.isFinite(x)))throw Error('Spectrum domain requires finite Gamma frequencies.');
 const fullMax=Math.max(100,...frequencies.filter(x=>x>=0).map(x=>x+8*fwhm),...active.map(m=>m.frequencyCm+8*fwhm));
 const requested=options.rangeCm||[0,fullMax];if(!Array.isArray(requested)||requested.length!==2||!requested.every(Number.isFinite)||requested[0]<0||requested[1]<=requested[0])throw Error('Spectrum range requires 0 ≤ Min < Max.');
 const resolved=Math.max(0,...active.map(m=>m.activity))>P.manifest.activityResolution;
 const density=x=>active.reduce((sum,m)=>sum+m.activity*(fwhm/2)/Math.PI/((x-m.frequencyCm)**2+(fwhm/2)**2),0);
 // Coarse background plus exact centers/half-widths and local FWHM/32 sampling.
 // Full-result normalization is computed before any requested view crop.
 const grid=new Set([0,fullMax]);const pitch=Math.max(.25,fullMax/12000);
 for(let i=0;i*pitch<fullMax;i++)grid.add(i*pitch);
 for(const m of active){for(let k=-64;k<=64;k++){const x=m.frequencyCm+k*fwhm/32;if(x>=0&&x<=fullMax)grid.add(x);}for(let k=9;k<=32;k++)for(const sign of [-1,1]){const x=m.frequencyCm+sign*k*fwhm/4;if(x>=0&&x<=fullMax)grid.add(x);}if(grid.size>150000)throw Error('Spectrum sampling exceeds 150,000 points; raw modes are preserved.');}
 if(grid.size>150000)throw Error('Spectrum sampling exceeds 150,000 points; no silent coarsening was applied. Raw modes are preserved.');
 const full=[...grid].sort((a,b)=>a-b).map(x=>[x,density(x)]);let peak=0;for(const row of full)peak=Math.max(peak,row[1]);
 const [lo,hi]=requested,visible=full.filter(r=>r[0]>lo&&r[0]<hi);if(hi>fullMax){const step=Math.max(.25,(hi-lo)/12000);for(let i=Math.max(1,Math.floor((fullMax-lo)/step)+1);lo+i*step<hi;i++){const x=lo+i*step;if(x>lo)visible.push([x,density(x)]);}}if(visible.length>150000)throw Error('Requested spectrum view exceeds 150,000 points; raw modes are preserved.');visible.unshift([lo,density(lo)]);visible.push([hi,density(hi)]);
 return visible.map(([x,y])=>[x,y,peak>0&&resolved?100*y/peak:0]);
}
root.RamanCore=Object.freeze({prepare,alpha,derivative,finiteDifference,activity,mode,spectrum,switching});if(typeof module!=='undefined')module.exports=root.RamanCore;
})(globalThis);
