// Device-side FIRE update for bounded fixed-cell Relax batches. The Worker
// keeps this state for the run and returns only complete, bounded segments.
export class GpuFireBatch {
  constructor(rt, positions, movableMask, seed = null) {
    if (!Array.isArray(positions) || !positions.length || positions.some(row=>row.length!==3)) {
      throw new Error('GPU FIRE requires a non-empty N x 3 position array');
    }
    if (!Array.isArray(movableMask) || movableMask.length!==positions.length*3 || movableMask.some(v=>v!==0&&v!==1)) {
      throw new Error('GPU FIRE requires an N x 3 binary mask');
    }
    this.rt=rt;this.atomCount=positions.length;this.coordinateCount=this.atomCount*3;
    this.scalarOffset=this.coordinateCount*2;this.stateLength=this.scalarOffset+5;
    const state=new Float32Array(this.stateLength);
    const seededPositions=seed?.positions||positions;
    if(!Array.isArray(seededPositions)||seededPositions.length!==this.atomCount||seededPositions.some(row=>row.length!==3))
      throw new Error('GPU FIRE seed position shape mismatch');
    seededPositions.flat().forEach((value,index)=>state[index]=value);
    const velocities=seed?.velocities||Array.from({length:this.atomCount},()=>[0,0,0]);
    if(!Array.isArray(velocities)||velocities.length!==this.atomCount||velocities.some(row=>row.length!==3))
      throw new Error('GPU FIRE seed velocity shape mismatch');
    velocities.flat().forEach((value,index)=>state[this.coordinateCount+index]=value);
    state[this.scalarOffset]=seed?.dt??0.1;state[this.scalarOffset+1]=seed?.alpha??0.1;
    state[this.scalarOffset+2]=seed?.positive??0;state[this.scalarOffset+3]=seed?.initialized?1:0;
    state[this.scalarOffset+4]=seed?.valid===false?0:1;
    this.state=rt.tensor(state,1,this.stateLength,false);
    this.mask=rt.tensor(movableMask,this.atomCount,3,false);
    this.positionSnapshots=[];
    this.code=this.shader();
  }

  shader() {
    const n=this.atomCount,count=this.coordinateCount,scalar=this.scalarOffset,len=this.stateLength;
    return `@group(0) @binding(0) var<storage, read> state: array<f32>;
@group(0) @binding(1) var<storage, read> forces: array<f32>;
@group(0) @binding(2) var<storage, read> movable: array<f32>;
@group(0) @binding(3) var<storage, read_write> next: array<f32>;
@compute @workgroup_size(1) fn main() {
  var force2=0.0;var power=0.0;var velocity2=0.0;
  for(var i=0u;i<${count}u;i++){
    let force=forces[i]*movable[i];let velocity=state[${count}u+i];
    force2=fma(force,force,force2);power=fma(velocity,force,power);velocity2=fma(velocity,velocity,velocity2);
  }
  let forceNorm=sqrt(force2);
  let valid=forceNorm>0.0&&forceNorm<1.0e30&&state[${scalar+4}u]>0.5;
  if(!valid){for(var i=0u;i<${len}u;i++){next[i]=state[i];}next[${scalar+4}u]=0.0;return;}
  var dt=state[${scalar}u];var alpha=state[${scalar+1}u];
  var positive=state[${scalar+2}u];var initialized=state[${scalar+3}u];
  if(initialized>0.5){
    if(power>0.0){
      let velocityNorm=sqrt(velocity2);
      for(var i=0u;i<${count}u;i++){
        let force=forces[i]*movable[i];
        next[${count}u+i]=(1.0-alpha)*state[${count}u+i]+alpha*force/forceNorm*velocityNorm;
      }
      if(positive>5.0){dt=min(dt*1.1,1.0);alpha=alpha*0.99;}
      positive=positive+1.0;
    }else{
      for(var i=0u;i<${count}u;i++){next[${count}u+i]=0.0;}
      alpha=0.1;dt=dt*0.5;positive=0.0;
    }
  }else{
    for(var i=0u;i<${count}u;i++){next[${count}u+i]=state[${count}u+i];}
    initialized=1.0;
  }
  var displacement2=0.0;
  for(var i=0u;i<${count}u;i++){
    let force=forces[i]*movable[i];
    let velocity=next[${count}u+i]+dt*force;
    next[${count}u+i]=velocity;
    let displacement=dt*velocity;displacement2=fma(displacement,displacement,displacement2);
  }
  let displacementNorm=sqrt(displacement2);
  var scale=1.0;if(displacementNorm>0.1){scale=0.1/displacementNorm;}
  for(var i=0u;i<${count}u;i++){
    let displacement=dt*next[${count}u+i]*scale;
    next[i]=state[i]+displacement;
  }
  next[${scalar}u]=dt;next[${scalar+1}u]=alpha;next[${scalar+2}u]=positive;
  next[${scalar+3}u]=initialized;next[${scalar+4}u]=1.0;
}`;
  }

