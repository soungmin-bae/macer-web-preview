/* HPKOT path selection ported from SeeK-path 2.2.2 (MIT).
 * Coordinates are converted into the calculation primitive basis, including
 * Moyo's Cartesian standardization rotation. No assumed cubic fallback. */
(function(root){
 'use strict';
 const S=root.Structures,D=root.MacerSeekpathData;
 const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),norm=a=>Math.hypot(...a);
 const rows=x=>[0,1,2].map(i=>Array.from(x).slice(3*i,3*i+3));
 const transpose=m=>m[0].map((_,i)=>m.map(r=>r[i]));
 const reciprocal=cell=>[0,1,2].map(i=>S.fractional([+(i===0),+(i===1),+(i===2)],cell)); // Cartesian rows of inverse
 const qcart=(q,cell)=>reciprocal(cell).map(r=>dot(r,q));
 const realFromReciprocal=r=>transpose(reciprocal(r));
 // Only arithmetic and known table variables are accepted; never eval input.
 function expression(source,vars){
  const tokens=source.match(/(?:\d+(?:\.\d+)?|[A-Za-z_]+|[()+*/-])/g)||[];
  if(tokens.join('')!==source.replace(/\s/g,''))throw Error('Invalid HPKOT table expression.');
  let i=0;
  function atom(){const t=tokens[i++];if(t==='-')return -atom();if(t==='+')return atom();if(t==='('){const v=sum();if(tokens[i++]!==')')throw Error('Invalid HPKOT parentheses.');return v;}if(t!==undefined&&/^\d/.test(t))return Number(t);if(Object.hasOwn(vars,t))return vars[t];throw Error(`Unknown HPKOT parameter ${t}.`);}
  function product(){let v=atom();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++],w=atom();v=op==='*'?v*w:v/w;}return v;}
  function sum(){let v=product();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++],w=product();v=op==='+'?v+w:v-w;}return v;}
  const v=sum();if(i!==tokens.length||!Number.isFinite(v))throw Error('HPKOT path parameter is undefined for this metric.');return v;
 }
 function automatic(primitive,moyo,kernel,symprec=1e-5,samples=51){
  if(!Number.isInteger(samples)||samples<2||samples>501)throw Error('Samples per segment must be 2–501.');
  const d=moyo.analyze_cell(JSON.stringify({lattice:{basis:primitive.cell.flat()},positions:primitive.atoms.map(a=>S.fractional(a.position,primitive.cell)),numbers:primitive.atoms.map(a=>S.atomicNumber(a.element))}),symprec,'Spglib');
  const property=D.spacegroups[d.number],bravais=property[0]+property[1];
  let conv=rows(d.std_cell.lattice.basis),[a,b,c]=conv.map(norm);
  const ca=dot(conv[1],conv[2])/b/c,cb=dot(conv[0],conv[2])/a/c,cg=dot(conv[0],conv[1])/a/b;
  let ext;
  if(bravais==='cP'||bravais==='cF')ext=bravais+(d.number<=206?'1':'2');
  else if(['cI','tP','oP','mP'].includes(bravais))ext=bravais+'1';
  else if(bravais==='tI')ext=bravais+(c<=a?'1':'2');
  else if(bravais==='oF')ext=bravais+(1/a**2>1/b**2+1/c**2?'1':1/c**2>1/a**2+1/b**2?'2':'3');
  else if(bravais==='oI')ext=bravais+[[c,1],[b,3],[a,2]].sort((x,y)=>y[0]-x[0]||y[1]-x[1])[0][1];
  else if(bravais==='oC')ext=bravais+(a<=b?'1':'2');
  else if(bravais==='oA')ext=bravais+(b<=c?'1':'2');
  else if(bravais==='hP')ext=bravais+([143,144,145,146,147,148,149,151,153,157,159,160,161,162,163].includes(d.number)?'1':'2');
  else if(bravais==='hR')ext=bravais+(Math.sqrt(3)*a<=Math.sqrt(2)*c?'1':'2');
  else if(bravais==='mC')ext=bravais+(b<a*Math.sqrt(1-cb*cb)?'1':-a*cb/c+a*a*(1-cb*cb)/b/b<=1?'2':'3');
  else if(bravais==='aP'){
   if(!kernel?.phonon_niggli_reduce)throw Error('Triclinic automatic paths require the Niggli WASM kernel.');
   let rec=rows(kernel.phonon_niggli_reduce(transpose(reciprocal(conv)).flat()));
   const conditions=[Math.abs(dot(rec[1],rec[2])),Math.abs(dot(rec[2],rec[0])),Math.abs(dot(rec[0],rec[1]))];
   const k=conditions.indexOf(Math.min(...conditions)),permutations=[[1,2,0],[2,0,1],[0,1,2]];
   // Same cyclic permutations as HPKOT's column transformations M2.
   rec=permutations[k].map(i=>rec[i]);
   const u=dot(rec[1],rec[2])>0,v=dot(rec[0],rec[2])>0,w=dot(rec[0],rec[1])>0;
   const signs=(u===v&&v===w)?[1,1,1]:(v===w)?[1,-1,-1]:(u===w)?[-1,1,-1]:[-1,-1,1];
   rec=rec.map((r,i)=>r.map(x=>x*signs[i]));
   conv=realFromReciprocal(rec);
   ext=dot(rec[1],rec[2])<=0&&dot(rec[0],rec[2])<=0&&dot(rec[0],rec[1])<=0?'aP2':'aP3';
  }else throw Error(`Automatic q-path is unavailable for Bravais lattice ${bravais}. Enter a manual path.`);
  const vars={a,b,c,cosalpha:ca,cosbeta:cb,cosgamma:cg,sinbeta:Math.sqrt(1-cb*cb)},table=D.lattices[ext];
  if(!table)throw Error(`Missing HPKOT table ${ext}.`);
  for(const [key,expr] of table.parameters)vars[key]=expression(expr,vars);
  const P=D.primitiveMatrices[bravais],hpkot=transpose(P).map(r=>S.cartesian(r,conv));
  const rotation=transpose(rows(d.std_rotation_matrix)); // serialized nalgebra column-major
  const points={};
  for(const [label,coords] of Object.entries(table.points)){
   const qh=coords.map(s=>expression(s,vars)),standard=qcart(qh,hpkot);
   const original=transpose(rotation).map(r=>dot(r,standard));
   points[label]={label:label==='GAMMA'?'Γ':label,q:primitive.cell.map(r=>dot(r,original))};
  }
  return {cartesianStandardizationRotation:rotation,source:'SeeK-path 2.2.2 / HPKOT',bravais,extendedBravais:ext,spaceGroup:d.number,samples,points:Object.values(points),segments:table.segments.map(([a,b])=>[points[a],points[b]])};
 }
 root.PhononPath={automatic,expression,qcart};
 if(typeof module==='object'&&module.exports)module.exports=root.PhononPath;
})(globalThis);
