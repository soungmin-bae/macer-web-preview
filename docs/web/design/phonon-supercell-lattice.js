/* Integer-lattice helpers for general (non-diagonal) phonon supercells. */
(function(root){
  'use strict';
  const det3=m=>m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],norm=a=>Math.hypot(...a);
  function validate(matrix,maxDeterminant=512){
    if(!Array.isArray(matrix)||matrix.length!==3||matrix.some(row=>!Array.isArray(row)||row.length!==3||row.some(x=>!Number.isSafeInteger(x))))throw Error('Supercell matrix must be a 3 × 3 integer matrix.');
    const determinant=det3(matrix),index=Math.abs(determinant);
    if(!Number.isSafeInteger(determinant)||index<1||index>maxDeterminant)throw Error(`Supercell matrix determinant must be between 1 and ${maxDeterminant}.`);
    return {determinant,index,sign:Math.sign(determinant)};
  }
  function adjugate(m){
    const cof=(i,j)=>{const rows=[0,1,2].filter(k=>k!==i),cols=[0,1,2].filter(k=>k!==j);return ((i+j)%2?-1:1)*(m[rows[0]][cols[0]]*m[rows[1]][cols[1]]-m[rows[0]][cols[1]]*m[rows[1]][cols[0]]);};
    return [0,1,2].map(i=>[0,1,2].map(j=>cof(j,i)));
  }
  function keyForTranslation(n,adj,index,sign){
    return n.map((_,column)=>{
      // n is a row vector; the fractional supercell coordinate is n M^-1.
      const numerator=sign*(n[0]*adj[0][column]+n[1]*adj[1][column]+n[2]*adj[2][column]);
      return ((numerator%index)+index)%index;
    }).join(',');
  }
  function translationRepresentatives(matrix,{maxDeterminant=512}={}){
    const {index,sign}=validate(matrix,maxDeterminant),adj=adjugate(matrix),origin=[0,0,0],queue=[origin],seen=new Map();
    for(let cursor=0;cursor<queue.length&&seen.size<index;cursor++){
      const n=queue[cursor],key=keyForTranslation(n,adj,index,sign);
      if(seen.has(key))continue;
      seen.set(key,n);
      for(let axis=0;axis<3;axis++){const next=n.slice();next[axis]++;queue.push(next);}
      if(queue.length>index*4+4)throw Error('Integer supercell quotient enumeration exceeded its safety bound.');
    }
    if(seen.size!==index)throw Error(`Integer supercell quotient is incomplete (${seen.size}/${index} translations).`);
    const entries=[...seen.entries()];
    return {determinant:index,translations:entries.map(([,n])=>n),fractionalCoordinates:entries.map(([key])=>key.split(',').map(x=>Number(x)/index)),keyByTranslation:n=>keyForTranslation(n,adj,index,sign)};
  }
  function cellForMatrix(matrix,cell){
    validate(matrix);
    if(!Array.isArray(cell)||cell.length!==3||cell.some(row=>!Array.isArray(row)||row.length!==3||row.some(x=>!Number.isFinite(x))))throw Error('Primitive cell must contain three finite Cartesian lattice vectors.');
    return matrix.map(row=>[0,1,2].map(axis=>row.reduce((sum,x,i)=>sum+x*cell[i][axis],0)));
  }
  function inverseReal(m){
    const d=det3(m);if(!Number.isFinite(d)||Math.abs(d)<1e-12)throw Error('Cell is singular or numerically singular.');
    const c=[0,1,2].map(i=>[0,1,2].map(j=>{const rows=[0,1,2].filter(k=>k!==i),cols=[0,1,2].filter(k=>k!==j);return ((i+j)%2?-1:1)*(m[rows[0]][cols[0]]*m[rows[1]][cols[1]]-m[rows[0]][cols[1]]*m[rows[1]][cols[0]]);}));
    return [0,1,2].map(i=>[0,1,2].map(j=>c[j][i]/d));
  }
  function multiply(a,b){return a.map(row=>b[0].map((_,j)=>row.reduce((sum,x,i)=>sum+x*b[i][j],0)));}
  function transpose(m){return m[0].map((_,j)=>m.map(row=>row[j]));}
  function supercellFractional(position,matrix){
    validate(matrix);if(!Array.isArray(position)||position.length!==3||position.some(x=>!Number.isFinite(x)))throw Error('Primitive fractional position must contain three finite coordinates.');
    const inverse=inverseReal(matrix),f=position.map((_,j)=>position.reduce((sum,x,i)=>sum+x*inverse[i][j],0));
    return f.map(x=>((x%1)+1)%1);
  }
  function rotationPreservesSupercell(matrix,rotation,tolerance=1e-8){
    validate(matrix);if(!Array.isArray(rotation)||rotation.length!==3||rotation.some(row=>!Array.isArray(row)||row.length!==3||row.some(x=>!Number.isFinite(x))))throw Error('Rotation must be a finite 3 × 3 matrix.');
    const basis=transpose(matrix),transformed=multiply(multiply(inverseReal(basis),rotation),basis);
    return transformed.every(row=>row.every(x=>Math.abs(x-Math.round(x))<=tolerance));
  }
  function nearCubicMatrix(cell,targetDeterminant,searchLimit=1){
    const volume=Math.abs(det3(cell));if(!Number.isFinite(volume)||volume<1e-12)throw Error('Cell is singular or numerically singular.');
    const ideal=inverseReal(cell).map(row=>row.map(x=>x*Math.cbrt(targetDeterminant*volume)));
    const start=ideal.map(row=>row.map(Math.round)),ranges=2*searchLimit+1,total=ranges**9;
    let best=null,bestScore=Infinity,bestDistance=Infinity;
    for(let code=0;code<total;code++){
      let value=code;const m=start.map(row=>row.slice());
      for(let k=0;k<9;k++){const offset=value%ranges-searchLimit;value=Math.floor(value/ranges);m[Math.floor(k/3)][k%3]+=offset;}
      const d=det3(m);if(Math.abs(d)!==targetDeterminant)continue;
      const transformed=cellForMatrix(m,cell),v=Math.abs(det3(transformed)),scale=Math.cbrt(v),score=transformed.reduce((sum,row,i)=>sum+row.reduce((s,x,j)=>{const gram=dot(row,transformed[j])/(scale*scale);return s+(gram-(i===j?1:0))**2;},0),0);
      const distance=m.reduce((sum,row,i)=>sum+row.reduce((s,x,j)=>s+(x-ideal[i][j])**2,0),0);
      if(score<bestScore-1e-12||(Math.abs(score-bestScore)<1e-12&&distance<bestDistance)){best=m;bestScore=score;bestDistance=distance;}
    }
    if(best&&det3(best)<0)best=best.map(row=>row.map(x=>-x));
    return best?{matrix:best,shapeScore:Math.sqrt(bestScore)}:null;
  }
  function shortestLatticeVector(cell,{maxCoefficient=12}={}){
    const inv=inverseReal(cell),inverseFrobenius=Math.sqrt(inv.flat().reduce((sum,x)=>sum+x*x,0)),upper=Math.min(...cell.map(norm)),bound=Math.ceil(upper*inverseFrobenius+1e-12);
    if(bound>maxCoefficient)throw Error(`Cell is too ill-conditioned for the bounded shortest-vector check (coefficient bound ${bound}, limit ${maxCoefficient}).`);
    let shortest=upper;
    for(let a=-bound;a<=bound;a++)for(let b=-bound;b<=bound;b++)for(let c=-bound;c<=bound;c++){
      if(a===0&&b===0&&c===0)continue;
      const length=norm([0,1,2].map(j=>a*cell[0][j]+b*cell[1][j]+c*cell[2][j]));if(length<shortest)shortest=length;
    }
    return shortest;
  }
  function selectNearCubic(cell,minLength,{maxDeterminant=null,searchLimit=1,tolerance=1e-8}={}){
    if(!Array.isArray(cell)||cell.length!==3||cell.some(row=>!Array.isArray(row)||row.length!==3||row.some(x=>!Number.isFinite(x))))throw Error('Primitive cell must contain three finite Cartesian lattice vectors.');
    if(!Number.isFinite(minLength)||minLength<=0)throw Error('Minimum periodic length must be positive and finite.');
    if(!Number.isInteger(searchLimit)||searchLimit<1||searchLimit>2)throw Error('Search limit must be an integer from 1 to 2.');
    const heights=cell.map((_,i)=>Math.abs(det3(cell))/norm(cross(cell[(i+1)%3],cell[(i+2)%3]))),repeats=heights.map(h=>Math.max(1,Math.ceil(minLength/h)));
    const diagonal=repeats.map((x,i)=>[0,1,2].map(j=>i===j?x:0)),diagonalCell=cellForMatrix(diagonal,cell),diagonalDet=det3(diagonal),volume=Math.abs(det3(cell));
    const packingLowerBound=Math.ceil(minLength**3/(Math.sqrt(2)*volume)),candidateLimit=maxDeterminant==null?Math.max(2*Math.abs(diagonalDet),24,2*packingLowerBound):maxDeterminant;
    if(!Number.isInteger(candidateLimit)||candidateLimit<1||candidateLimit>512)throw Error('Near-cubic determinant search limit must be an integer from 1 to 512.');
    const candidates=new Map();
    const add=(matrix,score)=>{const determinant=Math.abs(det3(matrix)),candidateCell=cellForMatrix(matrix,cell),shortest=shortestLatticeVector(candidateCell);if(shortest+tolerance<minLength)return;const key=matrix.flat().join(',');candidates.set(key,{matrix,determinant,cell:candidateCell,shortestLatticeVector:shortest,shapeScore:score??(()=>{const s=Math.cbrt(Math.abs(det3(candidateCell))),g=candidateCell.map(row=>candidateCell.map(col=>dot(row,col)/(s*s)));return Math.sqrt(g.reduce((sum,row,i)=>sum+row.reduce((x,y,j)=>x+(y-(i===j?1:0))**2,0),0));})()});};
    add(diagonal);
    for(let determinant=1;determinant<=candidateLimit;determinant++){
      const candidate=nearCubicMatrix(cell,determinant,searchLimit);if(candidate)add(candidate.matrix,candidate.shapeScore);
    }
    const feasible=[...candidates.values()];if(!feasible.length)throw Error(`No feasible supercell found up to determinant ${candidateLimit} for minimum length ${minLength} Å.`);
    feasible.sort((a,b)=>a.determinant-b.determinant||a.shapeScore-b.shapeScore||a.matrix.flat().join(',').localeCompare(b.matrix.flat().join(',')));
    const selected=feasible[0];return {...selected,minLength,candidateLimit,diagonal:{matrix:diagonal,determinant:Math.abs(diagonalDet),cell:diagonalCell,shortestLatticeVector:shortestLatticeVector(diagonalCell)}};
  }
  const api=Object.freeze({validate,translationRepresentatives,cellForMatrix,supercellFractional,rotationPreservesSupercell,shortestLatticeVector,nearCubicMatrix,selectNearCubic});
  root.PhononSupercellLattice=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
})(globalThis);