  positionsTensor() {
    return {buffer:this.state.buffer,rows:this.atomCount,cols:3,size:this.coordinateCount,
      requiresGrad:false,dtype:'f32',grad:null};
  }

  static seedFromReadback(values, atomCount) {
    const count=atomCount*3,scalar=count*2;
    if(!values||values.length!==scalar+5||!values.every(Number.isFinite))throw new Error('GPU FIRE readback state is invalid');
    const matrix=data=>Array.from({length:atomCount},(_,i)=>Array.from(data.slice(i*3,(i+1)*3)));
    return {positions:matrix(values.slice(0,count)),velocities:matrix(values.slice(count,scalar)),
      dt:values[scalar],alpha:values[scalar+1],positive:values[scalar+2],initialized:values[scalar+3]>0.5,valid:values[scalar+4]>0.5};
  }

  step(forces) {
    if (!this.rt.evaluationActive) throw new Error('GPU FIRE batch requires an active tensor batch');
    if (forces.rows!==this.atomCount||forces.cols!==3||forces.dtype!=='f32') throw new Error('GPU FIRE force tensor shape/dtype mismatch');
    const next=this.rt.tensor(null,1,this.stateLength,false);
    this.rt.dispatch([this.state,forces,this.mask],next,this.code,1);
    this.state=next;
    this.positionSnapshots.push({buffer:next.buffer,rows:this.atomCount,cols:3,size:this.coordinateCount,
      requiresGrad:false,dtype:'f32',grad:null});
    return this.positionSnapshots.at(-1);
  }
}

const alignStorageOffset=value=>Math.ceil(value/64)*64;
const wgslFloat=value=>{
  const text=Math.fround(value).toString();
  return /[.eE]/.test(text)?text:`${text}.0`;
};

