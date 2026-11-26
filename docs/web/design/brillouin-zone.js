/* Reciprocal Wigner–Seitz geometry and interactive, display-only BZ viewer. */
(function(root){'use strict';
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],mul=(a,s)=>a.map(v=>v*s),add=(a,b)=>a.map((v,i)=>v+b[i]),sub=(a,b)=>a.map((v,i)=>v-b[i]),norm=a=>Math.hypot(...a);
function reciprocal(cell){const v=dot(cell[0],cross(cell[1],cell[2]));if(!Number.isFinite(v)||Math.abs(v)<1e-12)throw Error('Cannot construct a Brillouin zone for a singular cell.');return [0,1,2].map(i=>mul(cross(cell[(i+1)%3],cell[(i+2)%3]),2*Math.PI/v));}
const cart=(q,b)=>[0,1,2].map(i=>q.reduce((s,v,j)=>s+v*b[j][i],0));
const fractional=(v,cell)=>cell.map(a=>dot(a,v)/(2*Math.PI));
function geometry(cell){
 const b=reciprocal(cell),det=dot(b[0],cross(b[1],b[2])),dual=[0,1,2].map(i=>mul(cross(b[(i+1)%3],b[(i+2)%3]),1/det));
 let radius=0;for(let k=0;k<8;k++){const corner=[0,0,0];for(let j=0;j<3;j++)for(let i=0;i<3;i++)corner[i]+=dual[j][i]*dot(b[j],b[j])/2*((k>>j&1)?1:-1);radius=Math.max(radius,norm(corner));}
 const eps=radius*1e-9,L=radius*(1+1e-8),faces=[];
 for(let axis=0;axis<3;axis++)for(const sign of [-1,1]){const n=[0,0,0];n[axis]=sign;const u=[0,0,0],v=[0,0,0];u[(axis+1)%3]=1;v[(axis+2)%3]=sign;faces.push([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>add(mul(n,L),add(mul(u,x*L),mul(v,y*L)))));}
 const bounds=cell.map(a=>Math.ceil(2*radius*norm(a)/(2*Math.PI)+1e-9)),count=bounds.reduce((p,n)=>p*(2*n+1),1);
 if(count>200000)throw Error('Cell is too ill-conditioned for certified Brillouin-zone construction.');
 const planes=[];for(let i=-bounds[0];i<=bounds[0];i++)for(let j=-bounds[1];j<=bounds[1];j++)for(let k=-bounds[2];k<=bounds[2];k++){if(!i&&!j&&!k)continue;const g=cart([i,j,k],b),length=norm(g);if(length<=2*radius+eps)planes.push({g,h:length*length/2,length});}planes.sort((a,b)=>a.length-b.length);
 let polys=faces;
 for(const {g,h,length} of planes){const next=[],cap=[];for(const face of polys){const out=[];for(let i=0;i<face.length;i++){const a=face[i],c=face[(i+1)%face.length],da=dot(a,g)-h,dc=dot(c,g)-h,ina=da<=eps*length,inc=dc<=eps*length;if(ina)out.push(a);if(ina!==inc){const p=add(a,mul(sub(c,a),da/(da-dc)));out.push(p);if(!cap.some(v=>norm(sub(v,p))<eps))cap.push(p);}}if(out.length>=3)next.push(out);}
  if(cap.length>=3){const center=mul(cap.reduce(add,[0,0,0]),1/cap.length),normal=mul(g,1/length),u=mul(sub(cap[0],center),1/norm(sub(cap[0],center))),v=cross(normal,u);cap.sort((a,b)=>Math.atan2(dot(sub(a,center),v),dot(sub(a,center),u))-Math.atan2(dot(sub(b,center),v),dot(sub(b,center),u)));next.push(cap);}polys=next;
 }
 let volume=0;for(const f of polys)for(let i=1;i<f.length-1;i++)volume+=dot(f[0],cross(f[i],f[i+1]))/6;
 if(Math.abs(Math.abs(volume)/Math.abs(det)-1)>1e-8)throw Error('Brillouin-zone volume verification failed.');
 return {reciprocal:b,faces:polys,volume:Math.abs(volume),expectedVolume:Math.abs(det),radius:Math.max(...polys.flat().map(norm)),enumeratedVectors:planes.length};
}
function create(canvas,onSelect,onPick){
 const T=root.THREE,renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false});renderer.setClearColor(0xffffff);renderer.setPixelRatio(Math.min(root.devicePixelRatio||1,2));
 let scene,camera,data,geo,explicit=false,projected=[],yaw=-.6,pitch=.35,zoom=1,down=null,pinch=null,selected=0,currentSegment=0,frame=0,width=0,height=0;
 const pointOf=p=>explicit?p.position:cart(p.q,geo.reciprocal);
 const gridSides=[];
 let selectedPosition=null, pickableFaces=[];
 function addGrid() {
  gridSides.length=0;
  if(!data.grid)return;
  for(const [axis,guide] of data.grid.entries()){
   for(const [side,bound] of guide.bounds.entries()){
    const g=new T.Geometry();
    for(const [index,parallel] of data.grid.entries()){
     if(index===axis)continue;
     const other=3-axis-index;
     for(const tick of [...parallel.ticks,...parallel.bounds.map(position=>({position}))]){
      for(const end of data.grid[other].bounds){
       const p=new T.Vector3();
       p.setComponent(axis,bound);p.setComponent(index,tick.position);p.setComponent(other,end);
       g.vertices.push(p);
      }
     }
    }
    const plane=new T.Geometry();
    const u=(axis+1)%3,v=(axis+2)%3;
    plane.vertices=[[0,0],[1,0],[1,1],[0,1]].map(([i,j])=>{
     const p=new T.Vector3();
     p.setComponent(axis,bound);
     p.setComponent(u,data.grid[u].bounds[i]);
     p.setComponent(v,data.grid[v].bounds[j]);
     return p;
    });
    plane.faces=[new T.Face3(0,1,2),new T.Face3(0,2,3)];
    const panel=new T.Mesh(plane,new T.MeshBasicMaterial({
     color:0xe4ecf7,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:2,polygonOffsetUnits:2,
    }));
    const line=new T.LineSegments(g,new T.LineBasicMaterial({color:0xffffff}));
    scene.add(panel);scene.add(line);
    gridSides.push({line,panel,axis,side});
   }
  }
 }
 const projectToScreen=(point,rect)=>{
  const p=new T.Vector3(...point).project(camera);
  return [(p.x+1)*rect.width/2,(1-p.y)*rect.height/2];
 };
 function drawGridLabels(rect,seen){
  if(!data.grid)return;
  const near=data.grid.map((_,axis)=>camera.position.getComponent(axis)>=0?1:0);
  const centroid=[rect.width/2,rect.height/2];
  const append=(text,x,y,className,{target=false,subscript,unit}={})=>{
   const unitText=unit?` [${unit}]`:'';
   const width=(text.length+(subscript?.length??0))*(className==='bz-face-caption'?8:7)+unitText.length*5.5+6;
   if(className==='bz-axis-caption')x=Math.max(width/2+3,Math.min(x,rect.width-width/2-3));
   if(x-width/2<0||x+width/2>rect.width||y<9||y>rect.height-9||
      seen.some(p=>Math.abs(p.x-x)<(p.width+width)/2&&Math.abs(p.y-y)<15))return;
   seen.push({x,y,width});
   const label=document.createElement('span');
   label.className=className;
   label.textContent=text;
   if(subscript){
    const sub=document.createElement('sub');
    sub.textContent=subscript;
    label.append(sub);
   }
   if(unitText){
    const units=document.createElement('span');
    units.className='bz-axis-unit';
    units.textContent=unitText;
    label.append(units);
   }
   label.dataset.target=String(target);
   label.style.left=x+'px';label.style.top=y+'px';
   label.setAttribute('aria-hidden','true');
   labels.append(label);
  };
  for(const [axis,guide] of data.grid.entries()){
   const edge=data.grid.map(({bounds},i)=>bounds[i===1?0:near[i]]);
   if(axis===1){
    const side=Math.abs(camera.position.x)>Math.abs(camera.position.z)?2:0;
    edge[side]=data.grid[side].bounds[1-near[side]];
   }
   const at=value=>projectToScreen(edge.map((x,i)=>i===axis?value:x),rect);
   const start=at(guide.bounds[0]),end=at(guide.bounds[1]),dx=end[0]-start[0],dy=end[1]-start[1];
   const length=Math.hypot(dx,dy);
   if(length<38)continue;
   const middle=at((guide.bounds[0]+guide.bounds[1])/2);
   const sign=Math.sign((middle[0]-centroid[0])*dy-(middle[1]-centroid[1])*dx)||1;
   const offset=[sign*dy/length,-sign*dx/length];
   const title=axis===1
    ? [end[0]+offset[0]*15,end[1]-19]
    : [middle[0]+offset[0]*40,middle[1]+offset[1]*48];
   append(guide.label,...title,'bz-axis-caption',{subscript:guide.subscript,unit:guide.unit});
   for(const tick of guide.ticks){
    const [x,y]=at(tick.position);
    append(tick.label,x+offset[0]*15,y+offset[1]*12,'bz-axis-tick');
   }
  }
  for(const [index,face] of geo.faces.entries()){
   const style=geo.faceStyles[index];
   if(!style.label)continue;
   const normal=cross(sub(face[1],face[0]),sub(face[2],face[0]));
   const center=mul(face.reduce(add,[0,0,0]),1/face.length);
   const facing=dot(normal,camera.position.toArray())*(dot(normal,style.normal)<0?-1:1);
   if(facing<=0)continue;
   const [x,y]=projectToScreen(center,rect);
   // Only label a face that is wide enough to contain its formula on screen.
   const points=face.map(p=>projectToScreen(p,rect));
   const area=Math.abs(points.reduce((sum,p,i)=>{
    const q=points[(i+1)%points.length];
    return sum+p[0]*q[1]-p[1]*q[0];
   },0))/2;
   if(area>Math.max(180,style.label.length*72))append(style.label,x,y,'bz-face-caption',{target:style.target});
  }
 }
 function orbit(){
  const rect=canvas.getBoundingClientRect();
  if(!rect.width||!rect.height||!scene)return;
  if(rect.width!==width||rect.height!==height){
   width=rect.width;height=rect.height;
   renderer.setSize(width,height,false);
  }
  const aspect=rect.width/rect.height;
  const radius=geo.radius;
  let distance;
  if(data.grid){
   // macer-pydefect uses Plotly's 45° perspective, with a (1.25, 1.25, 1.25)
   // eye on a unit box expanded by 1/32 on each side. Preserve that framing.
   const halfFov=Math.atan(Math.tan(Math.PI/8)/(Math.min(1,aspect)*zoom));
   camera=new T.PerspectiveCamera(2*halfFov*180/Math.PI,aspect,radius*.01,radius*100);
   distance=radius*2.5*(1+2/32);
  }else{
   const extent=radius*1.25/zoom;
   camera=new T.OrthographicCamera(-extent*aspect,extent*aspect,extent,-extent,.001,radius*100);
   distance=radius*5;
  }
  camera.position.set(Math.sin(yaw)*Math.cos(pitch)*distance,Math.sin(pitch)*distance,Math.cos(yaw)*Math.cos(pitch)*distance);
  camera.lookAt(new T.Vector3());
  camera.updateMatrixWorld();
  for(const {line,panel,axis,side} of gridSides)line.visible=panel.visible=side===(camera.position.getComponent(axis)>=0?0:1);
  renderer.render(scene,camera);
  projected=data.qpoints.map((point,index)=>{
   const [x,y]=projectToScreen(pointOf(point),rect);
   return {x,y,index,label:point.label||''};
  });
  drawLabels();
 }
 const labels=canvas.parentElement.querySelector('.bz-labels');
 function drawCpdVertices(){
  const rect=canvas.getBoundingClientRect();
  const focused=labels.contains(document.activeElement)?document.activeElement.dataset.vertex:null;
  labels.replaceChildren();
  const points=projected.filter(p=>p.label);
  const placed=[];
  const offsets=[[0,-21],[22,-15],[-22,-15],[22,15],[-22,15],[0,21],[0,-44],[0,44]];
  for(const p of points){
   const dot=document.createElement('span');
   dot.className='bz-cpd-point';
   dot.dataset.vertex=String(p.index);
   dot.dataset.selected=String(p.index===selected);
   dot.style.left=p.x+'px';
   dot.style.top=p.y+'px';
   dot.setAttribute('aria-hidden','true');
   labels.append(dot);

   const width=Math.max(24,p.label.length*11+8);
   const [x,y]=offsets.map(([dx,dy])=>[p.x+dx,p.y+dy]).find(([x,y])=>
    x>=width/2&&x<=rect.width-width/2&&y>=13&&y<=rect.height-13&&
    points.every(point=>Math.abs(point.x-x)>width/2+8||Math.abs(point.y-y)>18)&&
    placed.every(label=>Math.abs(label.x-x)>(label.width+width)/2||Math.abs(label.y-y)>24)
   )??[p.x,p.y-21];
   placed.push({...p,x,y,width});
   const leader=document.createElement('span');
   leader.className='bz-cpd-leader';
   leader.setAttribute('aria-hidden','true');
   leader.style.left=p.x+'px';
   leader.style.top=p.y+'px';
   leader.style.width=Math.max(0,Math.hypot(x-p.x,y-p.y)-10)+'px';
   leader.style.transform=`rotate(${Math.atan2(y-p.y,x-p.x)}rad)`;
   labels.prepend(leader);

   const button=document.createElement('button');
   button.type='button';
   button.dataset.vertex=String(p.index);
   button.textContent=p.label;
   button.title=data.qpoints[p.index].title||p.label;
   button.setAttribute('aria-label','Vertex '+p.label);
   button.setAttribute('aria-pressed',String(p.index===selected));
   button.style.left=x+'px';
   button.style.top=y+'px';
   button.onclick=()=>selectPoint(p.index);
   labels.append(button);
   if(button.dataset.vertex===focused)button.focus({preventScroll:true});
  }
  drawGridLabels(rect,[...placed,...points.map(p=>({...p,width:16}))]);
  if(selectedPosition){
   const [x,y]=projectToScreen(selectedPosition,rect);
   const dot=document.createElement('span');
   dot.className='bz-cpd-picked-point';
   dot.style.left=x+'px';
   dot.style.top=y+'px';
   dot.setAttribute('aria-hidden','true');
   labels.append(dot);
  }
 }
 function drawLabels(){if(!labels)return;if(data.grid){drawCpdVertices();return;}labels.replaceChildren();const seen=[];
  if(explicit){
   const rect=canvas.getBoundingClientRect();
   for(const axis of data.axes||[]){const end=new T.Vector3(...axis.ends[1]).project(camera),label=document.createElement('span');label.className='bz-axis-caption';label.textContent=axis.label;label.style.left=(end.x+1)*rect.width/2+'px';label.style.top=(1-end.y)*rect.height/2+'px';labels.append(label);}
  }for(const p of projected){if(!p.label||seen.some(a=>a.label===p.label&&Math.hypot(a.x-p.x,a.y-p.y)<5))continue;const width=Math.max(20,p.label.length*8+8);let y=p.y;while(seen.some(a=>Math.abs(a.x-p.x)<(a.width+width)/2&&Math.abs(a.y-y)<18))y+=18;seen.push({...p,y,width});const button=document.createElement('button');button.textContent=p.label;button.title=explicit?(data.qpoints[p.index].title||p.label):'Select '+p.label;if(explicit)button.setAttribute('aria-pressed',String(selected===p.index));button.style.left=p.x+'px';button.style.top=y+'px';button.onclick=()=>selectPoint(p.index);labels.append(button);}if(explicit)drawGridLabels(canvas.getBoundingClientRect(),seen);}
 function selectPoint(index){if(explicit){onSelect(index);return;}const q=data.qpoints[index].q,occurrences=data.qpoints.flatMap((p,i)=>norm(sub(p.q,q))<1e-8?[i]:[]);const seg=data.segments[currentSegment];const preferred=occurrences.find(i=>seg&&i>=seg.start&&i<=seg.end);onSelect(preferred??index);const chooser=canvas.parentElement.parentElement.querySelector('.bz-occurrences');if(chooser){chooser.replaceChildren();if(occurrences.length>1){const label=document.createElement('label');label.textContent='Path occurrence ';const select=document.createElement('select');for(const i of occurrences){const si=data.segments.findIndex(s=>i>=s.start&&i<=s.end);select.add(new Option(`${si+1}: ${(data.segments[si]?.labels||[]).join(' → ')} · q ${i+1}`,i));}select.value=String(preferred??index);select.onchange=()=>onSelect(Number(select.value));label.append(select);chooser.append(label);}}}
 function build(){if(scene){scene.traverse(o=>{o.geometry?.dispose();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();});}scene=new T.Scene();pickableFaces=[];addGrid();for(const [index,face] of geo.faces.entries()){const g=new T.Geometry();g.vertices=face.map(p=>new T.Vector3(...p));for(let i=1;i<face.length-1;i++)g.faces.push(new T.Face3(0,i,i+1));g.computeFaceNormals();const mesh=new T.Mesh(g,new T.MeshBasicMaterial({color:geo.faceStyles?.[index]?.color??0x83aed4,transparent:!data.grid,opacity:geo.faceStyles?.[index]?.opacity??.16,side:T.DoubleSide,depthWrite:!!data.grid,polygonOffset:!!data.grid,polygonOffsetFactor:1,polygonOffsetUnits:1}));scene.add(mesh);if(data.pickSurface)pickableFaces.push(mesh);const edge=new T.Geometry();edge.vertices=[...face,face[0]].map(p=>new T.Vector3(...p));scene.add(new T.Line(edge,new T.LineBasicMaterial({color:geo.faceStyles?.[index]?.edgeColor??geo.faceStyles?.[index]?.color??0x6e859c})));}
  for(const s of data.segments){const line=new T.Geometry();line.vertices=data.qpoints.slice(s.start,s.end+1).map(p=>new T.Vector3(...pointOf(p)));scene.add(new T.Line(line,new T.LineBasicMaterial({color:0x346aa6})));}
  for(const axis of data.axes||[]){const line=new T.Geometry();line.vertices=axis.ends.map(p=>new T.Vector3(...p));scene.add(new T.Line(line,new T.LineBasicMaterial({color:0x536b80})));}
  if(data.grid){orbit();return;}
  if(data.pointCloud){const g=new T.Geometry();g.vertices=data.qpoints.map(p=>new T.Vector3(...p.position));g.colors=data.qpoints.map(p=>new T.Color(p.color||'#888888'));const P=T.Points||T.PointCloud,M=T.PointsMaterial||T.PointCloudMaterial;scene.add(new P(g,new M({size:6,vertexColors:T.VertexColors,sizeAttenuation:false})));}
  const pointGeometry=new T.SphereGeometry(geo.radius*.012,10,8),pointMaterial=new T.MeshBasicMaterial({color:0x466581});const seenPoints=[];for(const q of data.qpoints){if(!q.label)continue;const p=pointOf(q);if(seenPoints.some(v=>norm(sub(v,p))<1e-8))continue;seenPoints.push(p);const point=new T.Mesh(pointGeometry,pointMaterial);point.position.set(...p);scene.add(point);}
  if(data.qpoints[selected]){const marker=new T.Mesh(new T.SphereGeometry(geo.radius*.025,16,12),new T.MeshBasicMaterial({color:explicit&&!data.pointCloud?0x185b94:0xdb452f}));marker.position.set(...pointOf(data.qpoints[selected]));scene.add(marker);}orbit();}
 const pointers=new Map();
 const clampZoom=value=>Math.max(.2,Math.min(8,value));
 function scheduleOrbit(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;orbit();});}
 function spacing(){
  const [a,b]=pointers.values();
  return Math.hypot(a.x-b.x,a.y-b.y);
 }
 canvas.addEventListener('pointerdown',e=>{
  if(e.button!==0||pointers.size>=2)return;
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  canvas.setPointerCapture(e.pointerId);
  if(pointers.size===2){
   pinch={distance:Math.max(1,spacing()),zoom};
   down=null;
  }else down={x:e.clientX,y:e.clientY,yaw,pitch,moved:false};
 });
 canvas.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId))return;
  pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pinch&&pointers.size===2){
   zoom=clampZoom(pinch.zoom*spacing()/pinch.distance);
   scheduleOrbit();
  }else if(down){
   const dx=e.clientX-down.x,dy=e.clientY-down.y;
   if(Math.hypot(dx,dy)>6)down.moved=true;
   if(down.moved){
    yaw=down.yaw+dx*.008;
    pitch=Math.max(-1.5,Math.min(1.5,down.pitch+dy*.008));
    scheduleOrbit();
   }
  }
 });
 function endPointer(e){
  if(!pointers.delete(e.pointerId))return null;
  const was=down;
  down=null;pinch=null;
  if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
  return was;
 }
 canvas.addEventListener('pointerup',e=>{const was=endPointer(e);if(!was)return;if(was.moved||!data)return;const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;const hitRadius=data.grid&&e.pointerType==='touch'?24:16;let best=null;for(const p of projected){const d=Math.hypot(p.x-x,p.y-y);if(d<hitRadius&&(!best||d<best.d))best={...p,d};}if(best&&(!data.pickSurface||best.d<(e.pointerType==='touch'?12:8))){selectPoint(best.index);return;}
  if(data.pickSurface&&camera){
   const ray=new T.Raycaster();
   ray.setFromCamera(new T.Vector2(2*x/r.width-1,1-2*y/r.height),camera);
   const hits=ray.intersectObjects(pickableFaces);
   if(hits.length&&geo.faceStyles[pickableFaces.indexOf(hits[0].object)]?.target){
    onPick?.(hits[0].point.toArray());
    return;
   }
  }
  if(best)selectPoint(best.index);});canvas.addEventListener('pointercancel',endPointer);
 canvas.addEventListener('lostpointercapture',endPointer);
 function scaleZoom(factor){zoom=clampZoom(zoom*factor);scheduleOrbit();}
 canvas.addEventListener('wheel',e=>{e.preventDefault();scaleZoom(Math.exp(-e.deltaY*.001));},{passive:false});
 const observer=new ResizeObserver(scheduleOrbit);observer.observe(canvas);
 return {load(value){explicit=false;selectedPosition=null;data=value;try{geo=geometry(data.lattice);build();}catch(error){labels.textContent=error.message;throw error;}},loadGeometry(value){
   explicit=true;
   data={qpoints:value.points,segments:[],axes:value.axes,grid:value.grid,pointCloud:!!value.pointCloud,pickSurface:!!value.pickSurface};
   geo={faces:value.faces,faceStyles:value.faceStyles,radius:value.radius,reciprocal:[[1,0,0],[0,1,0],[0,0,1]]};
   selected=value.selected??0;
   selectedPosition=null;
   build();
 },scaleZoom,select(q,segment){selected=q;selectedPosition=null;currentSegment=segment;if(data?.grid)drawLabels();else build();},selectPosition(position){selected=-1;selectedPosition=position;drawLabels();},fit(){yaw=data?.grid ? Math.PI/4 : -.6;pitch=data?.grid ? Math.atan(1/Math.sqrt(2)) : .35;zoom=1;orbit();},axis(i){const v=geo.reciprocal[i];yaw=Math.atan2(v[0],v[2]);pitch=Math.asin(v[1]/norm(v));orbit();},projectedPoints(){return projected.map(p=>({...p}));},getView(){return {yaw,pitch,zoom};},restore(v){if(v&&[v.yaw,v.pitch,v.zoom].every(Number.isFinite)){yaw=v.yaw;pitch=v.pitch;zoom=v.zoom;orbit();}}};
}
root.BrillouinZone={geometry,reciprocal,cart,fractional,create};if(typeof module==='object')module.exports=root.BrillouinZone;
})(globalThis);
