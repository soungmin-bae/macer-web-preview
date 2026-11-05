/* Kinematic powder XRD, ported from the pinned local macer/Pymatgen reference. */
(function(root){
 'use strict';
 const sources=Object.freeze({
  CuKa1:{label:'Cu Kα1',wavelength:1.5405929,weight:1},
  CuKa2:{label:'Cu Kα2',wavelength:1.5444274,weight:1},
  CuKa12:{label:'Cu Kα (2:1)',lines:[[1.54059,1],[1.54432,.5]]}
 });
 const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const det=a=>dot(a[0],cross(a[1],a[2]));
 function broaden(sticks,x,profile,width){
  if(!['gaussian','lorentzian'].includes(profile)||!(width>0)||!Number.isFinite(width))throw Error('Invalid XRD profile settings.');
  return x.map(xx=>sticks.reduce((sum,p)=>{
   const d=xx-p.twoTheta;
   if(profile==='gaussian')return sum+p.intensity*Math.exp(-.5*(d/width)**2)/(width*Math.sqrt(2*Math.PI));
   return sum+p.intensity*width/(Math.PI*(d*d+width*width));
  },0));
 }
 function compute(structure,source='CuKa12',options={}){
  if(!structure||!Array.isArray(structure.cell)||structure.cell.length!==3||!Array.isArray(structure.atoms)||!structure.atoms.length)throw Error('XRD requires a periodic crystal structure.');
  if(structure.pbc&&structure.pbc.some(x=>!x))throw Error('XRD is only available for periodic structures.');
  const cell=structure.cell,volume=det(cell);if(!Number.isFinite(volume)||Math.abs(volume)<1e-10)throw Error('The structure cell is singular.');
  if(structure.atoms.length>10000)throw Error('XRD is limited to 10,000 atoms.');
  const positions=structure.atoms.map((a,i)=>{
   if(!a.element||!Array.isArray(a.position)||a.position.length!==3||!a.position.every(Number.isFinite))throw Error(`Invalid position for atom ${i+1}.`);
   if(a.occupancy!==undefined&&a.occupancy!==1)throw Error('Disordered or partially occupied sites are not supported by this XRD preview.');
   if(!root.XrdScatteringParams?.[a.element])throw Error(`No X-ray scattering coefficients are available for ${a.element}.`);
   const d=det(cell),frac=[dot(a.position,cross(cell[1],cell[2]))/d,dot(a.position,cross(cell[2],cell[0]))/d,dot(a.position,cross(cell[0],cell[1]))/d];
   return {element:a.element,frac,z:root.Structures.atomicNumber(a.element),coeff:root.XrdScatteringParams[a.element]};
  });
  const min=Number(options.min2theta??0),max=Number(options.max2theta??120),profile=options.profile||'lorentzian',width=Number(options.width??.05),samples=Number(options.samples??5000);
  if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<=min||max>180)throw Error('Enter a valid 2θ range between 0° and 180°.');
  if(!['gaussian','lorentzian'].includes(profile)||!(width>0)||!Number.isInteger(samples)||samples<2||samples>20000)throw Error('Invalid XRD profile settings.');
  const sourceKeys=[...new Set(Array.isArray(source)?source:[source])];
  if(!sourceKeys.length||sourceKeys.some(key=>!sources[key]))throw Error('Choose at least one supported Cu Kα source.');
  const lineDefs=[...new Map(sourceKeys.flatMap(key=>{
   const def=sources[key];return def.lines?def.lines.map(([wavelength,weight])=>({wavelength,weight})): [{wavelength:def.wavelength,weight:1}];
  }).map(line=>[line.wavelength,line])).values()];
  const reciprocal=cell.map((_,i)=>[0,1,2].map(j=>[cross(cell[1],cell[2]),cross(cell[2],cell[0]),cross(cell[0],cell[1])][i][j]/volume));
  const bounds=cell.map(v=>Math.ceil((2*Math.sin(max*Math.PI/360)/Math.min(...lineDefs.map(x=>x.wavelength)))*Math.hypot(...v))+1);
  const count=(2*bounds[0]+1)*(2*bounds[1]+1)*(2*bounds[2]+1);if(count>2_000_000)throw Error(`XRD reflection search would inspect ${count.toLocaleString()} reciprocal points; shorten the 2θ range or use a larger cell.`);
  const linePeaks=[];
  for(const {wavelength,weight} of lineDefs){
   const peaks=[];
   for(let h=-bounds[0];h<=bounds[0];h++)for(let k=-bounds[1];k<=bounds[1];k++)for(let l=-bounds[2];l<=bounds[2];l++){
    if(h===0&&k===0&&l===0)continue;
    const g=[h,k,l].reduce((v,n,i)=>v.map((x,j)=>x+n*reciprocal[i][j]),[0,0,0]),glen=Math.hypot(...g),s=glen/2,arg=wavelength*s;
    if(!(arg>0&&arg<=1+1e-12))continue;
    const theta=Math.asin(Math.min(1,arg)),twoTheta=2*theta*180/Math.PI;if(twoTheta<min-1e-9||twoTheta>max+1e-9)continue;
    let fre=0,fim=0,amplitudeScale=0;
    for(const atom of positions){const f=atom.z-41.78214*s*s*atom.coeff.reduce((sum,p)=>sum+p[0]*Math.exp(-p[1]*s*s),0),phase=2*Math.PI*(h*atom.frac[0]+k*atom.frac[1]+l*atom.frac[2]);fre+=f*Math.cos(phase);fim+=f*Math.sin(phase);amplitudeScale+=Math.abs(f);}
    if(Math.hypot(fre,fim)<=1e-12*amplitudeScale)continue; // Suppress floating-point residue at exact systematic absences.
    const lp=(1+Math.cos(2*theta)**2)/(Math.sin(theta)**2*Math.cos(theta));const rawIntensity=(fre*fre+fim*fim)*lp,intensity=rawIntensity;
    if(!(intensity>0)||!Number.isFinite(intensity))continue;
    peaks.push({twoTheta,dSpacing:1/glen,rawIntensity,intensity,hkl:[h,k,l],wavelength,weight});
   }
   peaks.sort((a,b)=>a.twoTheta-b.twoTheta);
   linePeaks.push({wavelength,weight,peaks});
  }
  const x=Array.from({length:samples},(_,i)=>min+(max-min)*i/(samples-1));
  const curves={};
  for(const key of sourceKeys){
   const src=sources[key],components=src.lines?src.lines: [[src.wavelength,1]],peaks=[];
   for(const [wavelength,weight] of components){
    const lp=linePeaks.find(p=>Math.abs(p.wavelength-wavelength)<1e-9);
    if(lp)peaks.push(...lp.peaks.map(p=>({...p,weight,intensity:p.rawIntensity*weight})));
   }
   curves[key]={label:src.label,peaks,values:broaden(peaks,x,profile,width)};
  }
  const combined=[];
  for(const key of sourceKeys)for(const p of curves[key].peaks){
   let target=combined.find(q=>Math.abs(q.twoTheta-p.twoTheta)<1e-5);
   if(!target){target={twoTheta:p.twoTheta,dSpacing:p.dSpacing,intensity:0,hkls:[],wavelengths:[]};combined.push(target);}
   target.intensity+=p.intensity;target.hkls.push(p.hkl);target.wavelengths.push(p.wavelength);
  }
  combined.sort((a,b)=>a.twoTheta-b.twoTheta);
  return {schema:'macer-xrd-preview-v1',source:'local macer util xrd · Pymatgen XRDCalculator',sources:sourceKeys,lineRatio:sourceKeys.includes('CuKa12')?'Cu Kα1:Kα2 = 2:1 before the shared display scale':null,profile,widthDeg:width,min2theta:min,max2theta:max,x,curves,peaks:combined,reflectionCount:linePeaks.reduce((n,x)=>n+x.peaks.length,0),atomCount:positions.length,volumeA3:Math.abs(volume)};
 }
 function serializeCsv(result,selected){
  if(!result||!Array.isArray(result.x)||!Array.isArray(selected)||!selected.length)throw Error('Calculate XRD and select at least one source before exporting.');
  const curves=selected.map(key=>{const curve=result.curves?.[key];if(!curve||!Array.isArray(curve.values)||curve.values.length!==result.x.length)throw Error(`The ${key} curve is unavailable.`);return [key,curve.values];});
  const scale=Math.max(1e-30,...curves.flatMap(([,values])=>values));
  return ['source,two_theta_deg,profile_relative_intensity',...curves.flatMap(([key,values])=>values.map((value,i)=>[key,result.x[i],100*value/scale].join(',')))].join('\n')+'\n';
 }
 root.XrdCore=Object.freeze({compute,serializeCsv,broaden,sources});
})(globalThis);
