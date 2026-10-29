// Read-only upstream renderer used by the local visual comparison page.
import * as THREE from 'three';
import { VibCrystal } from './src/vibcrystal.js';
import { PhononYaml } from './src/phononyaml.js';
import { ReferencePreparation } from './macer-reference-preparation.js';
import { getSharedLightConfig } from './src/viewercommon.js';
THREE.ColorManagement.enabled=false;
// The source's getVibrations expects its historical Complex constructor.
// This compatibility object supplies only that constructor/Polar/mult API.
function Complex(re,im=0){return {re,im,mult(other){return Complex(re*other.re-im*other.im,re*other.im+im*other.re);}};}
Complex.Polar=(r,theta)=>Complex(r*Math.cos(theta),r*Math.sin(theta));
globalThis.Complex=Complex;
function snapshot(viewer,camera,canvas){
  camera.updateMatrixWorld();const rect=canvas.getBoundingClientRect();
  const atoms=viewer.atomobjects.map((atom,i)=>{const geometry=viewer.atomInstanceRefs?.[i]?.mesh.geometry||atom.geometry;
    const point=atom.position.clone().project(camera);return {position:atom.position.toArray().map((v,a)=>v+viewer.geometricCenter.toArray()[a]),screen:[(point.x+1)*rect.width/2,(1-point.y)*rect.height/2],radius:geometry.parameters.radius,segments:[geometry.parameters.widthSegments,geometry.parameters.heightSegments],color:viewer.getAtomColorHex(atom.atom_number)};});
  return {atoms,arrowMatrices:Array.from(viewer.arrowmesh?.instanceMatrix.array||[]),bondMatrices:Array.from(viewer.bondmesh?.instanceMatrix.array||[]),bonds:viewer.bonds.length,bondRadius:viewer.bondRadius,center:viewer.geometricCenter.toArray(),camera:{fov:camera.fov,position:camera.position.toArray(),up:camera.up.toArray()},cell:viewer.phonon?.lat||viewer.baseLattice};
}
function create(canvas,text){
  const phonon=new PhononYaml();phonon.getFromString(text,()=>{});
  const page=new ReferencePreparation();page.phonon=phonon;phonon.nndist=page.getBondingDistance();
  const container={get:()=>canvas.parentElement,width:()=>canvas.clientWidth,height:()=>canvas.clientHeight};
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true});renderer.setClearColor(0xffffff);renderer.outputColorSpace=THREE.LinearSRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
  let viewer=null,key='';
  function clear(){if(viewer){viewer.removeStructure();viewer=null;}}
  function render(config){
    const next=JSON.stringify([config.q,config.mode,config.repeats,config.style,config.atomScale,config.bondScale,config.arrows,config.cell]);
    if(next!==key){clear();viewer=new VibCrystal(container);viewer.display=config.style;viewer.cell=config.cell;viewer.arrows=config.arrows;viewer.defaultAtomRadiusScale=config.atomScale;viewer.bondRadius=.1*config.bondScale;viewer.amplitude=config.amplitude;viewer.arrowScale=config.vectorScale;viewer.phonon=phonon;viewer.scene=new THREE.Scene();viewer.camera=new THREE.PerspectiveCamera(viewer.cameraViewAngle,1,viewer.cameraNear,viewer.cameraFar);
      const light=getSharedLightConfig();viewer.pointLight=new THREE.PointLight(light.color,light.intensity);viewer.pointLight.position.set(...light.position);viewer.pointLight.decay=light.decay;viewer.camera.add(viewer.pointLight);
      page.k=config.q;page.n=config.mode;viewer.atoms=page.getStructure(...config.repeats);viewer.vibrations=page.getVibrations(...config.repeats);viewer.vibrationComponents=viewer.vibrations.map(axes=>axes.map(z=>[z.re,z.im]));viewer.initializeBondRulesFromAtoms(viewer.atoms,phonon.atom_numbers);viewer.addLights();viewer.getAtypes(phonon.atom_numbers);viewer.addStructure(viewer.atoms,phonon.atom_numbers);viewer.addCell(phonon.lat);key=next;
    }
    const rect=canvas.getBoundingClientRect();renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setSize(rect.width,rect.height,false);
    const camera=viewer.camera;camera.aspect=rect.width/rect.height;camera.position.set(...config.eye);camera.up.set(0,1,0);camera.lookAt(0,0,0);camera.updateProjectionMatrix();viewer.amplitude=config.amplitude;viewer.arrowScale=config.vectorScale;
    viewer.updateDynamicTransforms(config.amplitude*Math.cos(config.phase),config.amplitude*Math.sin(config.phase));renderer.render(viewer.scene,camera);
    return snapshot(viewer,camera,canvas);
  }
  return {render,dispose(){clear();renderer.dispose();},phonon};
}
globalThis.PhononOriginalReference={create,snapshot};
