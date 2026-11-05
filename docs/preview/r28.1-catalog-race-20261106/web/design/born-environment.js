/* Two-hop covariant response inference. Full periodic neighborhoods; no force approximation. */
(function(root){'use strict';
function predict(data,model){
 const start=performance.now(),N=data.atoms?.length,cell=data.lattice,S=root.Structures,cfg=model.features,M=48;
 if(model.schema!=='macer-small-born-environment-v2'||!N||!Array.isArray(cell)||cell.length!==3||cell.some(r=>r.length!==3||!r.every(Number.isFinite)))throw Error('Environment Born requires a valid periodic structure.');
 const det=S.determinant(cell);if(Math.abs(det)<1e-10)throw Error('Environment Born lattice is singular.');const zs=data.atoms.map(a=>S.atomicNumber(a.element));if(zs.some(z=>!model.supportedAtomicNumbers.includes(z)))throw Error('Insufficient environment-model training coverage. Use explicit BORN.');
 const f=data.atoms.map(a=>{if(a.fractional?.length!==3||!a.fractional.every(Number.isFinite))throw Error('Invalid fractional coordinates.');return a.fractional;});
 const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],dual=[cross(cell[1],cell[2]),cross(cell[2],cell[0]),cross(cell[0],cell[1])].map(v=>v.map(x=>x/det)),reach=dual.map(v=>6*Math.hypot(...v));
 const ss=new Float64Array(N*M),vv=new Float64Array(N*M*3),tt=new Float64Array(N*M*9),edges=[];let candidates=0;
 for(let i=0;i<N;i++)for(let j=0;j<N;j++){
  const d0=f[j][0]-f[i][0],d1=f[j][1]-f[i][1],d2=f[j][2]-f[i][2],l0=Math.ceil(-d0-reach[0]-1e-10),h0=Math.floor(-d0+reach[0]+1e-10),l1=Math.ceil(-d1-reach[1]-1e-10),h1=Math.floor(-d1+reach[1]+1e-10),l2=Math.ceil(-d2-reach[2]-1e-10),h2=Math.floor(-d2+reach[2]+1e-10);
  candidates+=Math.max(0,h0-l0+1)*Math.max(0,h1-l1+1)*Math.max(0,h2-l2+1);if(candidates>2000000)throw Error('Environment Born neighbor budget exceeded; input was not reduced.');
  for(let a=l0;a<=h0;a++)for(let b=l1;b<=h1;b++)for(let c=l2;c<=h2;c++){
   const x=(d0+a)*cell[0][0]+(d1+b)*cell[1][0]+(d2+c)*cell[2][0],y=(d0+a)*cell[0][1]+(d1+b)*cell[1][1]+(d2+c)*cell[2][1],z=(d0+a)*cell[0][2]+(d1+b)*cell[1][2]+(d2+c)*cell[2][2],r=Math.hypot(x,y,z);if(r<1e-8||r>=6)continue;
   const n=[x/r,y/r,z/r],t=[n[0]*n[0]-1/3,n[0]*n[1],n[0]*n[2],n[1]*n[0],n[1]*n[1]-1/3,n[1]*n[2],n[2]*n[0],n[2]*n[1],n[2]*n[2]-1/3],cut=.5*(Math.cos(Math.PI*r/6)+1),emb=cfg.neighborEmbedding[zs[j]];edges.push({i,j,n,t,r,cut});
   for(let k=0;k<6;k++){const rb=Math.exp(-.5*((r-cfg.centersA[k])/cfg.widthA)**2)*cut;for(let ch=0;ch<8;ch++){const index=i*M+k*8+ch,w=rb*emb[ch],v=index*3,q=index*9;ss[index]+=w;vv[v]+=w*n[0];vv[v+1]+=w*n[1];vv[v+2]+=w*n[2];for(let h=0;h<9;h++)tt[q+h]+=w*t[h];}}
  }
 }
 const context=new Float64Array(N*8);for(let i=0;i<N;i++)for(let c=0;c<8;c++){let v=cfg.neighborEmbedding[zs[i]][c];for(let k=0;k<M;k++)v+=(Math.fround(ss[i*M+k])-cfg.environmentMean[k])/cfg.environmentStd[k]*cfg.environmentProjection[k][c];context[i*8+c]=Math.tanh(v);}
 const s2=new Float64Array(N*8),v2=new Float64Array(N*8*3),t2=new Float64Array(N*8*9);
 for(const e of edges){const rb=Math.exp(-.5*((e.r-cfg.environmentCenterA)/cfg.environmentWidthA)**2)*e.cut;for(let ch=0;ch<8;ch++){const index=e.i*8+ch,w=rb*context[e.j*8+ch],v=index*3,q=index*9;s2[index]+=w;v2[v]+=w*e.n[0];v2[v+1]+=w*e.n[1];v2[v+2]+=w*e.n[2];for(let h=0;h<9;h++)t2[q+h]+=w*e.t[h];}}
 const raw=[];
 for(let i=0;i<N;i++){
  const scalar=[],vn=[],tn=[],sv2=[],vv2=[],tv2=[];for(let k=0;k<M;k++){const q=i*M+k;scalar.push(ss[q]);vn.push(Math.sqrt(vv[q*3]**2+vv[q*3+1]**2+vv[q*3+2]**2+1e-12));let v=1e-12;for(let h=0;h<9;h++)v+=tt[q*9+h]**2;tn.push(Math.sqrt(v));}
  for(let k=0;k<8;k++){const q=i*8+k;sv2.push(s2[q]);vv2.push(Math.sqrt(v2[q*3]**2+v2[q*3+1]**2+v2[q*3+2]**2+1e-12));let v=1e-12;for(let h=0;h<9;h++)v+=t2[q*9+h]**2;tv2.push(Math.sqrt(v));}
  const inv=[...scalar,...vn,...tn,...sv2,...vv2,...tv2];let input=[...model.centralEmbedding[zs[i]],...inv.map((v,k)=>Math.max(-10,Math.min(10,(v-model.normalization.mean[k])/model.normalization.std[k])))];
  for(let l=0;l<model.layers.length;l++){const layer=model.layers[l],out=new Array(layer.bias.length);for(let a=0;a<out.length;a++){let v=layer.bias[a];for(let b=0;b<input.length;b++)v+=layer.weight[a][b]*input[b];out[a]=l===model.layers.length-1?v:(v>=0?v/(1+Math.exp(-v)):v*Math.exp(v)/(1+Math.exp(v)));}input=out;}
  const out=Array(9).fill(0);for(let k=0;k<3;k++)out[3*k+k]=input[0];for(let k=0;k<48;k++)for(let h=0;h<9;h++)out[h]+=input[1+k]*tt[(i*M+k)*9+h]/model.normalization.bscale[k+1];for(let k=0;k<8;k++)for(let h=0;h<9;h++)out[h]+=input[49+k]*t2[(i*8+k)*9+h]/model.normalization.bscale[49+k];
  for(let p=0;p<3;p++){const a=[0,0,0],b=[0,0,0];for(let k=0;k<48;k++)for(let h=0;h<3;h++){a[h]+=cfg.antisymmetricMix[p][0][k]*vv[(i*M+k)*3+h];b[h]+=cfg.antisymmetricMix[p][1][k]*vv[(i*M+k)*3+h];}for(let q=0;q<3;q++)for(let t=0;t<3;t++)out[3*q+t]+=input[57+p]*(a[q]*b[t]-b[q]*a[t])/model.normalization.bscale[57+p];}
  if(!out.every(Number.isFinite))throw Error('Nonfinite environment Born prediction.');raw.push(out);
 }
 const mean=Array.from({length:9},(_,k)=>raw.reduce((s,r)=>s+r[k],0)/N),tensors=raw.map(r=>r.map((v,k)=>v-mean[k]));return {tensors,rawTensors:raw,modelId:model.id,diagnostics:{atoms:N,edges:edges.length,candidates,rawASRmax:Math.max(...mean.map(x=>Math.abs(x*N))),correctionMax:Math.max(...mean.map(Math.abs)),projectedASRmax:Math.max(...Array.from({length:9},(_,k)=>Math.abs(tensors.reduce((s,r)=>s+r[k],0)))),seconds:(performance.now()-start)/1000},qualification:'Experimental DFT-trained two-hop Born model; qualification is fixture-specific.'};
}
root.BornEnvironment=Object.freeze({predict});if(typeof module!=='undefined')module.exports=root.BornEnvironment;
})(globalThis);