const cellMatrixShader=`
struct ExpResult { value:array<f32,9>, derivative:array<f32,9>, valid:u32, };
struct InverseResult { value:array<f32,9>, valid:u32, };
fn zeros3()->array<f32,9>{var a:array<f32,9>;for(var i=0u;i<9u;i++){a[i]=0.0;}return a;}
fn identity3()->array<f32,9>{var a=zeros3();a[0]=1.0;a[4]=1.0;a[8]=1.0;return a;}
fn add3(a:array<f32,9>,b:array<f32,9>)->array<f32,9>{var r:array<f32,9>;for(var i=0u;i<9u;i++){r[i]=a[i]+b[i];}return r;}
fn scale3(a:array<f32,9>,s:f32)->array<f32,9>{var r:array<f32,9>;for(var i=0u;i<9u;i++){r[i]=a[i]*s;}return r;}
fn transpose3(a:array<f32,9>)->array<f32,9>{var r:array<f32,9>;for(var i=0u;i<3u;i++){for(var j=0u;j<3u;j++){r[i*3u+j]=a[j*3u+i];}}return r;}
fn multiply3(a:array<f32,9>,b:array<f32,9>)->array<f32,9>{var r=zeros3();for(var i=0u;i<3u;i++){for(var j=0u;j<3u;j++){for(var k=0u;k<3u;k++){r[i*3u+j]+=a[i*3u+k]*b[k*3u+j];}}}return r;}
fn norm3(a:array<f32,9>)->f32{var result=0.0;for(var i=0u;i<3u;i++){var row=0.0;for(var j=0u;j<3u;j++){row+=abs(a[i*3u+j]);}result=max(result,row);}return result;}
fn determinant3(a:array<f32,9>)->f32{return a[0]*(a[4]*a[8]-a[5]*a[7])-a[1]*(a[3]*a[8]-a[5]*a[6])+a[2]*(a[3]*a[7]-a[4]*a[6]);}
fn inverse3(a:array<f32,9>)->InverseResult{
  let d=determinant3(a);var result:InverseResult;result.value=zeros3();result.valid=0u;
  if(!(d==d)||abs(d)<1.0e-12||abs(d)>1.0e30){return result;}
  let k=1.0/d;
  result.value[0]=(a[4]*a[8]-a[5]*a[7])*k;result.value[1]=(a[2]*a[7]-a[1]*a[8])*k;result.value[2]=(a[1]*a[5]-a[2]*a[4])*k;
  result.value[3]=(a[5]*a[6]-a[3]*a[8])*k;result.value[4]=(a[0]*a[8]-a[2]*a[6])*k;result.value[5]=(a[2]*a[3]-a[0]*a[5])*k;
  result.value[6]=(a[3]*a[7]-a[4]*a[6])*k;result.value[7]=(a[1]*a[6]-a[0]*a[7])*k;result.value[8]=(a[0]*a[4]-a[1]*a[3])*k;
  result.valid=1u;return result;
}
fn inner3(a:array<f32,9>,b:array<f32,9>)->f32{var result=0.0;for(var i=0u;i<9u;i++){result+=a[i]*b[i];}return result;}
fn finite3(a:array<f32,9>)->bool{for(var i=0u;i<9u;i++){if(!(a[i]==a[i])||abs(a[i])>1.0e30){return false;}}return true;}
fn expFrechet3(a:array<f32,9>,direction:array<f32,9>)->ExpResult{
  var result:ExpResult;result.value=zeros3();result.derivative=zeros3();result.valid=0u;
  if(!finite3(a)||!finite3(direction)){return result;}
  let magnitude=norm3(a);var squarings=0u;
  if(magnitude>0.5){let needed=ceil(log2(magnitude/0.5));if(!(needed==needed)||needed>10.0){return result;}squarings=u32(needed);}
  let scale=exp2(f32(squarings));let scaled=scale3(a,1.0/scale);let scaledDirection=scale3(direction,1.0/scale);
  var value=identity3();var term=identity3();var derivative=zeros3();var derivativeTerm=zeros3();var converged=false;
  for(var order=1u;order<=48u;order++){
    let divisor=f32(order);let nextTerm=scale3(multiply3(term,scaled),1.0/divisor);
    let nextDerivative=scale3(add3(multiply3(derivativeTerm,scaled),multiply3(term,scaledDirection)),1.0/divisor);
    value=add3(value,nextTerm);derivative=add3(derivative,nextDerivative);
    if(norm3(nextTerm)<=1.0e-7&&norm3(nextDerivative)<=1.0e-7){converged=true;break;}
    term=nextTerm;derivativeTerm=nextDerivative;
  }
  if(!converged){return result;}
  for(var i=0u;i<squarings;i++){derivative=add3(multiply3(derivative,value),multiply3(value,derivative));value=multiply3(value,value);}
  if(!finite3(value)||!finite3(derivative)){return result;}
  result.value=value;result.derivative=derivative;result.valid=1u;return result;
}`;

