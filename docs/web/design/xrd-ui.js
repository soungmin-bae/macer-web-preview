(function(){
 'use strict';
 const $=id=>document.getElementById(id),panel=$('xrd-panel');if(!panel)return;
 let result=null,active=null;
 const status=message=>{$('xrd-status').textContent=message;};
 function currentStructure(){
  const relax=globalThis.MacerRelax;if(!relax)return null;
  const source=$('xrd-structure-source').value;
  // Prefer the explicit result bridge. The displayed-structure bridge is a
  // safe fallback for app versions where result selection is represented by
  // the viewer state rather than the dedicated XRD accessor.
  return source==='result'?(relax.selectedResultStructure?.()||relax.displayedStructure?.()||null):relax.inputStructure();
 }
 function svgPath(values,x,lo,hi,width,height){const left=58,right=14,top=12,bottom=40,iw=width-left-right,ih=height-top-bottom,max=Math.max(...values,1e-30);return values.map((v,i)=>`${i?'L':'M'}${(left+i*iw/(values.length-1)).toFixed(2)},${(top+ih-(v/max)*ih).toFixed(2)}`).join(' ');}
 function draw(){
  if(!result)return;const svg=$('xrd-plot'),width=Math.max(420,svg.clientWidth||760),height=330,left=58,right=14,top=12,bottom=40,iw=width-left-right,ih=height-top-bottom;
  const selected=[...document.querySelectorAll('[data-xrd-source]:checked')].map(e=>e.value),maxY=Math.max(1e-30,...selected.flatMap(key=>result.curves[key]?.values||[]));
  let markup=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Powder X-ray diffraction pattern"><rect width="100%" height="100%" fill="white"/>`;
  for(let i=0;i<=4;i++){const y=top+ih*i/4;markup+=`<line x1="${left}" y1="${y}" x2="${left+iw}" y2="${y}" stroke="#e1e7ed"/><text x="${left-8}" y="${y+4}" text-anchor="end" fill="#64748b" font-size="11">${(100-25*i).toFixed(0)}</text>`;}
  const colors={CuKa1:'#277eb6',CuKa2:'#d17c32',CuKa12:'#243f5a'};
  for(const key of selected){const curve=result.curves[key];if(!curve)continue;const d=curve.values.map((v,i)=>`${i?'L':'M'}${(left+i*iw/(curve.values.length-1)).toFixed(2)},${(top+ih-v/maxY*ih).toFixed(2)}`).join(' ');markup+=`<path d="${d}" fill="none" stroke="${colors[key]}" stroke-width="1.7"/>`;}
  markup+=`<line x1="${left}" y1="${top+ih}" x2="${left+iw}" y2="${top+ih}" stroke="#64748b"/><text x="${left+iw/2}" y="${height-7}" text-anchor="middle" fill="#475569" font-size="12">2θ (degrees)</text><text transform="translate(15 ${top+ih/2}) rotate(-90)" text-anchor="middle" fill="#475569" font-size="12">Relative intensity</text>`;
  for(let i=0;i<=4;i++){const xx=result.min2theta+(result.max2theta-result.min2theta)*i/4;markup+=`<text x="${left+iw*i/4}" y="${top+ih+17}" text-anchor="middle" fill="#64748b" font-size="11">${xx.toFixed(0)}</text>`;}
  markup+='</svg>';svg.innerHTML=markup;
 }
 function calculate(){
  try{const selected=[...document.querySelectorAll('[data-xrd-source]:checked')].map(e=>e.value);if(!selected.length)throw Error('Select at least one Cu Kα source.');const structure=currentStructure();if(!structure)throw Error('Enter a valid structure first.');if(!structure.cell||structure.pbc?.some(x=>!x))throw Error('XRD requires a periodic structure with a 3D cell.');
   result=globalThis.XrdCore.compute(structure,selected,{profile:$('xrd-profile').value,width:Number($('xrd-width').value),min2theta:Number($('xrd-min').value),max2theta:Number($('xrd-max').value)});
   active={structure,source:$('xrd-structure-source').value};$('xrd-export-csv').disabled=false;status(`${result.atomCount} atoms · ${result.reflectionCount} reflections · ${result.volumeA3.toFixed(3)} Å³ · ${selected.map(key=>XrdCore.sources[key].label).join(', ')} · ${active.source==='input'?'Current input':'Selected Relax step'}. Kinematic powder pattern; relative scale.`);draw();
  }catch(e){result=null;active=null;$('xrd-plot').innerHTML='';$('xrd-export-csv').disabled=true;status(e.message||String(e));}
 }
 $('xrd-calculate').onclick=calculate;
 $('xrd-structure-source').onchange=()=>{active=null;result=null;$('xrd-plot').innerHTML='';$('xrd-export-csv').disabled=true;status('Choose Calculate XRD to update the pattern for this structure.');};
 $('xrd-profile').addEventListener('change',()=>{$('xrd-width-label').textContent=$('xrd-profile').value==='gaussian'?'Gaussian σ [° 2θ]':'Lorentzian γ · HWHM [° 2θ]';});
 ['xrd-profile','xrd-width','xrd-min','xrd-max'].forEach(id=>$(id).addEventListener('change',()=>{if(result){result=null;active=null;$('xrd-plot').innerHTML='';$('xrd-export-csv').disabled=true;status('XRD settings changed. Calculate XRD to update the pattern.');}}));
 document.querySelectorAll('[data-xrd-source]').forEach(e=>e.onchange=calculate);
 $('xrd-export-csv').onclick=()=>{if(!result)return;const selected=[...document.querySelectorAll('[data-xrd-source]:checked')].map(e=>e.value),blob=new Blob([XrdCore.serializeCsv(result,selected)],{type:'text/csv'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='xrd-pattern.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);};
 document.getElementById('relax-tab')?.addEventListener('click',()=>{panel.hidden=false;});
 document.getElementById('phonon-tab')?.addEventListener('click',()=>{panel.hidden=true;});
 document.getElementById('spectroscopy-tab')?.addEventListener('click',()=>{panel.hidden=true;});
 document.addEventListener('macer-structure-applied',()=>{result=null;active=null;$('xrd-plot').innerHTML='';$('xrd-export-csv').disabled=true;status('Structure changed. Calculate XRD to use the new geometry.');});
 document.addEventListener('macer-result-step-selected',()=>{if(active?.source==='result'){result=null;active=null;$('xrd-plot').innerHTML='';$('xrd-export-csv').disabled=true;status('Relax step changed. Calculate XRD to update the pattern.');}});
 $('structure')?.addEventListener('input',()=>{if(active?.source==='input'){result=null;active=null;$('xrd-plot').innerHTML='';$('xrd-export-csv').disabled=true;status('Input changed. Calculate XRD to update the pattern.');}});
 document.querySelectorAll('[data-xrd-source]').forEach(e=>e.checked=e.value==='CuKa12');
 globalThis.addEventListener('resize',draw);
 globalThis.XrdUI=Object.freeze({calculate,draw});
})();
