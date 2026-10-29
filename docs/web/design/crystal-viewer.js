/* Local WebGL crystal viewer. Display copies never enter the calculation structure. */
(function(root){
  'use strict';
  const mat4Multiply=(a,b)=>{
    const out=new Float32Array(16);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++)out[c*4+r]=a[r]*b[c*4]+a[4+r]*b[c*4+1]+a[8+r]*b[c*4+2]+a[12+r]*b[c*4+3];
    return out;
  };
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const sub=(a,b)=>a.map((v,i)=>v-b[i]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=v=>Math.hypot(...v)||1;
  const normalize=v=>v.map(x=>x/norm(v));
  const CRYSTAL_COLORS={H:'#f5cccc',C:'#805b4a',N:'#b0badf',O:'#e82b2b',Na:'#facd3c',Mg:'#7ddb35',Al:'#bfb9ae',Si:'#d5ad82',P:'#ed8a17',S:'#e8d830',Cl:'#37c934',Ca:'#58d82e',Fe:'#e56b38',Cu:'#c88445',Zn:'#8e9081',Ag:'#c8c8c8',Au:'#f6c744'};
  function atomRadiusForModel(model,style,scale=1,element=null){
    const radius=Number(style.covalent_radius_angstrom)||.9;
    if(model==='phonon-vesta')return element&&root.PhononwebsiteVestaStyle?.atomRadiusForElement?root.PhononwebsiteVestaStyle.atomRadiusForElement(element,scale):radius/2.3*scale;
    if(model==='ball-and-stick')return radius*.4*scale;
    if(model==='space-filling')return radius*scale;
    if(model==='stick')return Math.max(.045,radius*.11)*scale;
    return (Number(style.display_radius_angstrom)||.23)*scale;
  }
  function lookAt(eye,target,up=[0,1,0]){
    const z=normalize(sub(eye,target));if(Math.abs(dot(normalize(up),z))>.98)up=[0,0,1];
    const x=normalize(cross(up,z)),y=cross(z,x);
    return new Float32Array([x[0],y[0],z[0],0,x[1],y[1],z[1],0,x[2],y[2],z[2],0,-dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
  }
  function perspective(fov,aspect,near,far){
    const f=1/Math.tan(fov/2),out=new Float32Array(16);
    out[0]=f/aspect;out[5]=f;out[10]=(far+near)/(near-far);out[11]=-1;out[14]=2*far*near/(near-far);
    return out;
  }
  function orthographic(halfWidth,halfHeight,near,far){
    const out=new Float32Array(16);out[0]=1/halfWidth;out[5]=1/halfHeight;out[10]=-2/(far-near);out[14]=-(far+near)/(far-near);out[15]=1;return out;
  }
  function hexColor(hex){
    const value=parseInt(hex.replace('#',''),16);
    return [(value>>16&255)/255,(value>>8&255)/255,(value&255)/255];
  }
  function atomAppearance(baseColor,{selected=false}={}){
    return {color:Array.isArray(baseColor)?baseColor.slice():hexColor(baseColor),selected};
  }
  function shader(gl,type,source){
    const value=gl.createShader(type);gl.shaderSource(value,source);gl.compileShader(value);
    if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(value)||'WebGL shader compile failed');
    return value;
  }
  function program(gl,vertex,fragment){
    const result=gl.createProgram();gl.attachShader(result,shader(gl,gl.VERTEX_SHADER,vertex));gl.attachShader(result,shader(gl,gl.FRAGMENT_SHADER,fragment));gl.linkProgram(result);
    if(!gl.getProgramParameter(result,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(result)||'WebGL program link failed');
    return result;
  }
  function makeSphere(latitudes=20,longitudes=30){
    const positions=[],normals=[];
    const point=(lat,lon)=>{const theta=Math.PI*lat/latitudes,phi=2*Math.PI*lon/longitudes;return [Math.cos(phi)*Math.sin(theta),Math.cos(theta),Math.sin(phi)*Math.sin(theta)];};
    for(let lat=0;lat<latitudes;lat++)for(let lon=0;lon<longitudes;lon++){
      const a=point(lat,lon),b=point(lat+1,lon),c=point(lat,lon+1),d=point(lat+1,lon+1);
      for(const p of [a,b,c,c,b,d]){positions.push(...p);normals.push(...p);}
    }
    return {positions:new Float32Array(positions),normals:new Float32Array(normals),count:positions.length/3};
  }
  function makeCylinderMesh(lines,radius=.055,segments=10,edgeColors=null){
    const positions=[],normals=[],colors=[];
    for(let edge=0;edge+5<lines.length;edge+=6){
      const start=lines.slice(edge,edge+3),finish=lines.slice(edge+3,edge+6),axis=sub(finish,start),length=Math.hypot(...axis);
      if(length<1e-8||!Number.isFinite(length))continue;
      const direction=axis.map(value=>value/length),helper=Math.abs(direction[2])<.9?[0,0,1]:[0,1,0];
      const u=normalize(cross(direction,helper)),v=cross(direction,u),color=edgeColors?.slice(edge/2,edge/2+3)||[.59,.64,.7];
      for(let side=0;side<segments;side++){
        const a=2*Math.PI*side/segments,b=2*Math.PI*(side+1)/segments;
        const radialA=u.map((value,i)=>value*Math.cos(a)+v[i]*Math.sin(a)),radialB=u.map((value,i)=>value*Math.cos(b)+v[i]*Math.sin(b));
        const p=start.map((value,i)=>value+radius*radialA[i]),q=start.map((value,i)=>value+radius*radialB[i]);
        const r=finish.map((value,i)=>value+radius*radialA[i]),s=finish.map((value,i)=>value+radius*radialB[i]);
        for(const [point,normal] of [[p,radialA],[q,radialB],[r,radialA],[q,radialB],[s,radialB],[r,radialA]]){positions.push(...point);normals.push(...normal);colors.push(...color);}
      }
    }
    return {positions:new Float32Array(positions),normals:new Float32Array(normals),colors:new Float32Array(colors),count:positions.length/3};
  }
  function rowTimesCell(fractional,cell){return [0,1,2].map(axis=>fractional.reduce((sum,value,row)=>sum+value*cell[row][axis],0));}
  function determinant(cell){const[a,b,c]=cell;return a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);}
  function crossNorm(a,b){return norm(cross(a,b));}
  function boundsOfPoints(points){
    if(!points.length)return {min:[0,0,0],max:[0,0,0]};
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(const point of points)for(let axis=0;axis<3;axis++){
      const value=point[axis]===0?0:point[axis];
      if(value<min[axis])min[axis]=value;
      if(value>max[axis])max[axis]=value;
    }
    return {min,max};
  }
  function bondImageBounds(cell,positions,maxCutoff){
    const volume=Math.abs(determinant(cell));
    if(!Number.isFinite(volume)||volume<1e-12||!positions.length)return [0,0,0];
    const[a,b,c]=cell,reciprocal=[cross(b,c),cross(c,a),cross(a,b)].map(vector=>vector.map(value=>value/volume));
    const fractionalBounds=Array.from({length:3},()=>({min:Infinity,max:-Infinity}));
    for(const position of positions)for(let axis=0;axis<3;axis++){
      const value=dot(position,reciprocal[axis]);
      fractionalBounds[axis].min=Math.min(fractionalBounds[axis].min,value);
      fractionalBounds[axis].max=Math.max(fractionalBounds[axis].max,value);
    }
    const spans=fractionalBounds.map(bounds=>bounds.max-bounds.min);
    return cell.map((_,axis)=>{
      const height=volume/crossNorm(cell[(axis+1)%3],cell[(axis+2)%3]);
      return Math.max(0,Math.floor(spans[axis]+maxCutoff/height+1e-12));
    });
  }
  function instanceTranslations(repeats,periodic){
    const dims=periodic?repeats:[1,1,1],values=[];
    for(let i=0;i<dims[0];i++)for(let j=0;j<dims[1];j++)for(let k=0;k<dims[2];k++)values.push([i,j,k]);
    return values;
  }
  // A closed display cell includes equivalent atoms on both boundary faces.
  // Wrapping and snapping are display-only: source coordinates stay untouched.
  function displayInstances(structure,repeats=[1,1,1],boundary=true,neighbors=false,bondMode='auto'){
    const cell=structure.cell,pbc=cell?(structure.pbc||[true,true,true]):[false,false,false];
    const volume=cell?determinant(cell):0,periodic=!!cell&&Math.abs(volume)>1e-12&&pbc.some(Boolean);
    const reciprocal=periodic?[cross(cell[1],cell[2]),cross(cell[2],cell[0]),cross(cell[0],cell[1])].map(row=>row.map(x=>x/volume)):null;
    const dims=repeats.map((n,axis)=>periodic&&pbc[axis]?n:1),instances=[];
    for(let id=0;id<structure.atoms.length;id++){
      const position=structure.atoms[id].position;
      if(!periodic||structure.displayUnwrapped){instances.push({id,position:position.slice(),translation:[0,0,0]});continue;}
      const f=reciprocal.map(row=>dot(position,row)).map((value,axis)=>{
        if(!pbc[axis])return value;
        const wrapped=value-Math.floor(value);
        return wrapped<1e-7||1-wrapped<1e-7?0:wrapped;
      });
      const counts=dims.map((n,axis)=>n+(boundary&&pbc[axis]&&f[axis]===0?1:0));
      for(let a=0;a<counts[0];a++)for(let b=0;b<counts[1];b++)for(let c=0;c<counts[2];c++){
        const translation=[a,b,c];
        instances.push({id,translation,position:rowTimesCell(f.map((v,axis)=>v+translation[axis]),cell)});
      }
    }
    if(neighbors&&periodic){
      const edges=displayBaseBondEdges(structure,bondMode),adjacency=structure.atoms.map(()=>[]);
      for(const edge of edges){
        adjacency[edge.i].push({id:edge.j,shift:edge.shift});
        adjacency[edge.j].push({id:edge.i,shift:edge.shift.map(v=>-v)});
      }
      const key=(id,translation)=>id+':'+translation.join(','),lookup=new Set(instances.map(atom=>key(atom.id,atom.translation)));
      const bases=displayInstances(structure,[1,1,1],false);
      // Expand one bonded layer from the closed cell, including negative images.
      for(const atom of instances.slice())for(const edge of adjacency[atom.id]){
        const translation=atom.translation.map((v,axis)=>v+edge.shift[axis]),id=key(edge.id,translation);
        if(lookup.has(id))continue;lookup.add(id);
        const delta=rowTimesCell(translation,cell);
        instances.push({id:edge.id,translation,position:bases[edge.id].position.map((v,axis)=>v+delta[axis])});
      }
    }
    return instances;
  }
  function lexPositive(v){for(const x of v)if(x!==0)return x>0;return false;}
  function bondEdges(cell,positions,radii,periodic,options={}){
    const maxCutoff=radii.reduce((maximum,radius)=>Math.max(maximum,radius),0)*2.5;
    const bounds=periodic?bondImageBounds(cell,positions,maxCutoff):[0,0,0],images=[];
    for(let x=-bounds[0];x<=bounds[0];x++)for(let y=-bounds[1];y<=bounds[1];y++)for(let z=-bounds[2];z<=bounds[2];z++){
      const shift=[x||0,y||0,z||0];images.push({shift,vector:cell?rowTimesCell(shift,cell):[0,0,0],self:lexPositive(shift)});
    }
    const edges=[],distances=[],nearest=positions.map(()=>Infinity);
    // Reuse each image translation; the pair loop needs no temporary vectors.
    for(let i=0;i<positions.length;i++)for(let j=i;j<positions.length;j++){
      const a=positions[i],b=positions[j],cutoff=1.25*(radii[i]+radii[j]),cutoff2=cutoff*cutoff;
      const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
      for(const image of images){
        if(i===j&&!image.self)continue;
        const x=dx+image.vector[0],y=dy+image.vector[1],z=dz+image.vector[2],distance2=x*x+y*y+z*z;
        if(distance2>.15*.15&&distance2<=cutoff2){
          edges.push({i,j,shift:image.shift});distances.push(distance2);
          nearest[i]=Math.min(nearest[i],distance2);nearest[j]=Math.min(nearest[j],distance2);
        }
      }
    }
    return options.mode==='nearest'?edges.filter((edge,index)=>distances[index]<=1.44*Math.max(nearest[edge.i],nearest[edge.j])):edges;
  }
  function displayBaseBondEdges(structure,mode='auto'){
    if(structure.atoms.length>400)return [];
    const cell=structure.cell,periodic=!!cell&&(structure.pbc||[true,true,true]).some(Boolean);
    const base=displayInstances(structure,[1,1,1],false).map(atom=>atom.position);
    const styles=structure.atoms.map(atom=>root.ElementStyles[atom.element]||{covalent_radius_angstrom:.9});
    return bondEdges(cell,base,styles.map(style=>style.covalent_radius_angstrom),periodic,{mode:mode==='auto'?(periodic?'nearest':'covalent'):mode});
  }
  function displayBondSegments(structure,instances,repeats=[1,1,1],mode='auto'){
    const edges=displayBaseBondEdges(structure,mode);
    const key=(id,shift)=>id+':'+shift.join(','),lookup=new Map(instances.map(atom=>[key(atom.id,atom.translation),atom]));
    const bySource=structure.atoms.map(()=>[]);for(const edge of edges)bySource[edge.i].push(edge);
    const lines=[];
    for(const atom of instances)for(const edge of bySource[atom.id]){
      const other=lookup.get(key(edge.j,atom.translation.map((v,axis)=>v+edge.shift[axis])));
      // Every visible cylinder terminates at a visible atom, including images.
      if(other)lines.push(...atom.position,...other.position);
    }
    return lines;
  }
  function displayBondSegmentsWithColors(structure,instances,repeats=[1,1,1],mode='auto',colorForElement=()=>[.59,.64,.7]){
    const edges=displayBaseBondEdges(structure,mode),key=(id,shift)=>id+':'+shift.join(','),lookup=new Map(instances.map(atom=>[key(atom.id,atom.translation),atom]));
    const bySource=structure.atoms.map(()=>[]);for(const edge of edges)bySource[edge.i].push(edge);
    const lines=[],colors=[];let bondCount=0;
    for(const atom of instances)for(const edge of bySource[atom.id]){
      const other=lookup.get(key(edge.j,atom.translation.map((v,axis)=>v+edge.shift[axis])));if(!other)continue;
      const midpoint=atom.position.map((value,axis)=>(value+other.position[axis])*.5);
      lines.push(...atom.position,...midpoint,...midpoint,...other.position);
      colors.push(...(colorForElement(structure.atoms[atom.id].element)||[.59,.64,.7]),...(colorForElement(structure.atoms[other.id].element)||[.59,.64,.7]));
      bondCount++;
    }
    return {lines,colors,bondCount};
  }
  function clipBondToCell(start,finish,cell,dims=[1,1,1]){
    if(!cell)return [start.slice(),finish.slice()];
    const volume=determinant(cell),[a,b,c]=cell;
    if(!Number.isFinite(volume)||Math.abs(volume)<1e-12)return null;
    const fractional=point=>[dot(point,cross(b,c))/volume,dot(point,cross(c,a))/volume,dot(point,cross(a,b))/volume];
    const x=fractional(start),y=fractional(finish),delta=y.map((v,i)=>v-x[i]);let enter=0,leave=1;
    for(let axis=0;axis<3;axis++){
      const lo=0,hi=dims[axis];
      if(Math.abs(delta[axis])<1e-12){if(x[axis]<lo-1e-12||x[axis]>hi+1e-12)return null;continue;}
      const t0=(lo-x[axis])/delta[axis],t1=(hi-x[axis])/delta[axis];
      enter=Math.max(enter,Math.min(t0,t1));leave=Math.min(leave,Math.max(t0,t1));
      if(enter>leave+1e-12)return null;
    }
    const at=t=>rowTimesCell(x.map((value,axis)=>value+delta[axis]*t),cell);
    return [at(Math.max(0,enter)),at(Math.min(1,leave))];
  }

  function create(canvas,onSelect,onAtomMove,onAtomPreview,onSelection){
    const gl=canvas.getContext('webgl',{alpha:true,antialias:true,depth:true,preserveDrawingBuffer:false});
    if(!gl)throw new Error('WebGL 1 is unavailable in this browser.');
    const sphereProgram=program(gl,
      'attribute vec3 aPosition;attribute vec3 aNormal;attribute vec3 aCenter;attribute vec3 aColor;attribute float aRadius;uniform mat4 uViewProjection;varying vec3 vNormal;varying vec3 vColor;void main(){vec3 world=aCenter+aPosition*aRadius;vNormal=aNormal;vColor=aColor;gl_Position=uViewProjection*vec4(world,1.0);}',
      'precision mediump float;varying vec3 vNormal;varying vec3 vColor;uniform float uStyle;void main(){vec3 n=normalize(vNormal);vec3 l=normalize(vec3(-0.35,0.75,0.55));vec3 v=vec3(0.0,0.0,1.0);float diffuse=max(dot(n,l),0.0);float spec=pow(max(dot(reflect(-l,n),v),0.0),mix(5.0,28.0,uStyle))*mix(0.0,0.24,uStyle);float ambient=mix(.42,.31,uStyle);vec3 color=vColor*(ambient+(1.0-ambient)*diffuse)+vec3(spec);gl_FragColor=vec4(color,1.0);}'
    );
    const lineProgram=program(gl,
      'attribute vec3 aPosition;uniform mat4 uViewProjection;void main(){gl_Position=uViewProjection*vec4(aPosition,1.0);}',
      'precision mediump float;uniform vec4 uColor;void main(){gl_FragColor=uColor;}'
    );
    const bondProgram=program(gl,
      'attribute vec3 aPosition;attribute vec3 aNormal;attribute vec3 aColor;uniform mat4 uViewProjection;varying vec3 vNormal;varying vec3 vColor;void main(){vNormal=aNormal;vColor=aColor;gl_Position=uViewProjection*vec4(aPosition,1.0);}',
      'precision mediump float;varying vec3 vNormal;varying vec3 vColor;void main(){vec3 n=normalize(vNormal);vec3 l=normalize(vec3(-0.35,0.75,0.55));float diffuse=max(dot(n,l),0.0);gl_FragColor=vec4(vColor*(0.4+0.6*diffuse),1.0);}'
    );
    const spheres={standard:{geometry:makeSphere(20,30),position:gl.createBuffer(),normal:gl.createBuffer()},phononVesta:{geometry:makeSphere(16,16),position:gl.createBuffer(),normal:gl.createBuffer()}},instancesBuffer=gl.createBuffer(),linesBuffer=gl.createBuffer(),bondPositionBuffer=gl.createBuffer(),bondNormalBuffer=gl.createBuffer(),bondColorBuffer=gl.createBuffer();
    const instancing=gl.getExtension('ANGLE_instanced_arrays');
    const sphereLocations={position:gl.getAttribLocation(sphereProgram,'aPosition'),normal:gl.getAttribLocation(sphereProgram,'aNormal'),center:gl.getAttribLocation(sphereProgram,'aCenter'),color:gl.getAttribLocation(sphereProgram,'aColor'),radius:gl.getAttribLocation(sphereProgram,'aRadius'),vp:gl.getUniformLocation(sphereProgram,'uViewProjection'),style:gl.getUniformLocation(sphereProgram,'uStyle')};
    const lineLocations={position:gl.getAttribLocation(lineProgram,'aPosition'),vp:gl.getUniformLocation(lineProgram,'uViewProjection'),color:gl.getUniformLocation(lineProgram,'uColor')};
    const bondLocations={position:gl.getAttribLocation(bondProgram,'aPosition'),normal:gl.getAttribLocation(bondProgram,'aNormal'),color:gl.getAttribLocation(bondProgram,'aColor'),vp:gl.getUniformLocation(bondProgram,'uViewProjection')};
    for(const sphere of Object.values(spheres)){gl.bindBuffer(gl.ARRAY_BUFFER,sphere.position);gl.bufferData(gl.ARRAY_BUFFER,sphere.geometry.positions,gl.STATIC_DRAW);gl.bindBuffer(gl.ARRAY_BUFFER,sphere.normal);gl.bufferData(gl.ARRAY_BUFFER,sphere.geometry.normals,gl.STATIC_DRAW);}
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.clearColor(1,1,1,1);

    let structure=null,visible=[],yaw=-.62,pitch=.35,zoom=1,target=[0,0,0],pan=[0,0,0],selected=-1,projection='perspective';
    let display={showCell:true,showBonds:true,showBoundary:true,showNeighbors:false,bondMode:'auto',atomScale:1,bondScale:1,repeats:[1,1,1],elementStyles:{}};
    let vestaCanvas=null,vestaRenderer=null,vestaBuilt=null,vestaSourceKey='';
    let lastMatrix=null,lastCamera=null,drag=null,atomDragEnabled=false,interactionMode='rotate',selectionOperation='replace',selectionThrough=false,selectedIds=new Set();
    let lastBondCount=0;
    const compass=root.document.createElement('canvas');compass.className='axis-compass';compass.setAttribute('role','img');compass.setAttribute('aria-label','Lattice orientation compass');
    const selectionOverlay=root.document.createElementNS('http://www.w3.org/2000/svg','svg');selectionOverlay.setAttribute('aria-hidden','true');selectionOverlay.setAttribute('style','position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;overflow:hidden');
    const selectionBox=root.document.createElement('div');selectionBox.className='atom-selection-box';selectionBox.hidden=true;selectionBox.setAttribute('aria-hidden','true');canvas.parentElement.appendChild(selectionBox);
    const colors=['#cf4d4d','#278757','#377bc3'];
    canvas.parentElement.appendChild(compass);
    function drawCompass(){
      const bounds=compass.getBoundingClientRect(),dpr=root.devicePixelRatio||1,w=Math.max(1,Math.round(bounds.width*dpr)),h=Math.max(1,Math.round(bounds.height*dpr));if(compass.width!==w||compass.height!==h){compass.width=w;compass.height=h;}const ctx=compass.getContext('2d');ctx.clearRect(0,0,w,h);
      const backward=normalize(sub(lastCamera.eye,lastCamera.target));
      let up=[0,1,0];if(Math.abs(dot(up,backward))>.98)up=[0,0,1];
      const right=normalize(cross(up,backward)),vertical=cross(backward,right);
      const periodic=!!structure.cell,labels=periodic?['a','b','c']:['x','y','z'];
      compass.setAttribute('aria-label',periodic?'Lattice axes a, b, c':'Cartesian axes x, y, z');
      const center=[w*.5,h*.53],radius=Math.min(w,h)*.29,axes=[];
      labels.forEach((label,i)=>{
        const direction=normalize(periodic?structure.cell[i]:[[1,0,0],[0,1,0],[0,0,1]][i]);
        axes.push({label,color:colors[i],x:dot(direction,right),y:-dot(direction,vertical),z:dot(direction,backward)});
      });
      axes.sort((a,b)=>a.z-b.z);const placedLabels=[];
      for(const a of axes){
        const end=[center[0]+radius*a.x,center[1]+radius*a.y],alpha=a.z<-.08?.72:1,angle=Math.atan2(end[1]-center[1],end[0]-center[0]);
        ctx.globalAlpha=alpha;ctx.strokeStyle=a.color;ctx.fillStyle=a.color;ctx.lineWidth=(a.z>.08?3:2)*dpr;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(...center);ctx.lineTo(...end);ctx.stroke();
        ctx.beginPath();ctx.moveTo(end[0]+6*dpr*Math.cos(angle),end[1]+6*dpr*Math.sin(angle));ctx.lineTo(end[0]-5*dpr*Math.cos(angle-.55),end[1]-5*dpr*Math.sin(angle-.55));ctx.lineTo(end[0]-5*dpr*Math.cos(angle+.55),end[1]-5*dpr*Math.sin(angle+.55));ctx.closePath();ctx.fill();
        const projected=Math.hypot(a.x,a.y),ux=projected>.12?a.x/projected:0,uy=projected>.12?a.y/projected:0;
        const directions=projected>.12?[[ux,uy],[ux-uy*.75,uy+ux*.75],[ux+uy*.75,uy-ux*.75],[-ux,-uy],[0,-1]]:[[0,-1],[1,0],[-1,0],[0,1]];
        const candidates=directions.map((direction,index)=>{const distance=(index===0?12:index<4?18:22)*dpr;return [Math.max(8*dpr,Math.min(w-8*dpr,end[0]+direction[0]*distance)),Math.max(8*dpr,Math.min(h-8*dpr,end[1]+direction[1]*distance))]});
        const label=candidates.find(point=>placedLabels.every(other=>Math.hypot(point[0]-other[0],point[1]-other[1])>=15*dpr))||candidates.at(-1),[labelX,labelY]=label;
        if(Math.hypot(labelX-end[0],labelY-end[1])>15*dpr){ctx.globalAlpha=alpha*.55;ctx.strokeStyle=a.color;ctx.lineWidth=1*dpr;ctx.beginPath();ctx.moveTo(end[0],end[1]);ctx.lineTo(labelX,labelY);ctx.stroke();}
        placedLabels.push(label);ctx.globalAlpha=alpha;ctx.font=`700 ${14*dpr}px system-ui,sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.strokeStyle='rgba(255,255,255,.95)';ctx.lineWidth=4*dpr;ctx.strokeText(a.label,labelX,labelY);ctx.fillStyle=a.color;ctx.fillText(a.label,labelX,labelY);
      }
      ctx.globalAlpha=1;ctx.fillStyle='#586b80';ctx.beginPath();ctx.arc(center[0],center[1],2.5*dpr,0,Math.PI*2);ctx.fill();
    }
    function repeatedCell(){return structure.cell.map((row,axis)=>row.map(value=>value*display.repeats[axis]));}
    function displayCoordinates(){
      const atoms=[];
      for(const instance of displayInstances(structure,display.repeats,display.showBoundary,display.showNeighbors,display.bondMode)){
        const i=instance.id,base=structure.atoms[i];
        const style={...(root.ElementStyles[base.element]||{color:'#8fa7ba',display_radius_angstrom:.23,covalent_radius_angstrom:.9}),...(display.elementStyles?.[base.element]||{})};
        // phononwebsite stores Vesta palette entries as linear RGB and lets
        // Three.js perform lighting before its output color-space conversion.
        const baseColor=display.stylePreset==='phonon-vesta'?(root.PhononwebsiteVestaStyle?.colorLinear(base.element)||hexColor(style.color)):display.stylePreset==='custom'?style.color:(CRYSTAL_COLORS[base.element]||style.color);
        const isSelected=selectedIds.has(i)||i===selected;
        const appearance=atomAppearance(baseColor,{selected:isSelected});
        atoms.push({...instance,...appearance,radius:atomRadiusForModel(display.stylePreset,style,display.atomScale,base.element)});
      }
      return atoms;
    }
    function viewMatrix(){
      const cell=structure.cell?repeatedCell():null,points=structure.equilibriumPositions?structure.equilibriumPositions.map(point=>point.slice()):visible.map(atom=>atom.position);
      if(cell)for(let i=0;i<8;i++)points.push(rowTimesCell([i&1?display.repeats[0]:0,i&2?display.repeats[1]:0,i&4?display.repeats[2]:0],structure.cell));
      if(!points.length)points.push([0,0,0]);
      const {min,max}=boundsOfPoints(points);
      const phononCamera=Array.isArray(structure.equilibriumPositions);
      const center=phononCamera?[0,1,2].map(a=>structure.equilibriumPositions.reduce((sum,p)=>sum+p[a],0)/Math.max(1,structure.equilibriumPositions.length)):min.map((value,axis)=>(value+max[axis])/2);target=center.map((value,axis)=>value+pan[axis]);
      let extent=1;for(const point of points)extent=Math.max(extent,norm(sub(point,center)));
      const height=Math.max(canvas.height,1),aspect=Math.max(canvas.width,1)/height,fov=(phononCamera?10:34)*Math.PI/180;
      const distance=phononCamera?100/zoom:extent/Math.tan(fov/2)*1.28/zoom;
      const cp=Math.cos(pitch),eye=[target[0]+distance*Math.sin(yaw)*cp,target[1]+distance*Math.sin(pitch),target[2]+distance*Math.cos(yaw)*cp];
      const orthoHalfHeight=phononCamera?distance*Math.tan(fov/2):extent*1.28/zoom;
      lastCamera={target:target.slice(),eye,distance,fov,height,projection,orthoHalfHeight};
      const near=Math.max(distance-extent*2.5,.01),far=distance+extent*4;
      const projectionMatrix=projection==='orthographic'?orthographic(orthoHalfHeight*aspect,orthoHalfHeight,near,far):perspective(fov,aspect,near,far);
      return mat4Multiply(projectionMatrix,lookAt(eye,target));
    }
    function project(point){
      if(!lastMatrix)return [0,0,Infinity];
      const m=lastMatrix,x=point[0],y=point[1],z=point[2],cx=m[0]*x+m[4]*y+m[8]*z+m[12],cy=m[1]*x+m[5]*y+m[9]*z+m[13],cz=m[2]*x+m[6]*y+m[10]*z+m[14],cw=m[3]*x+m[7]*y+m[11]*z+m[15];
      return [(cx/cw+1)*canvas.width/2,(1-cy/cw)*canvas.height/2,cz/cw];
    }
    function cellLines(){
      const coords=[],vectors=structure.cell,dims=display.repeats;
      if(!vectors||!display.showCell)return coords;
      const p=(i,j,k)=>rowTimesCell([i,j,k],vectors);
      for(let i=0;i<dims[0];i++)for(let j=0;j<dims[1];j++)for(let k=0;k<dims[2];k++){
        const o=p(i,j,k),a=p(i+1,j,k),b=p(i,j+1,k),c=p(i,j,k+1),ab=p(i+1,j+1,k),ac=p(i+1,j,k+1),bc=p(i,j+1,k+1),abc=p(i+1,j+1,k+1);
        for(const [u,v] of [[o,a],[o,b],[o,c],[a,ab],[a,ac],[b,ab],[b,bc],[c,ac],[c,bc],[ab,abc],[ac,abc],[bc,abc]])coords.push(...u,...v);
      }
      return coords;
    }
    function vestaOuterCellLines(){
      if(!structure.cell||!display.showCell)return [];
      const[a,b,c]=repeatedCell(),o=[0,0,0],ab=a.map((v,i)=>v+b[i]),ac=a.map((v,i)=>v+c[i]),bc=b.map((v,i)=>v+c[i]),abc=ab.map((v,i)=>v+c[i]);
      return [...o,...a,...o,...b,...o,...c,...a,...ab,...a,...ac,...b,...ab,...b,...bc,...c,...ac,...c,...bc,...ab,...abc,...ac,...abc,...bc,...abc];
    }
    function disposeVestaObjects(){
      if(vestaBuilt)root.PhononwebsiteVibCrystalAdapter?.disposeVestaObjects(vestaBuilt);
      vestaBuilt=null;vestaSourceKey='';
    }
    function ensureVestaRenderer(){
      if(vestaRenderer)return;
      const adapter=root.PhononwebsiteVibCrystalAdapter;if(!adapter?.createVestaRenderer)throw new Error('The upstream phononwebsite VESTA renderer failed to load.');
      vestaCanvas=root.document.createElement('canvas');vestaCanvas.className='phononwebsite-vesta-renderer';vestaCanvas.setAttribute('aria-hidden','true');
      canvas.parentElement.insertBefore(vestaCanvas,canvas);
      vestaRenderer=adapter.createVestaRenderer(vestaCanvas);
    }
    function renderPhononVesta(){
      ensureVestaRenderer();
      const bounds=vestaCanvas.getBoundingClientRect(),dpr=root.devicePixelRatio||1,cell=structure.displayCell||(structure.cell?repeatedCell():null);
      const animated=Array.isArray(structure.equilibriumPositions);
      const bases=animated?visible.map(atom=>({...atom,position:structure.equilibriumPositions[atom.id]})):visible;
      const sourceKey=JSON.stringify([bases.map(atom=>[atom.id,atom.translation,atom.position]),structure.atoms.map(atom=>atom.element),display.showCell,display.showBonds,display.atomScale,display.bondScale,display.elementStyles,display.vestaDisplay,display.bondColorByAtom,display.bondColor,display.bondCutoffScale,display.vectorRadius,display.vectorColor,cell]);
      if(sourceKey!==vestaSourceKey){
        disposeVestaObjects();
        vestaBuilt=root.PhononwebsiteVibCrystalAdapter.buildVestaObjects(structure,bases,cell,{showCell:display.showCell&&!!cell,showBonds:display.showBonds,atomScale:display.atomScale,bondScale:display.bondScale,elementStyles:display.elementStyles,vestaDisplay:display.vestaDisplay,bondColorByAtom:display.bondColorByAtom,bondColor:display.bondColor,bondCutoffScale:display.bondCutoffScale,vectorRadius:display.vectorRadius,vectorColor:display.vectorColor});
        vestaSourceKey=sourceKey;lastBondCount=vestaBuilt.bondCount;
      }
      if(animated)root.PhononwebsiteVibCrystalAdapter.updateVestaPositions(vestaBuilt,visible,{showVectors:display.showVectors,vectorScale:display.vectorScale,vectorRadius:display.vectorRadius,vectorColor:display.vectorColor,motionAmplitude:structure.motionAmplitude});
      root.PhononwebsiteVibCrystalAdapter.renderVesta(vestaRenderer,vestaBuilt,{bounds,dpr,eye:lastCamera.eye,target:lastCamera.target,fov:lastCamera.fov,projection:lastCamera.projection,orthoHalfHeight:lastCamera.orthoHalfHeight,near:Math.max(lastCamera.distance-norm(sub(lastCamera.eye,lastCamera.target))*2.5,.01),far:lastCamera.distance+norm(sub(lastCamera.eye,lastCamera.target))*4});
      return;
    }
    function bondLines(){
      if(!display.showBonds||display.stylePreset==='space-filling')return [];
      return display.stylePreset==='phonon-vesta'?displayBondSegmentsWithColors(structure,visible,display.repeats,display.bondMode,element=>root.PhononwebsiteVestaStyle?.colorLinear(element)):displayBondSegments(structure,visible,display.repeats,display.bondMode);
    }
    function drawLines(matrix,values,color,alpha=1){
      if(!values.length)return;
      gl.useProgram(lineProgram);gl.bindBuffer(gl.ARRAY_BUFFER,linesBuffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(lineLocations.position);gl.vertexAttribPointer(lineLocations.position,3,gl.FLOAT,false,0,0);
      gl.uniformMatrix4fv(lineLocations.vp,false,matrix);gl.uniform4f(lineLocations.color,color[0],color[1],color[2],alpha);gl.drawArrays(gl.LINES,0,values.length/3);
    }
    function drawBonds(matrix,values,colors=null){
      const baseRadius=display.stylePreset==='phonon-vesta'?.1:display.stylePreset==='stick'?.075:.055,segments=display.stylePreset==='phonon-vesta'?6:14;
      const mesh=makeCylinderMesh(values,baseRadius*(display.bondScale||1),segments,colors);
      if(!mesh.count)return;
      gl.useProgram(bondProgram);gl.uniformMatrix4fv(bondLocations.vp,false,matrix);
      gl.bindBuffer(gl.ARRAY_BUFFER,bondPositionBuffer);gl.bufferData(gl.ARRAY_BUFFER,mesh.positions,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(bondLocations.position);gl.vertexAttribPointer(bondLocations.position,3,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,bondNormalBuffer);gl.bufferData(gl.ARRAY_BUFFER,mesh.normals,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(bondLocations.normal);gl.vertexAttribPointer(bondLocations.normal,3,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,bondColorBuffer);gl.bufferData(gl.ARRAY_BUFFER,mesh.colors,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(bondLocations.color);gl.vertexAttribPointer(bondLocations.color,3,gl.FLOAT,false,0,0);
      gl.drawArrays(gl.TRIANGLES,0,mesh.count);
    }
    function drawSpheres(matrix,atoms=visible){
      if(!atoms.length)return;
      const sphere=display.stylePreset==='phonon-vesta'?spheres.phononVesta:spheres.standard;
      gl.useProgram(sphereProgram);gl.uniformMatrix4fv(sphereLocations.vp,false,matrix);gl.uniform1f(sphereLocations.style,display.stylePreset==='phonon-vesta'?0:1);
      gl.bindBuffer(gl.ARRAY_BUFFER,sphere.position);gl.enableVertexAttribArray(sphereLocations.position);gl.vertexAttribPointer(sphereLocations.position,3,gl.FLOAT,false,0,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,sphere.normal);gl.enableVertexAttribArray(sphereLocations.normal);gl.vertexAttribPointer(sphereLocations.normal,3,gl.FLOAT,false,0,0);
      if(instancing){
        const packed=new Float32Array(atoms.length*7);
        atoms.forEach((atom,index)=>packed.set([...atom.position,...atom.color,atom.radius],index*7));
        gl.bindBuffer(gl.ARRAY_BUFFER,instancesBuffer);gl.bufferData(gl.ARRAY_BUFFER,packed,gl.DYNAMIC_DRAW);
        for(const [location,size,offset] of [[sphereLocations.center,3,0],[sphereLocations.color,3,12],[sphereLocations.radius,1,24]]){gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,size,gl.FLOAT,false,28,offset);instancing.vertexAttribDivisorANGLE(location,1);}
        instancing.drawArraysInstancedANGLE(gl.TRIANGLES,0,sphere.geometry.count,atoms.length);
        for(const location of [sphereLocations.center,sphereLocations.color,sphereLocations.radius])instancing.vertexAttribDivisorANGLE(location,0);
      }else{
        for(const location of [sphereLocations.center,sphereLocations.color,sphereLocations.radius])gl.disableVertexAttribArray(location);
        for(const atom of atoms){gl.vertexAttrib3fv(sphereLocations.center,atom.position);gl.vertexAttrib3fv(sphereLocations.color,atom.color);gl.vertexAttrib1f(sphereLocations.radius,atom.radius);gl.drawArrays(gl.TRIANGLES,0,sphere.geometry.count);}
      }
    }
    function drawSelectionOutline(){
      const dpr=root.devicePixelRatio||1,bounds=canvas.getBoundingClientRect();
      selectionOverlay.setAttribute('viewBox',`0 0 ${bounds.width} ${bounds.height}`);selectionOverlay.replaceChildren();
      const forward=normalize(sub(lastCamera.target,lastCamera.eye));
      for(const atom of visible){
        if(!atom.selected)continue;
        const depth=dot(sub(atom.position,lastCamera.eye),forward);if(depth<=0)continue;
        const point=project(atom.position),cx=point[0]/dpr,cy=point[1]/dpr;
        const radius=Math.max(6,atom.radius*lastCamera.height/(2*depth*Math.tan(lastCamera.fov/2)*dpr));
        const ring=root.document.createElementNS('http://www.w3.org/2000/svg','circle');ring.setAttribute('cx',String(cx));ring.setAttribute('cy',String(cy));ring.setAttribute('r',String(radius+2));ring.setAttribute('fill','none');ring.setAttribute('stroke','#fff');ring.setAttribute('stroke-width','4');
        const edge=root.document.createElementNS('http://www.w3.org/2000/svg','circle');edge.setAttribute('cx',String(cx));edge.setAttribute('cy',String(cy));edge.setAttribute('r',String(radius+2));edge.setAttribute('fill','none');edge.setAttribute('stroke','#087fc1');edge.setAttribute('stroke-width','2.2');
        selectionOverlay.append(ring,edge);
      }
    }
    function render(){
      const bounds=canvas.getBoundingClientRect(),dpr=root.devicePixelRatio||1,width=Math.max(1,Math.round(bounds.width*dpr)),height=Math.max(1,Math.round(bounds.height*dpr));
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      const vesta=display.stylePreset==='phonon-vesta';canvas.style.opacity=vesta?'0':'1';gl.clearColor(vesta?1:.965,vesta?1:.974,vesta?1:.986,1);gl.viewport(0,0,width,height);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      if(!structure)return;
      visible=displayCoordinates();lastMatrix=viewMatrix();
      if(vesta){renderPhononVesta();drawSelectionOutline();drawCompass();return;}
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);
      drawLines(lastMatrix,cellLines(),vesta?[.12,.12,.12]:[.46,.53,.62],vesta?.9:.82);
      const bonds=bondLines();if(Array.isArray(bonds)){lastBondCount=bonds.length/6;drawBonds(lastMatrix,bonds);}else{lastBondCount=bonds.bondCount;drawBonds(lastMatrix,bonds.lines,bonds.colors);}
      drawSpheres(lastMatrix);
      drawSelectionOutline();
      drawCompass();
    }
    function pick(x,y){
      let best=null,bestDistance=Infinity;
      for(const atom of visible){const p=project(atom.position),distance=Math.hypot(p[0]-x*(root.devicePixelRatio||1),p[1]-y*(root.devicePixelRatio||1));const threshold=Math.max(atom.radius*(root.devicePixelRatio||1)*1.5,10*(root.devicePixelRatio||1));if(p[2]>=-1&&p[2]<=1&&distance<threshold&&distance<bestDistance){best=atom;bestDistance=distance;}}
      return best;
    }
    function selectInRectangle(rect,add=false,remove=false,through=false){
      const dpr=root.devicePixelRatio||1,x0=Math.min(rect.x0,rect.x1),x1=Math.max(rect.x0,rect.x1),y0=Math.min(rect.y0,rect.y1),y1=Math.max(rect.y0,rect.y1),hits=new Set(),forward=normalize(sub(lastCamera.target,lastCamera.eye)),binSize=32,bins=new Map(),projected=[];
      for(const atom of visible){const p=project(atom.position),x=p[0]/dpr,y=p[1]/dpr,depth=dot(sub(atom.position,lastCamera.eye),forward),radius=Math.max(3,atom.radius*lastCamera.height/(2*Math.max(depth,.01)*Math.tan(lastCamera.fov/2)*dpr));const entry={atom,p,x,y,depth,radius};projected.push(entry);const key=`${Math.floor(x/binSize)},${Math.floor(y/binSize)}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(entry);}
      for(const entry of projected){const {atom,p,x,y,radius}=entry;if(p[2]<-1||p[2]>1||x<x0||x>x1||y<y0||y>y1)continue;
        if(!through){let occluded=false;const reach=Math.min(8,Math.ceil(Math.max(radius,12)/binSize));for(let gx=Math.floor(x/binSize)-reach;gx<=Math.floor(x/binSize)+reach&&!occluded;gx++)for(let gy=Math.floor(y/binSize)-reach;gy<=Math.floor(y/binSize)+reach&&!occluded;gy++)for(const other of bins.get(`${gx},${gy}`)||[]){if(other.atom.id===atom.id&&other.atom.translation.join(',')===atom.translation.join(','))continue;const threshold=Math.max(4,other.radius*.92);if(Math.hypot(other.x-x,other.y-y)<threshold&&other.depth<entry.depth-.002){occluded=true;break;}}if(occluded)continue;}hits.add(atom.id);
      }
      if(!add&&!remove)selectedIds=hits;else if(add)for(const id of hits)selectedIds.add(id);else for(const id of hits)selectedIds.delete(id);
      selected=selectedIds.size?Math.min(...selectedIds):-1;onSelection?.([...selectedIds].sort((a,b)=>a-b));render();
    }
    function atomDragDelta(dx,dy,anchor){
      if(!lastCamera)return [0,0,0];
      const backward=normalize(sub(lastCamera.eye,lastCamera.target)),forward=backward.map(value=>-value);
      const right=normalize(cross([0,1,0],backward)),up=cross(backward,right);
      const depth=dot(sub(anchor,lastCamera.eye),forward);
      const dpr=root.devicePixelRatio||1,scale=2*depth*Math.tan(lastCamera.fov/2)/lastCamera.height*dpr;
      return right.map((value,axis)=>(value*dx-up[axis]*dy)*scale);
    }
    canvas.addEventListener('contextmenu',event=>event.preventDefault());
    canvas.parentElement.appendChild(selectionOverlay);
    canvas.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();drag=null;selectionBox.hidden=true;selectedIds.clear();selected=-1;onSelection?.([]);render();}});
    canvas.addEventListener('pointerdown',event=>{
      canvas.setPointerCapture(event.pointerId);
      const rect=canvas.getBoundingClientRect();
      const hit=event.button===0?pick((event.clientX-rect.left),(event.clientY-rect.top)):null;
      const dragAllowedAtPointerDown=atomDragEnabled;
      if(interactionMode==='select'&&event.button===0){drag={kind:'select',x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,add:event.shiftKey||selectionOperation==='add',remove:event.altKey||selectionOperation==='remove',through:!!event.ctrlKey||selectionThrough};selectionBox.hidden=false;selectionBox.style.left=`${event.clientX-rect.left}px`;selectionBox.style.top=`${event.clientY-rect.top}px`;selectionBox.style.width='0px';selectionBox.style.height='0px';return;}
      if(hit){selected=hit.id;onSelect?.(hit.id);render();}
      if(hit&&dragAllowedAtPointerDown&&atomDragEnabled&&!event.altKey){
        drag={kind:'atom',id:hit.id,anchor:hit.position.slice(),x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,button:event.button};
        canvas.style.cursor='grabbing';return;
      }
      drag={kind:'camera',x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,moved:false,button:event.button};
    });
    canvas.addEventListener('pointermove',event=>{
      if(!drag){
        const rect=canvas.getBoundingClientRect(),hit=atomDragEnabled?pick(event.clientX-rect.left,event.clientY-rect.top):null;
        canvas.style.cursor=atomDragEnabled&&hit?'move':'grab';return;
      }
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;drag.moved||=Math.abs(event.clientX-drag.startX)+Math.abs(event.clientY-drag.startY)>3;
      if(drag.kind==='select'){const rect=canvas.getBoundingClientRect(),left=Math.min(drag.startX,event.clientX)-rect.left,top=Math.min(drag.startY,event.clientY)-rect.top;selectionBox.style.left=`${left}px`;selectionBox.style.top=`${top}px`;selectionBox.style.width=`${Math.abs(event.clientX-drag.startX)}px`;selectionBox.style.height=`${Math.abs(event.clientY-drag.startY)}px`;return;}
      if(drag.kind==='atom'){
        if(drag.moved){
          const delta=atomDragDelta(dx,dy,drag.anchor),atom=structure.atoms[drag.id];
          atom.position=atom.position.map((value,axis)=>value+delta[axis]);
          onAtomPreview?.(drag.id,atom.position.slice());
        }
        drag.x=event.clientX;drag.y=event.clientY;render();return;
      }
      if(drag.button===2){const distance=Math.max(...visible.map(atom=>norm(sub(atom.position,target))),1)*3;const amount=distance*.0017/zoom;pan=[pan[0]-dx*Math.cos(yaw)*amount,pan[1]+dy*amount,pan[2]+dx*Math.sin(yaw)*amount];}
      else {yaw+=dx*.008;pitch=Math.max(-1.45,Math.min(1.45,pitch+dy*.008));}
      drag.x=event.clientX;drag.y=event.clientY;render();
    });
    canvas.addEventListener('pointerup',event=>{
      if(!drag)return;const completed=drag;drag=null;canvas.style.cursor='grab';
      if(completed.kind==='select'){selectionBox.hidden=true;const rect=canvas.getBoundingClientRect();if(completed.moved)selectInRectangle({x0:completed.startX-rect.left,y0:completed.startY-rect.top,x1:event.clientX-rect.left,y1:event.clientY-rect.top},completed.add,completed.remove,completed.through);else{const hit=pick(completed.startX-rect.left,completed.startY-rect.top);const ids=hit?[hit.id]:[];if(!completed.add&&!completed.remove)selectedIds=new Set(ids);else if(completed.add&&hit)selectedIds.add(hit.id);else if(completed.remove&&hit)selectedIds.delete(hit.id);selected=selectedIds.size?Math.min(...selectedIds):-1;onSelection?.([...selectedIds].sort((a,b)=>a-b));render();}return;}
      if(completed.kind==='atom'&&completed.moved){onAtomMove?.(completed.id,structure.atoms[completed.id].position.slice());render();}
    });
    canvas.addEventListener('pointercancel',()=>{const completed=drag;drag=null;selectionBox.hidden=true;canvas.style.cursor='grab';if(completed?.kind==='atom'&&completed.moved)onAtomMove?.(completed.id,structure.atoms[completed.id].position.slice());render();});
    canvas.addEventListener('wheel',event=>{event.preventDefault();zoom=Math.max(.25,Math.min(5,zoom*Math.exp(-event.deltaY*.001)));render();},{passive:false});
    return {
      setFrame(value){
        if(Object.hasOwn(value,'structure'))structure=value.structure;
        if(Number.isInteger(value.selection)){selected=value.selection;if(!selectedIds.size&&selected>=0)selectedIds=new Set([selected]);}
        if(Array.isArray(value.selectionIds))selectedIds=new Set(value.selectionIds.filter(Number.isInteger));
        if(value.display)display={...display,...value.display};
        if(value.interactionMode)interactionMode=value.interactionMode;
        if(Object.hasOwn(value,'atomDragEnabled')){atomDragEnabled=!!value.atomDragEnabled;canvas.style.cursor='grab';}
        render();
      },
      setStructure(value){structure=value;render();},
      setSelection(atomId){selected=atomId;render();},
      setSelectionIds(atomIds){selectedIds=new Set(atomIds);selected=selectedIds.size?Math.min(...selectedIds):-1;render();},
      setInteractionMode(mode){if(['rotate','select','move'].includes(mode))interactionMode=mode;canvas.style.cursor=mode==='select'?'crosshair':'grab';},
      setSelectionOptions(value){selectionOperation=['replace','add','remove'].includes(value.operation)?value.operation:'replace';selectionThrough=!!value.through;},
      setDisplaySettings(value){display={...display,...value};render();},
      getRenderingCalibration(){return vestaBuilt&&root.PhononOriginalReference?root.PhononOriginalReference.snapshot(vestaBuilt.viewer,vestaBuilt.orthographicCamera&&projection==='orthographic'?vestaBuilt.orthographicCamera:vestaBuilt.camera,vestaCanvas):null;},
      setViewState(value){if(Number.isFinite(value.yaw))yaw=value.yaw;if(Number.isFinite(value.pitch))pitch=value.pitch;if(Number.isFinite(value.zoom))zoom=value.zoom;if(Array.isArray(value.pan))pan=value.pan.slice();render();},
      getViewState(){return {yaw,pitch,zoom,target:target.slice(),pan:pan.slice(),projection};},
      getDisplayStats(){return {atomInstances:visible.length,bonds:lastBondCount};},
      setAtomDragEnabled(value){atomDragEnabled=!!value;canvas.style.cursor='grab';},
      atomScreenPosition(atomId){const atom=visible.find(item=>item.id===atomId);if(!atom)return null;const point=project(atom.position),dpr=root.devicePixelRatio||1;return [point[0]/dpr,point[1]/dpr];},
      setZoom(value){if(Number.isFinite(value))zoom=Math.max(.25,Math.min(5,value));render();},
      fitCamera(){yaw=structure.equilibriumPositions?0:-.62;pitch=structure.equilibriumPositions?0:.35;zoom=1;pan=[0,0,0];target=[0,0,0];render();},
      setCameraAxis(axis){const vector=structure?.cell?.[axis]||[[1,0,0],[0,1,0],[0,0,1]][axis];if(!vector)return;const length=norm(vector);yaw=Math.atan2(vector[0],vector[2]);pitch=Math.asin(Math.max(-1,Math.min(1,vector[1]/length)));pan=[0,0,0];render();},
      setProjection(value){if(value==='perspective'||value==='orthographic')projection=value;render();},
          dispose(){disposeVestaObjects();compass.remove();selectionBox.remove();selectionOverlay.remove();vestaRenderer?.dispose?.();vestaCanvas?.remove();gl.getExtension('WEBGL_lose_context')?.loseContext();}
    };
  }
  root.CrystalViewer={create,atomAppearance,atomRadiusForModel,bondImageBounds,bondEdges,boundsOfPoints,clipBondToCell,makeCylinderMesh,displayInstances,displayBondSegments,displayBondSegmentsWithColors};
})(typeof globalThis==='object'?globalThis:this);