// Device-resident FIRE state for the Rust FrechetCellFilter coordinate layout:
// Cartesian atom coordinates followed by atom_count * log(deformation_gradient).
// The first implementation intentionally accepts only unconstrained full-cell
// runs; the Worker retains its existing per-step fallback for other settings.
export class GpuCellFireBatch {
  constructor(rt,structure,pressureEvPerA3=0,seed=null) {
    const atoms=structure.atomic_numbers?.length;
    if(!Number.isSafeInteger(atoms)||atoms<1||!Array.isArray(structure.positions_a)||structure.positions_a.length!==atoms
        ||!Array.isArray(structure.cell_a)||structure.cell_a.length!==3||!Number.isFinite(pressureEvPerA3))
      throw new Error('GPU cell FIRE requires a valid periodic structure and finite pressure');
    this.rt=rt;this.atomCount=atoms;this.coordinateCount=3*(atoms+3);this.atomCoordinateCount=3*atoms;
    this.velocityOffset=alignStorageOffset(this.coordinateCount);
    this.paramOffset=alignStorageOffset(this.velocityOffset+this.coordinateCount);
    this.referenceCellOffset=alignStorageOffset(this.paramOffset+5);
    this.geometryPositionOffset=alignStorageOffset(this.referenceCellOffset+9);
    this.geometryCellOffset=alignStorageOffset(this.geometryPositionOffset+this.atomCoordinateCount);
    this.stateLength=this.geometryCellOffset+9;
    this.pressureEvPerA3=pressureEvPerA3;
    const values=new Float32Array(this.stateLength);
    const coordinates=seed?.coordinates||[...structure.positions_a,...Array.from({length:3},()=>[0,0,0])];
    const velocities=seed?.velocities||Array.from({length:atoms+3},()=>[0,0,0]);
    if(coordinates.length!==atoms+3||coordinates.some(row=>row.length!==3||row.some(v=>!Number.isFinite(v)))
        ||velocities.length!==atoms+3||velocities.some(row=>row.length!==3||row.some(v=>!Number.isFinite(v))))
      throw new Error('GPU cell FIRE seed coordinate or velocity shape is invalid');
    coordinates.flat().forEach((value,index)=>values[index]=value);
    velocities.flat().forEach((value,index)=>values[this.velocityOffset+index]=value);
    values[this.paramOffset]=seed?.dt??0.1;values[this.paramOffset+1]=seed?.alpha??0.1;
    values[this.paramOffset+2]=seed?.positive??0;values[this.paramOffset+3]=seed?.initialized?1:0;values[this.paramOffset+4]=seed?.valid===false?0:1;
    const referenceCell=seed?.referenceCell||structure.cell_a;
    const geometryPositions=seed?.positions||structure.positions_a,geometryCell=seed?.cell||structure.cell_a;
    if(referenceCell.length!==3||referenceCell.some(row=>row.length!==3||row.some(v=>!Number.isFinite(v)))
        ||geometryPositions.length!==atoms||geometryPositions.some(row=>row.length!==3||row.some(v=>!Number.isFinite(v)))
        ||geometryCell.length!==3||geometryCell.some(row=>row.length!==3||row.some(v=>!Number.isFinite(v))))
      throw new Error('GPU cell FIRE seed geometry is invalid');
    referenceCell.flat().forEach((value,index)=>values[this.referenceCellOffset+index]=value);
    geometryPositions.flat().forEach((value,index)=>values[this.geometryPositionOffset+index]=value);
    geometryCell.flat().forEach((value,index)=>values[this.geometryCellOffset+index]=value);
    this.state=rt.tensor(values,1,this.stateLength,false);
    this.mask=rt.tensor(Array(this.atomCoordinateCount).fill(1),atoms,3,false);
    this.code=this.shader();
  }

  positionsTensor(){return this.rt.view(this.state.buffer,this.geometryPositionOffset*4,this.atomCount,3);}
  cellTensor(){return this.rt.view(this.state.buffer,this.geometryCellOffset*4,3,3);}
  stateInfoTensor(){return this.rt.view(this.state.buffer,this.paramOffset*4,1,5);}

