/* Portable structure parsing/serialization. No DOM, model or network access. */
(function (root) {
  'use strict';
  const symbols = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' ');
  const fail = (line, message) => { throw Object.assign(new Error(message), { line }); };
  const tokens = s => s.trim().split(/\s+/).filter(Boolean);
  const dot = (a,b) => a.reduce((s,v,i)=>s+v*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const determinant = a => dot(a[0],cross(a[1],a[2]));
  const cartesian = (f,a) => [0,1,2].map(j=>dot(f,a.map(row=>row[j])));
  const fractional = (r,a) => {
    const d=determinant(a);
    return [dot(r,cross(a[1],a[2]))/d,dot(r,cross(a[2],a[0]))/d,dot(r,cross(a[0],a[1]))/d];
  };
  function number(token,line) {
    const v=String(token||'').replace(/[dD]/g,'e');
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) || !Number.isFinite(Number(v))) fail(line,'Enter a complete finite number.');
    return Number(v);
  }
  function vector(line,index) {
    const p=tokens(line||'');
    if(p.length!==3)fail(index,'Each lattice vector requires three numbers.');
    return p.map(v=>number(v,index));
  }
  function checkCount(n,line) {
    if(!Number.isSafeInteger(n)||n<1)fail(line,'Atom count must be a positive integer.');
    if(n>2000)fail(line,'The structure viewer supports up to 2,000 atoms.');
  }
  function tail(lines,start) {
    const extra=lines.findIndex((s,i)=>i>=start&&s.trim());
    if(extra>=0)fail(extra+1,'Unexpected content follows the declared atom positions. Check for extra coordinates or a velocity block; velocity blocks are not supported.');
  }
  function parsePoscar(text) {
    const lines=text.replace(/\r/g,'').split('\n');
    if(lines.length<8)fail(lines.length,'Enter the POSCAR lattice, elements, counts, and coordinate mode.');
    const scale=tokens(lines[1]);
    if(![1,3].includes(scale.length))fail(2,'Scale must be one number or three positive numbers.');
    let factors=scale.map(s=>number(s,2));
    const raw=[2,3,4].map(i=>vector(lines[i],i+1));
    if(Math.abs(determinant(raw))<1e-12)fail(3,'Lattice vectors are linearly dependent; cell volume must be nonzero.');
    if(factors.length===1){
      const s=factors[0];if(s===0)fail(2,'Scale cannot be zero.');
      const f=s<0?Math.cbrt(-s/Math.abs(determinant(raw))):s;factors=[f,f,f];
    }else if(factors.some(v=>v<=0))fail(2,'All three scale values must be positive.');
    const cell=raw.map(row=>row.map((v,j)=>v*factors[j]));
    const vol=Math.abs(determinant(cell));
    if(!Number.isFinite(vol)||vol<1e-12||cell.flat().some(v=>!Number.isFinite(v)))fail(3,'Cell volume must be finite and nonzero.');
    const species=tokens(lines[5]);
    if(!species.length||species.some(s=>!symbols.includes(s)))fail(6,'Enter an element-symbol row (for example, Si O). VASP4 files without element symbols are not inferred automatically.');
    const counts=tokens(lines[6]);
    if(counts.length!==species.length||counts.some(s=>!/^\d+$/.test(s)))fail(7,'Enter one atom count for each element.');
    const ns=counts.map(Number),n=ns.reduce((s,v)=>s+v,0);checkCount(n,7);
    if(ns.some(v=>!Number.isSafeInteger(v)))fail(7,'Atom count is too large.');
    let row=7,selective=false;
    if(/^s/i.test((lines[row]||'').trim())){selective=true;row++;}
    const mode=(lines[row]||'').trim();
    if(!/^(direct|cartesian|k[a-z]*)\s*$/i.test(mode))fail(row+1,'Choose Direct or Cartesian coordinates.');
    const direct=/^d/i.test(mode);row++;
    const actual=lines.slice(row).filter(s=>s.trim()).length;
    if(actual<n)fail(Math.min(lines.length,row+actual+1),`${n} atoms are declared, but only ${actual} coordinate lines were found. Enter the remaining positions.`);
    if(actual>n && /^[+\-.\d]/.test((lines[row+n]||'').trim()))fail(row+n+1,`${n} atoms are declared, but ${actual} coordinate lines were found. Correct the atom count or coordinate lines.`);
    const elements=species.flatMap((s,i)=>Array(ns[i]).fill(s));
    const atoms=elements.map((element,i)=>{
      const line=row+i+1,p=tokens(lines[row+i]||'');
      if(p.length<3)fail(line,`Atom ${i+1} requires three coordinates.`);
      const xyz=p.slice(0,3).map(v=>number(v,line));
      let mask=[true,true,true];
      if(selective){if(p.length<6||p.slice(3,6).some(v=>! /^[tTfF]$/.test(v)))fail(line,'Selective dynamics requires three T/F flags after each coordinate.');mask=p.slice(3,6).map(v=>/^t$/i.test(v));}
      const position=direct?cartesian(xyz,cell):xyz.map((v,j)=>v*factors[j]);
      if(position.some(v=>!Number.isFinite(v)))fail(line,'Converted coordinates must be finite.');
      return {element,position,mask,line};
    });
    tail(lines,row+n);
    return {comment:lines[0],cell,pbc:[true,true,true],atoms,selective,format:'poscar'};
  }
  function parseXyz(text) {
    const lines=text.replace(/\r/g,'').split('\n');
    if(!/^\d+$/.test((lines[0]||'').trim()))fail(1,'Enter the atom count on the first XYZ line.');
    const n=Number(lines[0]);checkCount(n,1);
    if(/\b(?:Lattice|Properties|pbc)\s*=/.test(lines[1]||''))fail(2,'Extended XYZ metadata is not supported. Standard XYZ is treated as nonperiodic.');
    const atoms=Array.from({length:n},(_,i)=>{
      const line=i+3,p=tokens(lines[i+2]||'');
      if(p.length!==4||!symbols.includes(p[0]))fail(line,`XYZ atom ${i+1} requires one line in the form "Element x y z".`);
      return {element:p[0],position:p.slice(1).map(v=>number(v,line)),mask:[true,true,true],line};
    });
    tail(lines,n+2);
    return {comment:lines[1]||'',cell:null,pbc:[false,false,false],atoms,selective:false,format:'xyz'};
  }
  function cifTokens(text) {
    const lines=text.replace(/\r/g,'').split('\n'),out=[];
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(line.startsWith(';')){
        const block=[];let closed=false;
        for(i++;i<lines.length;i++){if(lines[i].startsWith(';')){closed=true;break;}block.push(lines[i]);}
        if(!closed)fail(i+1,'CIF multiline string is not closed.');out.push(block.join('\n'));continue;
      }
      let j=0;
      while(j<line.length){
        while(j<line.length&&/\s/.test(line[j]))j++;
        if(j>=line.length||line[j]==='#')break;
        if(line[j]==='\''||line[j]==='"'){
          const quote=line[j++];let token='';
          while(j<line.length&&line[j]!==quote)token+=line[j++];
          if(j>=line.length)fail(i+1,'CIF quoted string is not closed.');j++;out.push(token);
        }else{
          const start=j;while(j<line.length&&!/\s/.test(line[j])&&line[j]!=='#')j++;
          out.push(line.slice(start,j));if(line[j]==='#')break;
        }
      }
    }
    return out;
  }
  function cifNumber(value,line) {
    const s=String(value).trim().replace(/[dD]/g,'e');
    if(s==='?'||s==='.')fail(line,'A required CIF cell or coordinate value is missing.');
    const match=s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:\(\d+\))?$/);
    if(!match||!Number.isFinite(Number(match[1])))fail(line,'CIF values must be finite numbers.');
    return Number(match[1]);
  }
  function cifOperations(tokens) {
    const result=[];
    for(let i=0;i<tokens.length;i++){
      if(tokens[i].toLowerCase()!=='loop_')continue;
      let j=i+1;const headers=[];
      while(j<tokens.length&&tokens[j].startsWith('_'))headers.push(tokens[j++].toLowerCase());
      const operationNames=['_space_group_symop_operation_xyz','_space_group_symop.operation_xyz','_symmetry_equiv_pos_as_xyz','_symmetry_equiv.pos_as_xyz'];
      if(headers.some(h=>operationNames.includes(h))){
        const col=headers.findIndex(h=>operationNames.includes(h));
        while(j<tokens.length&&!tokens[j].startsWith('_')&&!/^(loop_|data_|save_|stop_)$/i.test(tokens[j])){
          const row=tokens.slice(j,j+headers.length);if(row.length<headers.length)break;
          result.push(parseSymmetryOperation(row[col]));j+=headers.length;
        }
      }
    }
    return result;
  }
  function parseSymmetryOperation(value) {
    const parts=String(value).replace(/[ '\"]/g,'').toLowerCase().split(',');
    if(parts.length!==3)throw new Error('CIF symmetry operations must use the x,y,z form.');
    return parts.map(part=>{
      const expression=part.replace(/-/g,'+-').split('+').filter(Boolean);let coeff=[0,0,0],offset=0;
      for(let term of expression){let sign=1;if(term[0]==='-'){sign=-1;term=term.slice(1);}if(!term)continue;
        const axis='xyz'.indexOf(term.at(-1));
        if(axis>=0){let prefix=term.slice(0,-1).replace('*','');const factor=prefix?Number(prefix):1;if(!Number.isFinite(factor))throw new Error('Could not parse a CIF symmetry coefficient.');coeff[axis]+=sign*factor;}
        else{const ratio=term.match(/^([+-]?\d+)\/(\d+)$/);const numeric=ratio?Number(ratio[1])/Number(ratio[2]):Number(term);if(!Number.isFinite(numeric))throw new Error('Could not parse a CIF symmetry translation.');offset+=sign*numeric;}
      }
      return [...coeff,offset];
    });
  }
  function parseCif(text) {
    const ts=cifTokens(text);if(!ts.length)fail(1,'CIF file is empty.');
    const scalar=new Map(),loops=[];
    let dataBlocks=0;
    for(let i=0;i<ts.length;){
      if(/^data_/i.test(ts[i])){if(++dataBlocks>1)fail(1,'Multiple CIF data blocks are not supported. Save each structure to a separate file.');i++;continue;}
      if(ts[i].toLowerCase()==='loop_'){
        let j=i+1;const headers=[];while(j<ts.length&&ts[j].startsWith('_'))headers.push(ts[j++].toLowerCase());
        if(!headers.length)fail(1,'CIF loop has no column names.');
        const rows=[];while(j<ts.length&&!ts[j].startsWith('_')&&!/^(loop_|data_|save_|stop_)$/i.test(ts[j])){
          if(j+headers.length>ts.length)fail(1,'The final row in a CIF loop is incomplete.');
          rows.push(ts.slice(j,j+headers.length));j+=headers.length;
        }
        loops.push({headers,rows});i=j;continue;
      }
      if(ts[i].startsWith('_')){if(i+1>=ts.length)fail(1,'CIF item has no value.');scalar.set(ts[i].toLowerCase(),ts[i+1]);i+=2;continue;}
      i++;
    }
    if(dataBlocks!==1)fail(1,'CIF must contain exactly one structure block beginning with data_.');
    const get=(...names)=>{for(const n of names){const v=scalar.get(n);if(v!==undefined)return v;}return undefined;};
    const names=[['_cell_length_a','_cell.length_a'],['_cell_length_b','_cell.length_b'],['_cell_length_c','_cell.length_c'],['_cell_angle_alpha','_cell.angle_alpha'],['_cell_angle_beta','_cell.angle_beta'],['_cell_angle_gamma','_cell.angle_gamma']];
    const raw=names.map(aliases=>aliases.map(name=>scalar.get(name)).find(v=>v!==undefined));if(raw.some(v=>v===undefined))fail(1,'CIF requires all three cell lengths and cell angles.');
    const [a,b,c,alpha,beta,gamma]=raw.map(v=>cifNumber(v,1));
    if(Math.min(a,b,c)<=0||Math.min(alpha,beta,gamma)<=0||Math.max(alpha,beta,gamma)>=180)fail(1,'Check the CIF cell lengths and angles.');
    const rad=x=>x*Math.PI/180,ca=Math.cos(rad(alpha)),cb=Math.cos(rad(beta)),cg=Math.cos(rad(gamma)),sg=Math.sin(rad(gamma));
    if(Math.abs(sg)<1e-10)fail(1,'CIF cell angles do not define a valid lattice.');
    const cy=c*(ca-cb*cg)/sg,cz2=c*c-c*c*cb*cb-cy*cy;
    if(cz2<=1e-12)fail(1,'CIF cell volume is zero or invalid.');
    const cell=[[a,0,0],[b*cg,b*sg,0],[c*cb,cy,Math.sqrt(cz2)]];
    const atomLoop=loops.find(loop=>loop.headers.some(h=>['_atom_site_fract_x','_atom_site.fract_x','_atom_site_cartn_x','_atom_site.cartn_x'].includes(h))&&loop.headers.some(h=>['_atom_site_type_symbol','_atom_site.type_symbol','_atom_site_label','_atom_site.label'].includes(h)));
    if(!atomLoop||!atomLoop.rows.length)fail(1,'Could not find a CIF atom_site loop.');
    const column=(...candidates)=>atomLoop.headers.findIndex(h=>candidates.includes(h));
    const fractionalColumns=[column('_atom_site_fract_x','_atom_site.fract_x'),column('_atom_site_fract_y','_atom_site.fract_y'),column('_atom_site_fract_z','_atom_site.fract_z')];
    const cartesianColumns=[column('_atom_site_cartn_x','_atom_site.cartn_x'),column('_atom_site_cartn_y','_atom_site.cartn_y'),column('_atom_site_cartn_z','_atom_site.cartn_z')];
    const frac=fractionalColumns.every(i=>i>=0),hasCartesian=cartesianColumns.every(i=>i>=0);
    if(!frac&&!hasCartesian)fail(1,'CIF atom_site requires all fract_x/y/z or Cartn_x/y/z coordinate columns.');
    const [ix,iy,iz]=frac?fractionalColumns:cartesianColumns;
    const it=column('_atom_site_type_symbol','_atom_site.type_symbol'),il=column('_atom_site_label','_atom_site.label'),io=column('_atom_site_occupancy','_atom_site.occupancy');
    const operations=cifOperations(ts);if(!operations.length){
      const group=get('_space_group_it_number','_space_group.it_number','_symmetry_int_tables_number','_symmetry.int_tables_number'),symbol=get('_space_group_name_h-m_alt','_space_group.name_h-m_alt','_symmetry_space_group_name_h-m','_symmetry.space_group_name_h-m');
      if((group&&group!=='1')||(symbol&&!/^P\s*1$/i.test(symbol)))fail(1,'CIF symmetry operations are required to expand asymmetric atoms into a complete cell.');
      operations.push([[1,0,0,0],[0,1,0,0],[0,0,1,0]]);
    }
    const atoms=[];
    for(let rowIndex=0;rowIndex<atomLoop.rows.length;rowIndex++){
      const row=atomLoop.rows[rowIndex],line=rowIndex+1,symbol=it>=0?row[it]:row[il].replace(/[0-9].*$/,'');
      const element=symbol.match(/^[A-Z][a-z]?/)?.[0];if(!symbols.includes(element))fail(line,`Could not parse CIF element symbol: ${symbol}`);
      if(io>=0){const occupancy=cifNumber(row[io],line);if(Math.abs(occupancy-1)>1e-8)fail(line,`Partial occupancy (${occupancy}) is unsupported because atom ordering would be ambiguous.`);}
      let position=[ix,iy,iz].map(i=>cifNumber(row[i],line));if(!frac)position=fractional(position,cell);
      for(const op of operations){const f=op.map(eq=>eq[0]*position[0]+eq[1]*position[1]+eq[2]*position[2]+eq[3]).map(v=>((v%1)+1)%1);
        if(atoms.some(atom=>atom.element===element&&Math.hypot(...fractional(atom.position.map((v,j)=>v),cell).map((v,j)=>{let d=v-f[j];return d-Math.round(d);} ))<1e-6))continue;
        atoms.push({element,position:cartesian(f,cell),mask:[true,true,true],line});
      }
    }
    checkCount(atoms.length,1);
    return {comment:get('_chemical_formula_sum')||'CIF structure',cell,pbc:[true,true,true],atoms,selective:false,format:'cif'};
  }
  const parse=(text,format='poscar')=>{
    return format==='cif'?parseCif(text):format==='xyz'?parseXyz(text):parsePoscar(text);
  };
  const lengths=s=>s.cell?s.cell.map(v=>Math.hypot(...v)):null;
  function groups(s) {
    // Only group adjacent equal elements; preserve the input atom order.
    const names=[],counts=[];
    s.atoms.forEach(a=>{if(names.at(-1)!==a.element){names.push(a.element);counts.push(1);}else counts[counts.length-1]++;});
    return [names,counts];
  }
  const decimal=v=>v.toFixed(12);
  function toPoscar(s,comment=s.comment) {
    if(!s.cell)throw new Error('POSCAR requires a physical cell. Nonperiodic XYZ is not converted to a periodic structure automatically.');
    const [names,counts]=groups(s);
    return [comment||'Structure','1.0',...s.cell.map(r=>r.map(decimal).join(' ')),names.join(' '),counts.join(' '),...(s.selective?['Selective dynamics']:[]),'Direct',...s.atoms.map(a=>fractional(a.position,s.cell).map(decimal).join(' ')+(s.selective?' '+a.mask.map(v=>v?'T':'F').join(' '):''))].join('\n')+'\n';
  }
  function toXyz(s,comment=s.comment) {
    return [String(s.atoms.length),comment||'Structure',...s.atoms.map(a=>a.element+' '+a.position.map(decimal).join(' '))].join('\n')+'\n';
  }
  function toCif(s,comment='browser structure') {
    if(!s.cell)throw new Error('CIF export requires a cell. Choose a cell conversion policy first.');
    const l=lengths(s),angle=(a,b)=>Math.atan2(Math.hypot(...cross(a,b)),dot(a,b))*180/Math.PI;
    return ['data_browser_structure',`# ${comment.replace(/[\r\n]/g,' ')}`,...l.map((v,i)=>`_cell_length_${'abc'[i]} ${decimal(v)}`),`_cell_angle_alpha ${decimal(angle(s.cell[1],s.cell[2]))}`,`_cell_angle_beta ${decimal(angle(s.cell[0],s.cell[2]))}`,`_cell_angle_gamma ${decimal(angle(s.cell[0],s.cell[1]))}`,"_space_group_name_H-M_alt 'P 1'",'_space_group_IT_number 1','loop_','_space_group_symop_operation_xyz',"'x,y,z'",'loop_','_atom_site_label','_atom_site_type_symbol','_atom_site_fract_x','_atom_site_fract_y','_atom_site_fract_z','_atom_site_occupancy',...s.atoms.map((a,i)=>`${a.element}${i+1} ${a.element} ${fractional(a.position,s.cell).map(decimal).join(' ')} 1`)].join('\n')+'\n';
  }
  const api={parse,parsePoscar,parseXyz,parseCif,cartesian,fractional,determinant,lengths,toPoscar,toCif,toXyz,
    elementSymbol:z=>symbols[z-1],atomicNumber:s=>symbols.indexOf(s)+1};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.Structures=api;
})(typeof globalThis==='object'?globalThis:this);
