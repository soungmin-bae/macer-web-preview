/* Versioned, validated reference modes. Missing tensors remain missing. */
(function(root){'use strict';
const version='1.0.1',archive='1a03a98877643584ab0139f06879c8668962f89bf8709884751f3bdbdc36c4a4',finite=Number.isFinite;
function validate(r){
 const fail=t=>{throw Error('Reference rejected: '+t);},matrix=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(finite);
 if(r?.schema!=='macer-spectroscopy-reference-v1'||r.provider!=='CRD'||r.version!==version||!/^mp-\d+$/.test(r.id)||r.provenance?.archiveSHA256!==archive||r.provenance?.license!=='CC BY 4.0')fail('provider/version/provenance');
 if(r.provenance.sourceURL!=='https://ramandb.oulu.fi/ramandb/materials/row/'+r.id)fail('source URL');
 if(!Array.isArray(r.lattice)||r.lattice.length!==3||r.lattice.some(a=>!matrix(a,3))||Math.abs(root.Structures.determinant(r.lattice))<1e-8||!r.pbc?.every(x=>x===true)||r.pbc.length!==3)fail('periodic row-vector cell');
 const n=r.atoms?.length;if(!n||n>36||r.atoms.some(a=>!root.Structures.atomicNumber(a.element)||!finite(a.mass)||a.mass<=0||!matrix(a.fractional,3)))fail('atoms/masses');
 if(!Array.isArray(r.modes)||r.modes.length!==3*n)fail('3N mode count');
 for(const [i,m]of r.modes.entries()){
  if(m.modeIndex!==i||!finite(m.frequencyTHz)||!finite(m.frequencyCm)||Math.abs(m.frequencyCm-m.frequencyTHz*33.35640951981521)>1e-5||![-1,0,1].includes(m.ramanAllowedCode))fail('mode index/frequency/units');
  if(!Array.isArray(m.eigenvector)||m.eigenvector.length!==n||m.eigenvector.some(a=>!Array.isArray(a)||a.length!==3||a.some(v=>!matrix(v,2))))fail('complete complex eigenvectors');
  const norm=m.eigenvector.flat(2).reduce((s,x)=>s+x*x,0);if(Math.abs(norm-1)>1e-6)fail('eigenvector normalization');
  if(m.tensorReal===null){if(m.tensorImag!==null)fail('missing tensor pair');}else if(!matrix(m.tensorReal,9)||!matrix(m.tensorImag,9))fail('finite Cartesian tensor');
 }
 for(let i=0;i<r.modes.length;i++)for(let j=0;j<i;j++){let re=0,im=0;for(let a=0;a<n;a++)for(let k=0;k<3;k++){const x=r.modes[i].eigenvector[a][k],y=r.modes[j].eigenvector[a][k];re+=x[0]*y[0]+x[1]*y[1];im+=x[0]*y[1]-x[1]*y[0];}if(Math.hypot(re,im)>1e-6)fail('mode orthogonality');}
 return r;
}
function modes(r){validate(r);return r.modes.map(m=>({...m,activity:m.tensorReal===null?null:root.RamanCore.activity(m.tensorReal,m.tensorImag)}));}
function result(r){validate(r);return {kind:'reference-gamma',lattice:r.lattice,atoms:r.atoms,qpoints:[{q:[0,0,0],distance:0,label:'Γ',bands:r.modes.map(m=>({frequencyTHz:m.frequencyTHz,eigenvector:m.eigenvector}))}],segments:[],hasEigenvectors:true,units:'THz',path:{source:'CRD source Γ;NAC convention unverified',segments:[],samples:1},reference:{provider:r.provider,id:r.id,version:r.version,provenance:r.provenance}};}
function structure(r){validate(r);return {cell:r.lattice.map(x=>x.slice()),pbc:r.pbc.slice(),atoms:r.atoms.map(a=>({element:a.element,mass:a.mass,position:root.Structures.cartesian(a.fractional,r.lattice),mask:[true,true,true]})),comment:'CRD '+r.id+' v'+version,provenance:r.provenance};}
function compareGeometry(r,g,{cellTolerance=1e-5,positionTolerance=1e-4,massTolerance=1e-2}={}){
 validate(r);
 const fail=reason=>({match:false,reason});
 if(!g||!Array.isArray(g.lattice)||g.lattice.length!==3||!Array.isArray(g.atoms))return fail('No calculated periodic geometry is available.');
 if(g.atoms.length!==r.atoms.length)return fail(`Atom count differs (${g.atoms.length} vs ${r.atoms.length}).`);
 if(g.pbc&&!g.pbc.every(Boolean))return fail('Reference comparison requires periodic boundary conditions.');
 if(g.lattice.some(v=>!Array.isArray(v)||v.length!==3||v.some(x=>!finite(x))))return fail('Calculated lattice is invalid.');
 const refCell=r.lattice,calcCell=g.lattice,frac=a=>Array.isArray(a.fractional)?a.fractional:(Array.isArray(a.position)?root.Structures.fractional(a.position,calcCell):null),atoms=g.atoms.map(a=>({element:a.element,mass:a.mass,fractional:frac(a)}));
 if(atoms.some(a=>!a.element||!finite(a.mass)||!a.fractional||a.fractional.length!==3||!a.fractional.every(finite)))return fail('Calculated atom coordinates or masses are unavailable.');
 const ref=r.atoms, dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0), det=m=>m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
 const rows=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)for(let c=-1;c<=1;c++)rows.push([a,b,c]);
 const candidates=[];for(const a of rows)for(const b of rows)for(const c of rows){const m=[a,b,c],d=det(m);if(Math.abs(d)!==1)continue;const basis=m.map(row=>root.Structures.cartesian(row,refCell)),gRef=basis.map(x=>basis.map(y=>dot(x,y))),gCalc=calcCell.map(x=>calcCell.map(y=>dot(x,y))),scale=Math.max(1,...gRef.flat().map(Math.abs),...gCalc.flat().map(Math.abs));if(gRef.every((row,i)=>row.every((v,j)=>Math.abs(v-gCalc[i][j])<=cellTolerance*scale)))candidates.push(m);}
 if(!candidates.length)return fail('Lattice differs from the reference cell.');
 const wrap=x=>x-Math.round(x),matches=(mapped,shift)=>{
  const used=new Uint8Array(atoms.length);
  function assign(i){if(i===ref.length)return true;const a=ref[i];for(let j=0;j<atoms.length;j++){if(used[j])continue;const b=atoms[j];if(a.element!==b.element||Math.abs(a.mass-b.mass)>massTolerance)continue;const df=a.fractional.map((x,k)=>wrap(mapped[j][k]-shift[k]-x)),dr=root.Structures.cartesian(df,refCell);if(Math.hypot(...dr)>positionTolerance)continue;used[j]=1;if(assign(i+1))return true;used[j]=0;}return false;}
  return assign(0);
 };
 for(const m of candidates){const mapped=atoms.map(a=>m[0].map((_,j)=>a.fractional.reduce((s,x,k)=>s+x*m[k][j],0)));for(let anchor=0;anchor<ref.length;anchor++)for(let j=0;j<atoms.length;j++){if(ref[anchor].element!==atoms[j].element||Math.abs(ref[anchor].mass-atoms[j].mass)>massTolerance)continue;const shift=mapped[j].map((x,k)=>x-ref[anchor].fractional[k]);if(matches(mapped,shift))return {match:true,reason:'Lattice, periodic positions, elements and masses match the reference (allowing atom order, origin, equivalent cell basis and rigid cell rotation).'};}}
 const sameSpecies=Object.keys(ref.reduce((o,a)=>(o[a.element]=(o[a.element]||0)+1,o),{})).every(e=>ref.filter(a=>a.element===e).length===atoms.filter(a=>a.element===e).length);
 if(!sameSpecies)return fail('Element counts differ from the reference.');
 const massCompatible=ref.every(a=>atoms.some(b=>a.element===b.element&&Math.abs(a.mass-b.mass)<=massTolerance));
 if(!massCompatible)return fail('Atomic masses differ from the reference.');
 return fail('Periodic atomic coordinates differ from the reference.');
}
function formulaKey(text){const matches=[...String(text).matchAll(/([A-Z][a-z]?)(\d*)/g)];if(!matches.length||matches.map(x=>x[0]).join('')!==text)return null;const counts={};for(const m of matches){if(!root.Structures.atomicNumber(m[1]))return null;counts[m[1]]=(counts[m[1]]||0)+(m[2]?Number(m[2]):1);}const gcd=(a,b)=>b?gcd(b,a%b):a;let g=0;for(const n of Object.values(counts)){if(!Number.isSafeInteger(n)||n<1)return null;g=gcd(g,n);}return Object.keys(counts).sort().map(e=>e+counts[e]/g).join('-');}
function find(index,text){if(index?.schema!=='macer-spectroscopy-reference-index-v1'||index.version!==version||index.sourceArchiveSHA256!==archive||!Array.isArray(index.records))throw Error('Invalid reference index/version.');const q=text.trim(),key=formulaKey(q);return index.records.filter(r=>r.id===q||key&&formulaKey(r.formula)===key);}
root.SpectroscopyReference=Object.freeze({validate,modes,result,structure,compareGeometry,formulaKey,find,version,archive});if(typeof module!=='undefined')module.exports=root.SpectroscopyReference;
})(globalThis);