  shader(){
    const n=this.atomCount,c=this.coordinateCount,atoms3=this.atomCoordinateCount;
    const velocity=this.velocityOffset,param=this.paramOffset,ref=this.referenceCellOffset,pos=this.geometryPositionOffset,cell=this.geometryCellOffset;
    return `${cellMatrixShader}
@group(0) @binding(0) var<storage,read> state:array<f32>;
@group(0) @binding(1) var<storage,read> atom_forces:array<f32>;
@group(0) @binding(2) var<storage,read> stress:array<f32>;
@group(0) @binding(3) var<storage,read> movable:array<f32>;
@group(0) @binding(4) var<storage,read_write> next:array<f32>;
@compute @workgroup_size(1) fn main(){
  if(state[${param+4}u]<=0.5){for(var i=0u;i<${this.stateLength}u;i++){next[i]=state[i];}next[${param+4}u]=0.0;return;}
  for(var i=0u;i<${this.stateLength}u;i++){next[i]=0.0;}
  var coordinates:array<f32,${c}>;var velocities:array<f32,${c}>;var forces:array<f32,${c}>;
  for(var i=0u;i<${c}u;i++){coordinates[i]=state[i];velocities[i]=state[${velocity}u+i];}
  var currentCell:array<f32,9>;for(var i=0u;i<9u;i++){currentCell[i]=state[${cell}u+i];}
  let volume=abs(determinant3(currentCell));
  var logDeformation:array<f32,9>;
  for(var i=0u;i<9u;i++){logDeformation[i]=coordinates[${atoms3}u+i]/${wgslFloat(n)};}
  let exponential=expFrechet3(logDeformation,zeros3());
  if(exponential.valid==0u||!(volume==volume)||volume<1.0e-12){for(var i=0u;i<${this.stateLength}u;i++){next[i]=state[i];}next[${param+4}u]=0.0;return;}
  let inverse= inverse3(exponential.value);
  if(inverse.valid==0u){for(var i=0u;i<${this.stateLength}u;i++){next[i]=state[i];}next[${param+4}u]=0.0;return;}
  let inverseTranspose=transpose3(inverse.value);var virial=zeros3();
  for(var i=0u;i<9u;i++){virial[i]=-volume*stress[i];}
  virial[0]-=volume*${wgslFloat(this.pressureEvPerA3)};virial[4]-=volume*${wgslFloat(this.pressureEvPerA3)};virial[8]-=volume*${wgslFloat(this.pressureEvPerA3)};
  let cellGradient=multiply3(virial,inverseTranspose);
  for(var atom=0u;atom<${n}u;atom++){
    for(var axis=0u;axis<3u;axis++){
      var transformed=0.0;for(var inner=0u;inner<3u;inner++){transformed+=atom_forces[atom*3u+inner]*exponential.value[inner*3u+axis];}
      forces[atom*3u+axis]=transformed*movable[atom*3u+axis];
    }
  }
  for(var mu=0u;mu<3u;mu++){
    for(var nu=0u;nu<3u;nu++){
      var direction=zeros3();direction[mu*3u+nu]=1.0;let derivative=expFrechet3(logDeformation,direction);
      if(derivative.valid==0u){for(var i=0u;i<${this.stateLength}u;i++){next[i]=state[i];}next[${param+4}u]=0.0;return;}
      forces[${atoms3}u+mu*3u+nu]=inner3(derivative.derivative,cellGradient)/${wgslFloat(n)};
    }
  }
  var force2=0.0;var power=0.0;var velocity2=0.0;
  for(var i=0u;i<${c}u;i++){if(!(forces[i]==forces[i])||abs(forces[i])>1.0e30){for(var k=0u;k<${this.stateLength}u;k++){next[k]=state[k];}next[${param+4}u]=0.0;return;}force2=fma(forces[i],forces[i],force2);power=fma(velocities[i],forces[i],power);velocity2=fma(velocities[i],velocities[i],velocity2);}
  let forceNorm=sqrt(force2);var dt=state[${param}u];var alpha=state[${param+1}u];var positive=state[${param+2}u];var initialized=state[${param+3}u];
  if(forceNorm>1.0e-30){
    if(initialized>0.5){if(power>0.0){let velocityNorm=sqrt(velocity2);for(var i=0u;i<${c}u;i++){velocities[i]=(1.0-alpha)*velocities[i]+alpha*forces[i]/forceNorm*velocityNorm;}if(positive>5.0){dt=min(dt*1.1,1.0);alpha*=0.99;}positive+=1.0;}else{for(var i=0u;i<${c}u;i++){velocities[i]=0.0;}alpha=0.1;dt*=0.5;positive=0.0;}}
    else{initialized=1.0;}
    var displacement2=0.0;for(var i=0u;i<${c}u;i++){velocities[i]+=dt*forces[i];let d=dt*velocities[i];displacement2=fma(d,d,displacement2);}
    let displacementNorm=sqrt(displacement2);var movementScale=1.0;if(displacementNorm>0.1){movementScale=0.1/displacementNorm;}
    for(var i=0u;i<${c}u;i++){coordinates[i]+=dt*velocities[i]*movementScale;}
  }
  for(var i=0u;i<${c}u;i++){next[i]=coordinates[i];next[${velocity}u+i]=velocities[i];}
  next[${param}u]=dt;next[${param+1}u]=alpha;next[${param+2}u]=positive;next[${param+3}u]=initialized;next[${param+4}u]=1.0;
  var referenceCell:array<f32,9>;for(var i=0u;i<9u;i++){referenceCell[i]=state[${ref}u+i];next[${ref}u+i]=referenceCell[i];}
  var updatedLog:array<f32,9>;for(var i=0u;i<9u;i++){updatedLog[i]=coordinates[${atoms3}u+i]/${wgslFloat(n)};}
  let updatedExp=expFrechet3(updatedLog,zeros3());if(updatedExp.valid==0u){for(var i=0u;i<${this.stateLength}u;i++){next[i]=state[i];}next[${param+4}u]=0.0;return;}
  let transform=transpose3(updatedExp.value);var updatedCell=multiply3(referenceCell,transform);
  if(abs(determinant3(updatedCell))<1.0e-12||!finite3(updatedCell)){for(var i=0u;i<${this.stateLength}u;i++){next[i]=state[i];}next[${param+4}u]=0.0;return;}
  for(var i=0u;i<9u;i++){next[${cell}u+i]=updatedCell[i];}
  for(var atom=0u;atom<${n}u;atom++){for(var axis=0u;axis<3u;axis++){var value=0.0;for(var k=0u;k<3u;k++){value+=coordinates[atom*3u+k]*transform[k*3u+axis];}next[${pos}u+atom*3u+axis]=value;}}
}`;
  }

