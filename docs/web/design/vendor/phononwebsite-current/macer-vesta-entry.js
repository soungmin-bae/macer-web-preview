import * as THREE from 'three';
import { VibCrystal } from './src/vibcrystal.js';
import { StructureViewer } from './src/structureviewer.js';
import { getSharedLightConfig } from './src/viewercommon.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

if (THREE.ColorManagement && typeof THREE.ColorManagement.enabled === 'boolean') THREE.ColorManagement.enabled=false;

function asMacerAtoms(structure, visible) {
  const atomicNumbers=[...new Set(structure.atoms.map(atom=>globalThis.ElementStyles[atom.element]?.atomic_number).filter(Number.isInteger))].sort((a,b)=>a-b);
  const typeByNumber=new Map(atomicNumbers.map((number,index)=>[number,index]));
  const atoms=visible.map(instance=>{
    const number=globalThis.ElementStyles[structure.atoms[instance.id].element]?.atomic_number;
    return [typeByNumber.get(number),...instance.position];
  });
  return {atoms,atomicNumbers};
}

export function buildVestaObjects(structure, visible, cellVectors, {showCell=true,showBonds=true,atomScale=1,bondScale=1,elementStyles={},vestaDisplay='vesta',bondColorByAtom=true,bondColor='#808080',bondCutoffScale=1,vectorRadius=.1,vectorColor='#bbffbb'}={}) {
  const {atoms,atomicNumbers}=asMacerAtoms(structure,visible);
  const animated=Array.isArray(structure.equilibriumPositions);
  const viewer=animated?new VibCrystal({get:()=>null,width:()=>1,height:()=>1}):new StructureViewer();
  viewer.display=vestaDisplay==='jmol'?'jmol':'vesta';
  viewer.bondColorByAtom=bondColorByAtom;viewer.bondscolor=parseInt(bondColor.replace('#',''),16);
  viewer.shading=true;
  if(!animated)viewer.sphereLat=viewer.sphereLon=viewer.display==='vesta'?16:12;
  viewer.cell=!!showCell;
  viewer.defaultAtomRadiusScale=atomScale;
  viewer.bondRadius=.1*bondScale;
  viewer.nx=viewer.ny=viewer.nz=1;
  viewer.scene=new THREE.Scene();
  viewer.camera=new THREE.PerspectiveCamera(18,1,.1,5000);
  const lightConfig=getSharedLightConfig();
  viewer.pointLight=new THREE.PointLight(lightConfig.color,lightConfig.intensity);
  viewer.pointLight.position.set(...lightConfig.position);
  viewer.pointLight.decay=lightConfig.decay;
  viewer.camera.add(viewer.pointLight);
  viewer.renderer={render(){}};
  viewer.values=null;
  viewer.baseAtoms=atoms.map(atom=>atom.slice());
  viewer.baseLattice=(cellVectors||[[1e6,0,0],[0,1e6,0],[0,0,1e6]]).map(row=>row.slice());
  viewer.structureData={atoms:viewer.baseAtoms.map(atom=>atom.slice()),atom_numbers:atomicNumbers.slice(),lat:viewer.baseLattice.map(row=>row.slice())};
  viewer.atom_numbers=atomicNumbers.slice();
  for(const element of new Set(structure.atoms.map(atom=>atom.element))){
    const number=globalThis.ElementStyles[element]?.atomic_number,override=elementStyles[element];
    if(!Number.isInteger(number)||!override)continue;
    if(typeof override.color==='string'&&/^#[0-9a-f]{6}$/i.test(override.color))viewer.atomColorOverrides[number]=parseInt(override.color.slice(1),16);
    if(Number.isFinite(override.radius_scale))viewer.atomRadiusScaleOverrides[number]=override.radius_scale*atomScale;
  }
  viewer.atoms=viewer.baseAtoms.map(atom=>atom.slice());
  viewer.shouldAutoFitCamera=false;
  if(animated){
    viewer.phonon={lat:viewer.baseLattice,atom_numbers:atomicNumbers,nndist:0};
    viewer.arrows=true;viewer.arrowRadius=Math.max(.01,Math.min(.3,Number(vectorRadius)||.1));
    viewer.arrowcolor=parseInt(vectorColor.replace('#',''),16);
    viewer.vibrationComponents=atoms.map(()=>[[0,0],[0,0],[0,0]]);
    viewer.initializeBondRulesFromAtoms(atoms,atomicNumbers);
  }else viewer.initializeBondRulesFromAtoms();
  for(const rule of Object.values(viewer.bondRules))rule.cutoff*=Math.max(.1,Number(bondCutoffScale)||1);
  if(!showBonds)viewer.bondRules={};
  if(animated){viewer.addLights();viewer.getAtypes(atomicNumbers);viewer.addStructure(atoms,atomicNumbers);viewer.addCell(viewer.baseLattice);}
  else viewer.updateStructure();
  return {
    viewer,
    upstreamVibrations:animated,
    basePositions:visible.map(atom=>atom.position.slice()),
    arrowmesh:null,
    arrowKey:null,
    instanceDummy:new THREE.Object3D(),
    scene:viewer.scene,
    camera:viewer.camera,
    center:viewer.geometricCenter.toArray(),
    atomCount:viewer.atomobjects.length,
    bondCount:viewer.bonds.length,
    source:'phononwebsite/src/structureviewer.js+structureviewerbase.js#StructureViewer.updateStructure',
  };
}

// Keep the upstream equilibrium bond topology and update only transforms.
// Moving atoms are never wrapped; the scene contains a stable set of images.
export function updateVestaPositions(built, visible, {showVectors=false,vectorScale=2,vectorRadius=.1,vectorColor='#bbffbb',motionAmplitude=.2}={}) {
  const viewer=built.viewer, center=viewer.geometricCenter;
  if(visible.length!==viewer.atomobjects.length)throw new Error('Phonon display topology changed during a frame.');
  if(built.upstreamVibrations){
    viewer.arrows=!!showVectors;viewer.arrowmesh.visible=!!showVectors;
    viewer.amplitude=Math.max(1e-12,Number(motionAmplitude)||.2);viewer.arrowScale=Math.max(0,Number(vectorScale)||0);
    viewer.vibrationComponents=visible.map((atom,i)=>atom.position.map((v,a)=>[v-built.basePositions[i][a],0]));
    viewer.updateDynamicTransforms(1,0);return;
  }
  const direction=new THREE.Vector3(), midpoint=new THREE.Vector3(), y=new THREE.Vector3(0,1,0);
  const radius=Math.max(.01,Math.min(.3,Number(vectorRadius)||.1));
  const color=/^#[0-9a-f]{6}$/i.test(vectorColor)?parseInt(vectorColor.slice(1),16):0xbbffbb;
  const arrowKey=radius+':'+color+':'+visible.length;
  if(showVectors&&arrowKey!==built.arrowKey){
    if(built.arrowmesh){built.scene.remove(built.arrowmesh);built.arrowmesh.geometry.dispose();built.arrowmesh.material.dispose();built.arrowmesh.dispose();}
    // Exact geometry/proportions from upstream VibCrystal.addStructure:
    // centered unit shaft and a quarter-length head with twice its radius.
    const head=new THREE.CylinderGeometry(0,2*radius,.25);
    const shaft=new THREE.CylinderGeometry(radius,radius,1);
    head.translate(0,.625,0);
    const geometry=mergeGeometries([shaft,head]);shaft.dispose();head.dispose();
    const material=new THREE.MeshLambertMaterial({color,blending:THREE.NormalBlending});
    built.arrowmesh=new THREE.InstancedMesh(geometry,material,visible.length);
    built.arrowmesh.name='arrows';built.arrowmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);built.arrowmesh.frustumCulled=false;
    built.scene.add(built.arrowmesh);built.arrowKey=arrowKey;
  }
  const arrowmesh=built.arrowmesh,dummy=built.instanceDummy,normal=new THREE.Vector3();
  if(arrowmesh)arrowmesh.visible=!!showVectors;
  const amplitude=Math.max(1e-12,Number(motionAmplitude)||.2),scale=Math.max(0,Number(vectorScale)||0);
  for(let i=0;i<visible.length;i++){
    const position=visible[i].position,atom=viewer.atomobjects[i];atom.position.set(...position).sub(center);
    if(!showVectors||!arrowmesh)continue;
    const base=built.basePositions[i];direction.set(position[0]-base[0],position[1]-base[1],position[2]-base[2]);
    const length=direction.length()/amplitude*scale;
    // VibCrystal.updateDynamicTransforms: center the shaft half its length
    // from the moving atom; do not detach the tail onto the sphere surface.
    dummy.position.copy(atom.position).addScaledVector(direction,.5*scale/amplitude);
    if(length>1e-9){normal.copy(direction).normalize();dummy.quaternion.setFromUnitVectors(y,normal);dummy.scale.set(1,length,1);}
    else {dummy.quaternion.identity();dummy.scale.set(0,0,0);}
    dummy.updateMatrix();arrowmesh.setMatrixAt(i,dummy.matrix);
  }
  if(showVectors&&arrowmesh)arrowmesh.instanceMatrix.needsUpdate=true;
  let index=0;
  for(const bond of viewer.bonds){
    direction.subVectors(bond.b,bond.a);const length=direction.length();
    direction.normalize();
    const update=(offset)=>{
      const object=viewer.bondobjects[index++];
      midpoint.copy(bond.a).addScaledVector(direction,length*offset);
      object.position.copy(midpoint);object.quaternion.setFromUnitVectors(y,direction);
      object.scale.y=length/Math.max(bond.baseLength,1e-12);
      object.visible=length>1e-8;
    };
    if(viewer.bondColorByAtom){update(.25);update(.75);}else update(.5);
  }
}

