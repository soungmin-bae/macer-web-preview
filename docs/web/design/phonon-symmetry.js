/* Client-side mapping helpers for symmetry operations returned by spglib/Moyo. */
(function (root) {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const matVec = (m, v) => [0, 1, 2].map(i => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
  const matMul = (a, b) => Array.from({length: 9}, (_, index) => {
    const row = Math.floor(index / 3), col = index % 3;
    return a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
  });
  const matrixRowsFromColumnMajor = values => [[values[0], values[3], values[6]], [values[1], values[4], values[7]], [values[2], values[5], values[8]]];
  const inverse3 = m => {
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (!finite(det) || Math.abs(det) < 1e-14) throw new Error('The primitive-cell transform is singular.');
    return [
      [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / det, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / det, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / det],
      [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / det, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / det, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / det],
      [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / det, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / det, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / det],
    ];
  };
  let moyoModulePromise = null;

  async function loadMoyo() {
    if (!moyoModulePromise) moyoModulePromise = (async () => {
      if (!root.location?.href) throw new Error('Moyo WASM can only be loaded from the browser app.');
      const url = new URL('./wasm-moyo/moyo_wasm_bg.wasm', root.location.href);
      if (root.location && url.origin !== root.location.origin) throw new Error('The symmetry engine must load from this app origin.');
      const module = await import('./wasm-moyo/moyo_wasm.js');
      await module.default();
      return module;
    })().catch(error => { moyoModulePromise = null; throw error; });
    return moyoModulePromise;
  }

  async function analyzeStructure(structure, options = {}) {
    if (!root.Structures) throw new Error('The local structure math module is unavailable.');
    if (!structure?.cell || !structure.atoms?.length || (structure.pbc && !structure.pbc.every(Boolean))) {
      throw new Error('Phonon symmetry analysis requires a periodic POSCAR or CIF structure.');
    }
    const tolerance = options.tolerance ?? 1e-5;
    if (!finite(tolerance) || tolerance <= 0) throw new Error('Symmetry tolerance must be positive.');
    const cell = {
      lattice: {basis: structure.cell.flat()},
      positions: structure.atoms.map(atom => root.Structures.fractional(atom.position, structure.cell)),
      numbers: structure.atoms.map(atom => root.Structures.atomicNumber(atom.element)),
    };
    const moyo = await loadMoyo();
    const dataset = moyo.analyze_cell(JSON.stringify(cell), tolerance, 'Standard');
    // Moyo's operation matrices are returned in the column-major convention
    // documented for its WASM API; convert them to the row-coordinate form
    // used by the browser structure representation.
    const mapping = mapOperations(structure, dataset.operations, {tolerance, rotationTransposed: true});
    const primitive = dataset.prim_std_cell;
    const basis = primitive?.lattice?.basis;
    if (!Array.isArray(basis) || basis.length !== 9 || !Array.isArray(primitive.positions) || !Array.isArray(primitive.numbers)) {
      throw new Error('The symmetry engine returned an incomplete primitive cell.');
    }
    const primitiveCell = [0, 1, 2].map(vector => basis.slice(vector * 3, vector * 3 + 3));
    const primitiveSites = mapPrimitiveSites(structure, dataset, primitiveCell, {tolerance});
    const primitiveStructure = {
      cell: primitiveCell,
      pbc: [true, true, true], format: 'moyo-primitive',
      atoms: primitive.positions.map((fractional, index) => ({
        element: root.Structures.elementSymbol(primitive.numbers[index]),
        fractional: fractional.map(value => ((value % 1) + 1) % 1),
        position: root.Structures.cartesian(fractional.map(value => ((value % 1) + 1) % 1), primitiveCell),
        mask: [true, true, true],
      })),
    };
    return {spaceGroupNumber: dataset.number, spaceGroupSymbol: dataset.hm_symbol, hallNumber: dataset.hall_number,
      inputAtoms: structure.atoms.length, primitiveAtoms: primitiveStructure.atoms.length,
      mapping, primitiveSites, primitiveStructure, dataset};
  }

  function mapPrimitiveSites(structure, dataset, primitiveCell, options = {}) {
    if (!root.Structures) throw new Error('The local structure math module is unavailable.');
    const tolerance = options.tolerance ?? 1e-5;
    const primitive = dataset?.prim_std_cell, linear = dataset?.prim_std_linear, origin = dataset?.prim_std_origin_shift, indices = dataset?.mapping_std_prim;
    if (!Array.isArray(linear) || linear.length !== 9 || !Array.isArray(origin) || origin.length !== 3 || !Array.isArray(indices) || indices.length !== structure.atoms.length || !Array.isArray(primitive?.positions) || !Array.isArray(primitive?.numbers)) {
      throw new Error('The symmetry engine returned incomplete input-to-primitive mapping data.');
    }
    const inverse = inverse3(matrixRowsFromColumnMajor(linear));
    let maxResidual = 0;
    const sites = structure.atoms.map((atom, atomIndex) => {
      const primitiveIndex = indices[atomIndex];
      if (!Number.isSafeInteger(primitiveIndex) || primitiveIndex < 0 || primitiveIndex >= primitive.positions.length || primitive.numbers[primitiveIndex] !== root.Structures.atomicNumber(atom.element)) {
        throw new Error(`Input atom ${atomIndex + 1} has an invalid primitive-site assignment.`);
      }
      const inputFractional = root.Structures.fractional(atom.position, structure.cell);
      const selected = inverse.map(row => row.reduce((sum, value, axis) => sum + value * (inputFractional[axis] - origin[axis]), 0));
      const delta = selected.map((value, axis) => value - primitive.positions[primitiveIndex][axis]);
      const image = delta.map(Math.round);
      const residualFractional = delta.map((value, axis) => value - image[axis]);
      const residualCartesian = root.Structures.cartesian(residualFractional, primitiveCell);
      const residual = Math.hypot(...residualCartesian);
      if (!finite(residual) || residual > tolerance) throw new Error(`Input atom ${atomIndex + 1} does not map to its primitive site within ${tolerance} Å (residual ${residual.toPrecision(5)} Å).`);
      maxResidual = Math.max(maxResidual, residual);
      return {inputAtom: atomIndex, primitiveAtom: primitiveIndex, image, primitiveFractional: selected, residualCartesianAngstrom: residual};
    });
    return {sites, maxCartesianResidual: maxResidual};
  }

  function nearestImageDistance(delta, cell) {
    const metric = cell.map(a => cell.map(b => a.reduce((sum, value, i) => sum + value * b[i], 0)));
    const l = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j <= i; j++) {
      let value = metric[i][j];
      for (let k = 0; k < j; k++) value -= l[i][k] * l[j][k];
      if (i === j) {
        if (!(value > 0) || !finite(value)) throw new Error('The periodic cell is singular or numerically unstable.');
        l[i][j] = Math.sqrt(value);
      } else l[i][j] = value / l[j][j];
    }
    const r = [[l[0][0],l[1][0],l[2][0]],[0,l[1][1],l[2][1]],[0,0,l[2][2]]];
    const squaredNorm = n => {
      const x = delta.map((v, i) => v - n[i]);
      return r.reduce((sum, row, i) => sum + row.slice(i).reduce((s, value, j) => s + value * x[i+j], 0) ** 2, 0);
    };
    const nearest = delta.map(Math.round);
    let bestSquared = squaredNorm(nearest), visited = 0;
    const candidate = nearest.slice();
    function search(axis, partial) {
      if (++visited > 100000) throw new Error('The periodic cell is too ill-conditioned for reliable symmetry mapping.');
      if (axis < 0) { bestSquared = Math.min(bestSquared, partial); return; }
      let shift = 0;
      for (let j = axis + 1; j < 3; j++) shift += r[axis][j] * (delta[j] - candidate[j]);
      const center = delta[axis] + shift / r[axis][axis];
      const remaining = Math.sqrt(Math.max(0, bestSquared - partial)) / Math.abs(r[axis][axis]);
      const low = Math.ceil(center - remaining), high = Math.floor(center + remaining);
      for (let n = low; n <= high; n++) {
        candidate[axis] = n;
        const term = r[axis][axis] * (delta[axis] - n) + shift;
        const next = partial + term * term;
        if (next <= bestSquared + 1e-24) search(axis - 1, next);
      }
    }
    search(2, 0);
    return Math.sqrt(bestSquared);
  }

  function mapOperations(structure, operations, options = {}) {
    if (!root.Structures) throw new Error('The local structure math module is unavailable.');
    if (!structure || !Array.isArray(structure.cell) || structure.cell.length !== 3 || !Array.isArray(structure.atoms) || !structure.atoms.length) {
      throw new Error('Symmetry mapping requires a periodic cell and at least one atom.');
    }
    if (Array.isArray(structure.pbc) && !structure.pbc.every(Boolean)) throw new Error('Symmetry mapping requires periodic boundary conditions in all directions.');
    const tolerance = options.tolerance ?? 1e-5, referenceAtom = options.referenceAtom ?? 0;
    if (!finite(tolerance) || tolerance <= 0) throw new Error('Symmetry tolerance must be a positive finite distance.');
    if (!Number.isSafeInteger(referenceAtom) || referenceAtom < 0 || referenceAtom >= structure.atoms.length) throw new Error('The reference atom index is outside the structure.');
    if (!Array.isArray(operations) || !operations.length) throw new Error('At least one symmetry operation is required.');
    const cell = structure.cell;
    const positions = structure.atoms.map(atom => root.Structures.fractional(atom.position, cell));
    const numbers = structure.atoms.map(atom => atom.element);
    const forward = [], rotationsCartesian = [], siteInverse = [], siteRotations = [];
    let maxResidual = 0;
    operations.forEach((operation, operationIndex) => {
      let rotation = operation?.rotation;
      if (Array.isArray(rotation) && rotation.length === 3 && rotation.every(Array.isArray)) rotation = rotation.flat();
      if (!Array.isArray(rotation) || rotation.length !== 9 || !rotation.every(value => Number.isSafeInteger(value))) throw new Error(`Symmetry operation ${operationIndex + 1} has an invalid integer rotation.`);
      if (options.rotationTransposed) rotation = [rotation[0], rotation[3], rotation[6], rotation[1], rotation[4], rotation[7], rotation[2], rotation[5], rotation[8]];
      const translation = operation.translation;
      if (!Array.isArray(translation) || translation.length !== 3 || !translation.every(finite)) throw new Error(`Symmetry operation ${operationIndex + 1} has an invalid translation.`);
      const mapping = new Array(numbers.length), occupied = new Set();
      for (let source = 0; source < numbers.length; source++) {
        const transformed = matVec(rotation, positions[source]).map((v, axis) => v + translation[axis]);
        let best = Infinity, targetIndex = -1, ambiguous = false;
        for (let target = 0; target < numbers.length; target++) {
          if (numbers[target] !== numbers[source]) continue;
          const distance = nearestImageDistance(transformed.map((v, i) => v - positions[target][i]), cell);
          if (distance < best - Math.max(1e-12, tolerance * 1e-6)) { best = distance; targetIndex = target; ambiguous = false; }
          else if (Math.abs(distance - best) <= Math.max(1e-12, tolerance * 1e-6)) ambiguous = true;
        }
        if (targetIndex < 0 || best > tolerance) throw new Error(`Symmetry operation ${operationIndex + 1} does not map atom ${source + 1} within ${tolerance} Å (residual ${best.toPrecision(5)} Å).`);
        if (ambiguous || occupied.has(targetIndex)) throw new Error(`Symmetry operation ${operationIndex + 1} produces an ambiguous atom map near atom ${targetIndex + 1}.`);
        mapping[source] = targetIndex; occupied.add(targetIndex); maxResidual = Math.max(maxResidual, best);
      }
      if (occupied.size !== numbers.length) throw new Error(`Symmetry operation ${operationIndex + 1} is not a bijection on the input atoms.`);
      const latticeColumns = cell[0].map((_, col) => cell.map(row => row[col])).flat();
      const inverseRows = [
        ...root.Structures.fractional([1, 0, 0], cell),
        ...root.Structures.fractional([0, 1, 0], cell),
        ...root.Structures.fractional([0, 0, 1], cell),
      ];
      const inverseColumns = [inverseRows[0], inverseRows[3], inverseRows[6], inverseRows[1], inverseRows[4], inverseRows[7], inverseRows[2], inverseRows[5], inverseRows[8]];
      const cartRotation = matMul(matMul(latticeColumns, rotation), inverseColumns);
      if (!cartRotation.every(finite)) throw new Error(`Symmetry operation ${operationIndex + 1} produced a non-finite Cartesian rotation.`);
      const orthogonalityError = Math.max(...Array.from({length: 3}, (_, i) => Math.max(...Array.from({length: 3}, (_, j) => {
        let value = 0; for (let k = 0; k < 3; k++) value += cartRotation[k * 3 + i] * cartRotation[k * 3 + j];
        return Math.abs(value - (i === j ? 1 : 0));
      }))));
      const determinant = cartRotation[0] * (cartRotation[4] * cartRotation[8] - cartRotation[5] * cartRotation[7])
        - cartRotation[1] * (cartRotation[3] * cartRotation[8] - cartRotation[5] * cartRotation[6])
        + cartRotation[2] * (cartRotation[3] * cartRotation[7] - cartRotation[4] * cartRotation[6]);
      if (orthogonalityError > 1e-6 || Math.abs(Math.abs(determinant) - 1) > 1e-6) throw new Error(`Symmetry operation ${operationIndex + 1} does not preserve Cartesian lengths.`);
      forward.push(mapping); rotationsCartesian.push(cartRotation);
      if (mapping[referenceAtom] === referenceAtom) {
        const inverse = new Array(numbers.length);
        mapping.forEach((target, source) => { inverse[target] = source; });
        siteInverse.push(inverse); siteRotations.push(cartRotation);
      }
    });
    if (!siteInverse.length) throw new Error('The operations contain no site symmetry for the selected reference atom.');
    return {
      atomCount: numbers.length,
      operationCount: operations.length,
      referenceAtom,
      siteSymmetryOrder: siteInverse.length,
      maxCartesianResidual: maxResidual,
      forwardAtomPermutations: forward,
      rotationsCartesian,
      siteInverseAtomPermutations: siteInverse,
      siteRotationsCartesian: siteRotations,
    };
  }

  root.PhononSymmetry = {mapOperations, mapPrimitiveSites, nearestImageDistance, analyzeStructure, loadMoyo};
  if (typeof module === 'object' && module.exports) module.exports = root.PhononSymmetry;
})(typeof globalThis === 'object' ? globalThis : this);
