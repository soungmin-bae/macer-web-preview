/* Display-only geometry/symmetry metadata; no coordinates are modified. */
(function(root){
'use strict';
function spaceGroup(number,symbol){const n=Number(number);if(!Number.isInteger(n)||n<1||n>230)return 'Unknown';const s=symbol||root.SpaceGroupData?.[n]?.[0];return (s?s.replace(/_(\d)/g,(_,d)=>'₀₁₂₃₄₅₆₇₈₉'[Number(d)])+' · ':'')+'No. '+n;}
function geometry(s){
 const periodic=!!s.cell&&!!s.pbc?.every(Boolean);
 const counts=root.Structures.elementCounts(s.atoms);
 const options={sort:periodic,subscripts:true};
 const formula=root.Structures.formatComposition(counts,options);
 const reduced=periodic?root.Structures.formatComposition(counts,{...options,reduce:true}):formula;
 const result={formula,reduced,atoms:s.atoms.length,periodic};
 if(!s.cell)return result;
 const length=s.cell.map(v=>Math.hypot(...v));
 const angle=(i,j)=>Math.acos(Math.max(-1,Math.min(1,s.cell[i].reduce((sum,x,k)=>sum+x*s.cell[j][k],0)/(length[i]*length[j]))))*180/Math.PI;
 return {...result,lengths:length,angles:[angle(1,2),angle(0,2),angle(0,1)],volume:Math.abs(root.Structures.determinant(s.cell))};
}
function analyze(s,moyo,tolerance=1e-4){
 if(!s?.cell||!s.pbc?.every(Boolean))throw Error('A 3D-periodic structure is required for space-group analysis.');
 // Deliberately omit operation maps, idealization and force constraints.
 const input={lattice:{basis:s.cell.flat()},positions:s.atoms.map(a=>root.Structures.fractional(a.position,s.cell)),numbers:s.atoms.map(a=>root.Structures.atomicNumber(a.element))};
 const d=moyo.analyze_cell(JSON.stringify(input),tolerance,'Standard'),type=moyo.space_group_type(d.number);
 return {number:d.number,symbol:d.hm_symbol,pointGroup:type.geometric_crystal_class,crystalSystem:type.crystal_system,primitiveAtoms:d.prim_std_cell.numbers.length,tolerance};
}
root.StructureInfoCore=Object.freeze({spaceGroup,geometry,analyze});if(typeof module!=='undefined')module.exports=root.StructureInfoCore;
})(globalThis);