export function createVestaRenderer(canvas) {
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false});
  renderer.setClearColor(0xffffff,1);
  if('outputColorSpace' in renderer&&'LinearSRGBColorSpace' in THREE)renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
  if('toneMapping' in renderer)renderer.toneMapping=THREE.NoToneMapping;
  return renderer;
}

export function renderVesta(renderer,built,frame) {
  const {bounds,dpr,eye,target,fov,near,far,projection,orthoHalfHeight}=frame;
  renderer.setPixelRatio(dpr);
  renderer.setSize(bounds.width,bounds.height,false);
  const camera=projection==='orthographic'?(built.orthographicCamera??=new THREE.OrthographicCamera()):built.camera;
  if(camera.isOrthographicCamera){const h=orthoHalfHeight||1,w=h*Math.max(bounds.width,1)/Math.max(bounds.height,1);camera.left=-w;camera.right=w;camera.top=h;camera.bottom=-h;}
  // Keep the shared light on whichever camera currently renders the scene.
  const light=built.viewer.pointLight;if(light.parent!==camera)camera.add(light);if(camera.parent!==built.scene)built.scene.add(camera);
  camera.aspect=Math.max(bounds.width,1)/Math.max(bounds.height,1);
  camera.fov=fov*180/Math.PI;
  camera.near=near;
  camera.far=far;
  const center=built.center;
  camera.position.set(...eye.map((value,axis)=>value-center[axis]));
  const backward=eye.map((v,i)=>v-target[i]),length=Math.hypot(...backward);
  camera.up.set(...(Math.abs(backward[1]/length)>.98?[0,0,1]:[0,1,0]));
  camera.lookAt(...target.map((value,axis)=>value-center[axis]));
  camera.updateProjectionMatrix();
  renderer.render(built.scene,camera);
}

export function disposeVestaObjects(built) {
  if(!built?.scene)return;
  built.scene.traverse(object=>{if(object.isInstancedMesh)object.dispose();object.geometry?.dispose?.();if(Array.isArray(object.material))for(const material of object.material)material?.dispose?.();else object.material?.dispose?.();});
  built.scene.clear();
}

export function projectVestaPoint(built,point,projection='perspective') {
  const camera=projection==='orthographic'?built.orthographicCamera:built.camera;
  if(!camera)return null;
  camera.updateMatrixWorld();
  const p=new THREE.Vector3(...point.map((v,i)=>v-built.center[i])).project(camera);
  return [p.x,p.y,p.z];
}

globalThis.PhononwebsiteVibCrystalAdapter=Object.freeze({projectVestaPoint,buildVestaObjects,updateVestaPositions,createVestaRenderer,renderVesta,disposeVestaObjects});
