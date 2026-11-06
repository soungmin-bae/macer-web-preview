/* Compact DFT-trained Born tensor inference. Pure structure response; no force model. */
(function(root){'use strict';
const S=root.Structures,cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm=a=>Math.hypot(...a);
function predict(data,model){
 const start=typeof performance==='object'?performance.now():0;if(model.schema!=='macer-small-born-v1')throw Error('Unsupported small Born model.');
 const cell=data.lattice,N=data.atoms?.length;if(!N||!Array.isArray(cell)||cell.length!==3||cell.some(r=>r.length!==3||!r.every(Number.isFinite)))throw Error('Small Born requires a periodic 3D structure.');const det=S.determinant(cell);if(Math.abs(det)<1e-10)throw Error('Small Born lattice is singular.');
 const zs=data.atoms.map(a=>S.atomicNumber(a.element));if(zs.some(z=>!model.supportedAtomicNumbers.includes(z)))throw Error('Small Born has insufficient training coverage for '+data.atoms.filter((a,i)=>!model.supportedAtomicNumbers.includes(zs[i])).map(a=>a.element).join(', ')+'. Use explicit charges or BORN.');
 const f=data.atoms.map(a=>{if(!a.fractional?.every(Number.isFinite)||a.fractional.length!==3)throw Error('Invalid fractional coordinates.');return a.fractional;});const cfg=model.features,dual=[cross(cell[1],cell[2]),cross(cell[2],cell[0]),cross(cell[0],cell[1])].map(v=>v.map(x=>x/det)),reach=dual.map(v=>cfg.cutoffA*norm(v)),K=cfg.centersA.length,C=cfg.neighborEmbedding[0].length,M=K*C;let candidates=0,edges=0;const raw=[];
 function network(x){for(let l=0;l<model.layers.length;l++){const layer=model.layers[l],y=Array.from(layer.bias,(b,i)=>{let v=b;for(let j=0;j<x.length;j++)v+=layer.weight[i][j]*x[j];return v;});x=l===model.layers.length-1?y:y.map(v=>v>=0?v/(1+Math.exp(-v)):v*Math.exp(v)/(1+Math.exp(v)));}return x;}
 for(let i=0;i<N;i++){
  const scalar=Array(M).fill(0),vec=Array.from({length:M},()=>[0,0,0]),tensor=Array.from({length:M},()=>Array(9).fill(0));
  for(let j=0;j<N;j++){
   const df=f[j].map((v,k)=>v-f[i][k]),bounds=reach.map((r,k)=>[Math.ceil(-df[k]-r-1e-10),Math.floor(-df[k]+r+1e-10)]);candidates+=bounds.reduce((s,[lo,hi])=>s*Math.max(0,hi-lo+1),1);if(candidates>2000000)throw Error('Small Born neighbor budget exceeded; input was not reduced.');
   for(let a=bounds[0][0];a<=bounds[0][1];a++)for(let b=bounds[1][0];b<=bounds[1][1];b++)for(let c=bounds[2][0];c<=bounds[2][1];c++){
    const D=S.cartesian([df[0]+a,df[1]+b,df[2]+c],cell),r=norm(D);if(r<1e-8||r>=cfg.cutoffA)continue;edges++;const n=D.map(v=>v/r),cut=.5*(Math.cos(Math.PI*r/cfg.cutoffA)+1),emb=cfg.neighborEmbedding[zs[j]];
    for(let k=0;k<K;k++){const rb=Math.exp(-.5*((r-cfg.centersA[k])/cfg.widthA)**2)*cut;for(let ch=0;ch<C;ch++){const t=k*C+ch,w=rb*emb[ch];scalar[t]+=w;for(let x=0;x<3;x++){vec[t][x]+=w*n[x];for(let y=0;y<3;y++)tensor[t][3*x+y]+=w*(n[x]*n[y]-(x===y?1/3:0));}}}
   }
  }
  const inv=[...scalar,...vec.map(v=>Math.sqrt(v.reduce((s,x)=>s+x*x,0)+1e-12)),...tensor.map(v=>Math.sqrt(v.reduce((s,x)=>s+x*x,0)+1e-12))];const x=[...model.centralEmbedding[zs[i]],...inv.map((v,k)=>Math.max(-10,Math.min(10,(v-model.normalization.mean[k])/model.normalization.std[k])))],coeff=network(x),out=Array(9).fill(0);for(let k=0;k<3;k++)out[3*k+k]=coeff[0];
  for(let t=0;t<M;t++)for(let k=0;k<9;k++)out[k]+=coeff[t+1]*tensor[t][k]/model.normalization.bscale[t+1];
  for(let p=0;p<3;p++){
   const a=[0,0,0],b=[0,0,0];for(let k=0;k<M;k++)for(let t=0;t<3;t++){a[t]+=cfg.antisymmetricMix[p][0][k]*vec[k][t];b[t]+=cfg.antisymmetricMix[p][1][k]*vec[k][t];}
   for(let q=0;q<3;q++)for(let t=0;t<3;t++)out[3*q+t]+=coeff[M+1+p]*(a[q]*b[t]-b[q]*a[t])/model.normalization.bscale[M+1+p];
  }
  if(!out.every(Number.isFinite))throw Error('Nonfinite small Born prediction.');raw.push(out);
 }
 const mean=Array.from({length:9},(_,k)=>raw.reduce((s,r)=>s+r[k],0)/N),tensors=raw.map(r=>r.map((v,k)=>v-mean[k]));return {tensors,rawTensors:raw,modelId:model.id,diagnostics:{atoms:N,edges,rawASRmax:Math.max(...mean.map(x=>Math.abs(x*N))),correctionMax:Math.max(...mean.map(Math.abs)),projectedASRmax:Math.max(...Array.from({length:9},(_,k)=>Math.abs(tensors.reduce((s,r)=>s+r[k],0)))),seconds:typeof performance==='object'?(performance.now()-start)/1000:null},qualification:'Experimental; held-out accuracy gates not all passed; not a DFT replacement.'};
}
function decode(buffer){const view=new DataView(buffer),length=view.getUint32(0,true);if(length>100000||length+4>buffer.byteLength)throw Error('Invalid small Born header.');const model=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,4,length)));if(model.format!=='json-header-f32le-v1')throw Error('Unsupported small Born format.');const weights=new Float32Array(buffer,4+length);model.layers=model.packedLayers.map(l=>({weight:Array.from({length:l.rows},(_,i)=>weights.subarray(l.offset+i*l.cols,l.offset+(i+1)*l.cols)),bias:weights.subarray(l.offset+l.rows*l.cols,l.offset+l.rows*l.cols+l.rows)}));return model;}
async function load(runtime){const response=await fetch(runtime.url,{cache:'force-cache'});if(!response.ok)throw Error('Small Born model download failed.');const buffer=await response.arrayBuffer();if(buffer.byteLength!==runtime.bytes)throw Error('Small Born model size mismatch.');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');if(digest!==runtime.sha256)throw Error('Small Born model hash mismatch.');return decode(buffer);}
root.BornStudent=Object.freeze({predict,decode,load});if(typeof module!=='undefined')module.exports=root.BornStudent;
})(globalThis);