  step(forces,stress){
    if(!this.rt.evaluationActive)throw new Error('GPU cell FIRE batch requires an active tensor batch');
    if(forces.rows!==this.atomCount||forces.cols!==3||stress.rows!==3||stress.cols!==3)
      throw new Error('GPU cell FIRE force/stress tensor shape mismatch');
    const next=this.rt.tensor(null,1,this.stateLength,false);
    this.rt.dispatch([this.state,forces,stress,this.mask],next,this.code,1);
    this.state=next;return next;
  }

  static seedFromReadback(values,atomCount){
    const coordinateCount=3*(atomCount+3),atomCoordinateCount=3*atomCount;
    const velocityOffset=alignStorageOffset(coordinateCount),paramOffset=alignStorageOffset(velocityOffset+coordinateCount);
    const referenceCellOffset=alignStorageOffset(paramOffset+5),geometryPositionOffset=alignStorageOffset(referenceCellOffset+9);
    const geometryCellOffset=alignStorageOffset(geometryPositionOffset+atomCoordinateCount),stateLength=geometryCellOffset+9;
    if(!values||values.length!==stateLength||![...values].every(Number.isFinite))throw new Error('GPU cell FIRE readback state is invalid');
    const rows=(data,n)=>Array.from({length:n},(_,i)=>Array.from(data.slice(i*3,i*3+3)));
    return {coordinates:rows(values.slice(0,coordinateCount),atomCount+3),
      velocities:rows(values.slice(velocityOffset,velocityOffset+coordinateCount),atomCount+3),
      dt:values[paramOffset],alpha:values[paramOffset+1],positive:values[paramOffset+2],initialized:values[paramOffset+3]>0.5,valid:values[paramOffset+4]>0.5,
      referenceCell:rows(values.slice(referenceCellOffset,referenceCellOffset+9),3),
      positions:rows(values.slice(geometryPositionOffset,geometryPositionOffset+atomCoordinateCount),atomCount),
      cell:rows(values.slice(geometryCellOffset,geometryCellOffset+9),3)};
  }
}

// Independent JS translation of macer-rust-relax::FireOptimizer::step_coordinates,
// used only by the browser probe to compare a batched f32 device update to Rust.
export function referenceFireStep(state, forces, movableMask) {
  const positions=state.positions.map(row=>[...row]),velocities=state.velocities.map(row=>[...row]);
  const projected=forces.map((row,i)=>row.map((value,j)=>value*movableMask[i*3+j]));
  const forceNorm=Math.sqrt(projected.flat().reduce((sum,value)=>sum+value*value,0));
  if(!Number.isFinite(forceNorm)||forceNorm<=0)throw new Error('FIRE cannot step with a zero or non-finite force norm');
  let {dt,alpha,positive,initialized}=state,last_branch;
  if(initialized){
    const power=velocities.flatMap((row,i)=>row.map((value,j)=>value*projected[i][j])).reduce((a,b)=>a+b,0);
    if(power>0){
      const velocityNorm=Math.sqrt(velocities.flat().reduce((sum,value)=>sum+value*value,0));
      for(let i=0;i<velocities.length;i++)for(let j=0;j<3;j++)
        velocities[i][j]=(1-alpha)*velocities[i][j]+alpha*projected[i][j]/forceNorm*velocityNorm;
      if(positive>5){dt=Math.min(dt*1.1,1);alpha*=0.99;}
      positive++;
      last_branch='positive';
    }else{
      for(const velocity of velocities)velocity.fill(0);
      alpha=0.1;dt*=0.5;positive=0;
      last_branch='nonpositive';
    }
  }else {initialized=true;last_branch='initial';}
  for(let i=0;i<velocities.length;i++)for(let j=0;j<3;j++)velocities[i][j]+=dt*projected[i][j];
  const displacement=velocities.map(row=>row.map(value=>dt*value));
  const norm=Math.sqrt(displacement.flat().reduce((sum,value)=>sum+value*value,0));
  if(norm>0.1)for(const row of displacement)for(let j=0;j<3;j++)row[j]*=0.1/norm;
  for(let i=0;i<positions.length;i++)for(let j=0;j<3;j++)positions[i][j]+=displacement[i][j];
  return {positions,velocities,dt,alpha,positive,initialized,last_branch};
}
