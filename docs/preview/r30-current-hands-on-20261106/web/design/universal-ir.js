/* Periodic CT1 estimated dynamic charges. This is exploratory, not a qualified Born model. */
(function(root){'use strict';
const MODEL=()=>root.UniversalIRCT1Model;
const finite3=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
function determinant(a){return a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);}
function inverse(a){const d=determinant(a);if(!Number.isFinite(d)||Math.abs(d)<1e-10)throw Error('Universal charge-transfer estimate requires a nonsingular periodic cell.');return [
 [(a[1][1]*a[2][2]-a[1][2]*a[2][1])/d,(a[0][2]*a[2][1]-a[0][1]*a[2][2])/d,(a[0][1]*a[1][2]-a[0][2]*a[1][1])/d],
 [(a[1][2]*a[2][0]-a[1][0]*a[2][2])/d,(a[0][0]*a[2][2]-a[0][2]*a[2][0])/d,(a[0][2]*a[1][0]-a[0][0]*a[1][2])/d],
 [(a[1][0]*a[2][1]-a[1][1]*a[2][0])/d,(a[0][1]*a[2][0]-a[0][0]*a[2][1])/d,(a[0][0]*a[1][1]-a[0][1]*a[1][0])/d]
];}
function smoothCutoff(r,rc){if(r>=rc)return [0,0];const t=r/rc,t2=t*t,t3=t2*t,t4=t3*t,t5=t4*t,t6=t5*t,t7=t6*t;return [1-35*t4+84*t5-70*t6+20*t7,(-140*t3+420*t4-420*t5+140*t6)/rc];}
function gaussian(r,center,width){const z=(r-center)/width,v=Math.exp(-.5*z*z);return [v,-z/width*v];}
function radial(r,center,width,cutoff){const [g,gp]=gaussian(r,center,width),[c,cp]=smoothCutoff(r,cutoff);return [g*c,gp*c+g*cp];}
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm=a=>Math.hypot(a[0],a[1],a[2]);
function cart(frac,cell){return [0,1,2].map(k=>frac[0]*cell[0][k]+frac[1]*cell[1][k]+frac[2]*cell[2][k]);}
function lexPositive(s){for(const v of s){if(v>0)return true;if(v<0)return false;}return false;}
function neighbors(data,model){
 const cell=data.lattice,atoms=data.atoms,N=atoms.length,inv=inverse(cell),reach=[0,1,2].map(k=>model.parameters.neighborSkinAngstrom+model.parameters.cutoffAngstrom*Math.hypot(inv[0][k],inv[1][k],inv[2][k])),frac=atoms.map((a,i)=>{if(!finite3(a.fractional))throw Error('Invalid fractional coordinates at atom '+(i+1)+'.');return a.fractional;});
 const directed=[],pairs=[];let candidates=0;
 for(let i=0;i<N;i++)for(let j=0;j<N;j++){
  const df=[0,1,2].map(k=>frac[j][k]-frac[i][k]),lo=df.map((x,k)=>Math.ceil(-x-reach[k]-1e-10)),hi=df.map((x,k)=>Math.floor(-x+reach[k]+1e-10));
  const count=lo.reduce((n,x,k)=>n*Math.max(0,hi[k]-x+1),1);candidates+=count;if(candidates>2000000)throw Error('Universal charge-transfer neighbor budget exceeded (2,000,000 image candidates). Input was not reduced.');
  for(let s0=lo[0];s0<=hi[0];s0++)for(let s1=lo[1];s1<=hi[1];s1++)for(let s2=lo[2];s2<=hi[2];s2++){
   if(i===j&&s0===0&&s1===0&&s2===0)continue;
   const shift=[s0,s1,s2],delta=[0,1,2].map(k=>df[k]+shift[k]),d=cart(delta,cell),r=norm(d),R=model.parameters.cutoffAngstrom+model.parameters.neighborSkinAngstrom;
   if(r>=R+1e-12)continue;const edge={i,j,shift,d,r,u:d.map(x=>x/r)};directed.push(edge);
   if(i<j||(i===j&&lexPositive(shift)))pairs.push(edge);
  }
 }
 return {directed,pairs,candidates,frac};
}
function predict(data,model=MODEL(),options={}){
 const started=performance.now();if(!model||model.schema!=='macer-universal-ir-ct1-v1'||model.qualification!=='EXPLORATORY_NOT_QUALIFIED')throw Error('Unqualified universal IR model identity is unavailable.');
 if(!Array.isArray(data?.lattice)||data.lattice.length!==3||data.lattice.some(r=>!finite3(r))||!Array.isArray(data.atoms)||!data.atoms.length)throw Error('Universal charge-transfer estimate requires a periodic 3D structure.');
 const N=data.atoms.length,p=model.parameters,beta=p.beta,centers=p.radialCentersAngstrom,props=data.atoms.map((a,i)=>{const q=model.elements[a.element];if(!q)throw Error('UFF prior table does not cover '+a.element+' at atom '+(i+1)+'. No response was generated.');if(!Number.isFinite(a.mass)||a.mass<=0)throw Error('Positive atomic masses are required.');return [1,q.xiUFF,q.hardnessUFF,q.radiusUFF];});
 if(beta.length!==16||!Number.isFinite(p.scale)||props.some(v=>v.some(x=>!Number.isFinite(x))))throw Error('Universal charge-transfer model parameters are invalid.');
 const graph=neighbors(data,model),shells=4,counts=new Float64Array(N*shells),weighted=new Float64Array(N*shells*4),localValues=new Float64Array(N*16),localDerivative=new Float64Array(graph.directed.length),chi=new Float64Array(N);
 for(const e of graph.directed){if(e.r>=p.cutoffAngstrom)continue;for(let s=0;s<shells;s++){const [w]=radial(e.r,centers[s],p.radialWidthAngstrom,p.cutoffAngstrom),q=e.i*shells+s;counts[q]+=w;for(let c=0;c<4;c++)weighted[q*4+c]+=w*props[e.j][c];}}
 for(let i=0;i<N;i++)for(let s=0;s<shells;s++){const den=Math.max(counts[i*shells+s],1e-12);for(let c=0;c<4;c++)localValues[i*16+s*4+c]=weighted[(i*shells+s)*4+c]/den;}
 for(let i=0;i<N;i++){chi[i]=props[i][1];for(let k=0;k<16;k++)chi[i]+=beta[k]*localValues[i*16+k];}
 // Store the radial derivative of each center's learned local electronegativity.
 for(let eidx=0;eidx<graph.directed.length;eidx++){const e=graph.directed[eidx];if(e.r>=p.cutoffAngstrom)continue;let g=0;for(let s=0;s<shells;s++){const [w,wp]=radial(e.r,centers[s],p.radialWidthAngstrom,p.cutoffAngstrom),den=Math.max(counts[e.i*shells+s],1e-12);if(w===0&&wp===0)continue;for(let c=0;c<4;c++)g+=beta[s*4+c]*wp*(props[e.j][c]-localValues[e.i*16+s*4+c])/den;}localDerivative[eidx]=g;}
 const tensors=Array.from({length:N},()=>Array(9).fill(0)),gradChi=Array.from({length:N},()=>[0,0,0]),dipole=[0,0,0];let activePairs=0;
 for(const e of graph.pairs){if(e.r>=p.cutoffAngstrom)continue;const i=e.i,j=e.j,H=Math.max(props[i][2]+props[j][2],1e-8),delta=(chi[i]-chi[j])/H,tanh=Math.tanh(delta),sech2=1-tanh*tanh,[pw,pwp0]=radial(e.r,props[i][3]+props[j][3],p.pairWidthAngstrom,p.cutoffAngstrom),transfer=p.scale*tanh*pw,dTransferDr=p.scale*tanh*pwp0,unit=e.u;
  activePairs++;for(let k=0;k<3;k++){const d=e.d[k],chargeDerivative=p.scale*pw*sech2/H*d;dipole[k]+=transfer*d;if(i!==j){gradChi[i][k]+=chargeDerivative;gradChi[j][k]-=chargeDerivative;}}
  if(i!==j){for(let k=0;k<3;k++)for(let q=0;q<3;q++){const v=transfer*(k===q?1:0)+e.d[k]*dTransferDr*unit[q],ix=3*k+q;tensors[i][ix]-=v;tensors[j][ix]+=v;}}
 }
 // Chain all local-environment dependence through the shared chi_eff reverse pass.
 for(let eidx=0;eidx<graph.directed.length;eidx++){const e=graph.directed[eidx],g=localDerivative[eidx];if(g===0)continue;for(let k=0;k<3;k++){const a=gradChi[e.i][k]*g;for(let q=0;q<3;q++){const v=a*e.u[q],ix=3*k+q;tensors[e.j][ix]+=v;tensors[e.i][ix]-=v;}}}
 let asr=0;for(let ix=0;ix<9;ix++){let sum=0;for(let i=0;i<N;i++)sum+=tensors[i][ix];asr=Math.max(asr,Math.abs(sum));}
 if(tensors.some(t=>t.some(x=>!Number.isFinite(x))))throw Error('Universal charge-transfer derivative became non-finite.');
 if(asr>1e-8)throw Error('Universal charge-transfer derivative violates translational neutrality ('+asr+').');
 const result={schema:'macer-estimated-dynamic-charges-v1',tensors,source:'Universal CT1 estimated dynamic charges · unqualified',units:'e',inputKind:'universal-ct1',modelId:model.modelId,parameterSHA256:model.parameterSHA256,qualification:model.qualification,provenance:model.provenance,diagnostics:{atoms:N,directedEdges:graph.directed.length,pairImages:graph.pairs.length,activePairImages:activePairs,imageCandidates:graph.candidates,acousticSumRuleResidual:asr,seconds:(performance.now()-started)/1000}};
 if(typeof module!=='undefined'&&options.includeTestDipole===true)result.testDipole=dipole;
 if(typeof module!=='undefined'&&options.includeTestEdges===true)result.testEdges={directed:graph.directed.map(e=>[e.i,e.j,...e.shift]),pairs:graph.pairs.map(e=>[e.i,e.j,...e.shift])};
 return result;
}
root.UniversalIR=Object.freeze({predict});if(typeof module!=='undefined')module.exports=root.UniversalIR;
})(globalThis);
