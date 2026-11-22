/* Deterministic diagonal-supercell mapping and neutral vacancy-site generation. */
(function (root) {
  'use strict';

  const finite = Number.isFinite;
  const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  function fail(message) { throw new Error(message); }
  function matrix3(value, name) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(row => !Array.isArray(row) || row.length !== 3 || row.some(x => !finite(x)))) fail(`${name} must be a finite 3 × 3 matrix.`);
    return value.map(row => row.slice());
  }
  function vector3(value, name, integer = false) {
    if (!Array.isArray(value) || value.length !== 3 || value.some(x => !finite(x) || (integer && !Number.isSafeInteger(x)))) fail(`${name} must contain three ${integer ? 'integers' : 'finite numbers'}.`);
    return value.slice();
  }
  function structureForMapping(input) {
    const structures = root.Structures;
    if (!structures) fail('The local structure math module is unavailable.');
    if (!input || !Array.isArray(input.cell) || input.cell.length !== 3 || !Array.isArray(input.atoms) || !input.atoms.length) fail('A periodic host structure with a nonempty atom list is required.');
    if (input.pbc && (!Array.isArray(input.pbc) || input.pbc.length !== 3 || !input.pbc.every(Boolean))) fail('Neutral vacancy generation requires periodic boundary conditions in all directions.');
    const cell = matrix3(input.cell, 'Host cell');
    const volume = Math.abs(structures.determinant(cell));
    if (!finite(volume) || volume <= 1e-10) fail('Host cell volume must be positive and finite.');
    const atoms = input.atoms.map((atom, index) => {
      if (!atom || typeof atom.element !== 'string' || !atom.element.trim()) fail(`Host atom ${index + 1} has no element symbol.`);
      const position = vector3(atom.position, `Host atom ${index + 1} Cartesian position`);
      const fractional = structures.fractional(position, cell);
      if (!fractional.every(finite)) fail(`Host atom ${index + 1} has an invalid fractional coordinate.`);
      return { ...atom, position, fractional: fractional.map(x => mod(x, 1)), hostAtomIndex: index };
    });
    return { ...input, cell, pbc: [true, true, true], atoms };
  }
  function matrixForRepeats(repeats) {
    const r = vector3(repeats, 'Diagonal repeat', true);
    if (r.some(x => x < 1 || x > 32)) fail('Each diagonal repeat must be an integer from 1 to 32.');
    return [0, 1, 2].map(i => [0, 1, 2].map(j => i === j ? r[i] : 0));
  }
  function hashString(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
  function identityForHost(host) {
    const material = JSON.stringify({ cell: host.cell.map(row => row.map(x => Number(x.toPrecision(12)))), atoms: host.atoms.map(atom => [atom.element, ...atom.fractional.map(x => Number(x.toPrecision(12)))]) });
    return `host-${hashString(material)}`;
  }
  function buildSupercell(input, repeats, options = {}) {
    const host = structureForMapping(input), matrix = matrixForRepeats(repeats);
    const lattice = root.PhononSupercellLattice;
    if (!lattice) fail('The integer supercell lattice module is unavailable.');
    const determinant = repeats.reduce((product, value) => product * value, 1);
    const maxAtoms = options.maxAtoms ?? 4096;
    if (!Number.isSafeInteger(maxAtoms) || maxAtoms < 1 || host.atoms.length * determinant > maxAtoms) fail(`The requested calculation supercell exceeds the ${maxAtoms}-atom mapping limit.`);
    const quotient = lattice.translationRepresentatives(matrix, { maxDeterminant: options.maxDeterminant ?? 512 });
    if (quotient.determinant !== determinant) fail('Diagonal repeat count does not match the integer supercell determinant.');
    const cell = lattice.cellForMatrix(matrix, host.cell);
    const hostId = input.hostId || input.id || identityForHost(host);
    const cosets = quotient.translations.map((translation, index) => ({
      cosetIndex: index,
      translation: translation.slice(),
      key: quotient.keyByTranslation(translation),
      fractionalOrigin: quotient.fractionalCoordinates[index].slice(),
    }));
    const atoms = [];
    for (const coset of cosets) {
      for (const hostAtom of host.atoms) {
        const primitiveFractional = hostAtom.fractional.map((x, axis) => x + coset.translation[axis]);
        const fractional = lattice.supercellFractional(primitiveFractional, matrix);
        const hostSiteId = hostAtom.hostSiteId || `${hostId}:site:${hostAtom.hostAtomIndex}:${hostAtom.element}`;
        atoms.push({
          ...hostAtom,
          id: `${hostSiteId}@${coset.key}`,
          hostSiteId,
          hostAtomIndex: hostAtom.hostAtomIndex,
          cosetIndex: coset.cosetIndex,
          cosetKey: coset.key,
          primitiveTranslation: coset.translation.slice(),
          primitiveFractional,
          fractional,
          position: root.Structures.cartesian(fractional, cell),
        });
      }
    }
    const expectedAtomCount = host.atoms.length * determinant;
    if (atoms.length !== expectedAtomCount) fail(`Supercell atom count mismatch (${atoms.length}/${expectedAtomCount}).`);
    const hostSpecies = countSpecies(host.atoms), supercellSpecies = countSpecies(atoms);
    for (const [element, count] of hostSpecies) if (supercellSpecies.get(element) !== count * determinant) fail(`Supercell species count mismatch for ${element}.`);
    const volumeRatio = Math.abs(root.Structures.determinant(cell)) / Math.abs(root.Structures.determinant(host.cell));
    if (Math.abs(volumeRatio - determinant) > 1e-9 * Math.max(1, determinant)) fail(`Supercell volume ratio ${volumeRatio} does not equal |det S|=${determinant}.`);
    const atomIndex = new Map(atoms.map((atom, index) => [atom.id, index]));
    if (atomIndex.size !== atoms.length) fail('Generated supercell site IDs are not unique.');
    const supercell = {
      schema: 'macer-neutral-defect-supercell-v1',
      hostId,
      hostStructure: { ...host, atoms: host.atoms.map(({ hostAtomIndex, fractional, ...atom }) => ({ ...atom })) },
      matrix,
      determinant,
      repeats: repeats.slice(),
      cell,
      pbc: [true, true, true],
      atoms,
      cosets,
      hostAtomCount: host.atoms.length,
      atomCount: atoms.length,
      volumeRatio,
      speciesCounts: Object.fromEntries(supercellSpecies),
      mappingKind: 'diagonal-repeats',
      relaxationSymmetry: { preserveHostSymmetry: false, policy: 'P1/unconstrained; host symmetry is used only to group vacancy sites' },
    };
    supercell.mapHostImage = (hostAtomIndex, primitiveTranslation) => mapHostImage(supercell, hostAtomIndex, primitiveTranslation);
    supercell.inversePeriodicMap = (supercellSiteId, supercellImage = [0, 0, 0]) => inversePeriodicMap(supercell, supercellSiteId, supercellImage);
    return supercell;
  }
  function countSpecies(atoms) {
    const counts = new Map();
    for (const atom of atoms) counts.set(atom.element, (counts.get(atom.element) || 0) + 1);
    return counts;
  }
  function mapHostImage(supercell, hostAtomIndex, primitiveTranslation) {
    if (!Number.isSafeInteger(hostAtomIndex) || hostAtomIndex < 0 || hostAtomIndex >= supercell.hostAtomCount) fail('Host atom index is outside the input structure.');
    const translation = vector3(primitiveTranslation, 'Primitive translation', true);
    const repeat = supercell.repeats;
    const representative = translation.map((value, axis) => mod(value, repeat[axis]));
    const image = translation.map((value, axis) => (value - representative[axis]) / repeat[axis]);
    const coset = supercell.cosets.find(item => item.translation.every((x, axis) => x === representative[axis]))?.cosetIndex;
    if (coset == null) fail('Primitive translation could not be mapped to a supercell coset.');
    const atom = supercell.atoms.find(item => item.hostAtomIndex === hostAtomIndex && item.cosetIndex === coset);
    if (!atom) fail('Host-to-supercell atom mapping is incomplete.');
    return { hostAtomIndex, hostSiteId: atom.hostSiteId, primitiveTranslation: translation, representativeTranslation: representative, supercellImage: image, supercellSiteId: atom.id, supercellAtomIndex: supercell.atoms.indexOf(atom) };
  }
  function inversePeriodicMap(supercell, supercellSiteId, supercellImage) {
    const atom = supercell.atoms.find(item => item.id === supercellSiteId);
    if (!atom) fail(`Unknown supercell site ID: ${supercellSiteId}`);
    const image = vector3(supercellImage, 'Supercell image', true);
    const primitiveTranslation = atom.primitiveTranslation.map((value, axis) => value + image[axis] * supercell.repeats[axis]);
    return { hostAtomIndex: atom.hostAtomIndex, hostSiteId: atom.hostSiteId, supercellSiteId: atom.id, primitiveTranslation, supercellImage: image };
  }
  function normalizeOperation(raw, rotationTransposed = false) {
    let rotation = raw?.rotation;
    if (ArrayBuffer.isView(rotation)) rotation = Array.from(rotation);
    if (Array.isArray(rotation) && rotation.length === 3 && rotation.every(Array.isArray)) rotation = rotation.flat();
    if (!Array.isArray(rotation) || rotation.length !== 9 || rotation.some(x => !Number.isSafeInteger(x))) fail('Symmetry operation rotation must contain nine integers.');
    if (rotationTransposed) rotation = [rotation[0], rotation[3], rotation[6], rotation[1], rotation[4], rotation[7], rotation[2], rotation[5], rotation[8]];
    const translation = ArrayBuffer.isView(raw?.translation) ? Array.from(raw.translation) : raw?.translation;
    if (!Array.isArray(translation) || translation.length !== 3 || translation.some(x => !finite(x))) fail('Symmetry operation translation must contain three finite values.');
    return { rotation, translation: translation.slice() };
  }
  function matVec(rotation, vector) {
    return [0, 1, 2].map(i => rotation[i * 3] * vector[0] + rotation[i * 3 + 1] * vector[1] + rotation[i * 3 + 2] * vector[2]);
  }
  function diagonalConjugate(rotation, repeats) {
    return [0, 1, 2].map(i => [0, 1, 2].map(j => rotation[i * 3 + j] * repeats[j] / repeats[i]));
  }
  function nearestPeriodicDistance(delta, cell) {
    if (root.PhononSymmetry?.nearestImageDistance) return root.PhononSymmetry.nearestImageDistance(delta, cell);
    let best = Infinity;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
      const cartesian = root.Structures.cartesian([delta[0] - a, delta[1] - b, delta[2] - c], cell);
      best = Math.min(best, Math.hypot(...cartesian));
    }
    return best;
  }
  function operationPermutations(supercell, operations, options = {}) {
    if (!Array.isArray(operations) || !operations.length) fail('Host symmetry analysis must provide at least one operation.');
    const lattice = root.PhononSupercellLattice;
    const tolerance = options.tolerance ?? 1e-5;
    if (!finite(tolerance) || tolerance <= 0) fail('Symmetry mapping tolerance must be positive and finite.');
    const used = [], rejected = [];
    for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
      const operation = normalizeOperation(operations[operationIndex], options.rotationTransposed === true);
      const rotationRows = [0, 1, 2].map(i => operation.rotation.slice(i * 3, i * 3 + 3));
      if (!lattice.rotationPreservesSupercell(supercell.matrix, rotationRows)) {
        rejected.push({ operationIndex, reason: 'does-not-preserve-supercell-lattice' });
        continue;
      }
      const rotation = diagonalConjugate(operation.rotation, supercell.repeats).flat();
      const translation = operation.translation.map((value, axis) => value / supercell.repeats[axis]);
      const permutation = new Array(supercell.atoms.length), occupied = new Set();
      for (let source = 0; source < supercell.atoms.length; source++) {
        const atom = supercell.atoms[source];
        const transformed = matVec(rotation, atom.fractional).map((value, axis) => value + translation[axis]);
        let best = Infinity, target = -1, ambiguous = false;
        for (let candidate = 0; candidate < supercell.atoms.length; candidate++) {
          if (supercell.atoms[candidate].element !== atom.element) continue;
          const distance = nearestPeriodicDistance(transformed.map((value, axis) => value - supercell.atoms[candidate].fractional[axis]), supercell.cell);
          if (distance < best - Math.max(1e-12, tolerance * 1e-6)) { best = distance; target = candidate; ambiguous = false; }
          else if (Math.abs(distance - best) <= Math.max(1e-12, tolerance * 1e-6)) ambiguous = true;
        }
        if (target < 0 || best > tolerance || ambiguous || occupied.has(target)) fail(`Supercell symmetry operation ${operationIndex + 1} has no unique periodic site map for ${atom.id} (residual ${best.toPrecision(5)} Å).`);
        permutation[source] = target; occupied.add(target);
      }
      if (occupied.size !== supercell.atoms.length) fail(`Supercell symmetry operation ${operationIndex + 1} is not a bijection.`);
      used.push({ operationIndex, permutation });
    }
    if (!used.length) fail('No host symmetry operation preserves the requested supercell.');
    return { used, rejected, tolerance };
  }
  function vacancyOrbits(supercell, operations, options = {}) {
    const mapping = operationPermutations(supercell, operations, options);
    const parent = supercell.atoms.map((_, index) => index);
    const find = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
    const unite = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
    for (const operation of mapping.used) operation.permutation.forEach((target, source) => unite(source, target));
    const groups = new Map();
    parent.forEach((_, index) => { const representative = find(index); if (!groups.has(representative)) groups.set(representative, []); groups.get(representative).push(index); });
    const orbits = [...groups.values()].map(indices => {
      indices.sort((a, b) => a - b);
      const representativeIndex = indices[0], representative = supercell.atoms[representativeIndex];
      const countsBefore = countSpecies(supercell.atoms), countsAfter = new Map(countsBefore);
      countsAfter.set(representative.element, countsAfter.get(representative.element) - 1);
      if (countsAfter.get(representative.element) === 0) countsAfter.delete(representative.element);
      const removedDelta = Object.fromEntries([...new Set([...countsBefore.keys(), ...countsAfter.keys()])].map(element => [element, (countsAfter.get(element) || 0) - (countsBefore.get(element) || 0)]));
      const atomCountsBefore = [...countsBefore.values()].reduce((sum, value) => sum + value, 0);
      const atomCountsAfter = [...countsAfter.values()].reduce((sum, value) => sum + value, 0);
      if (atomCountsAfter !== atomCountsBefore - 1 || removedDelta[representative.element] !== -1 || Object.values(removedDelta).filter(value => value !== 0).length !== 1) fail('Vacancy descriptor must remove exactly one host atom and have ΔN=-1.');
      return {
        defectId: `vacancy:${supercell.hostId}:S${supercell.repeats.join('x')}:${representative.id}`,
        kind: 'vacancy',
        charge: 0,
        hostSiteId: representative.hostSiteId,
        supercellSiteId: representative.id,
        representativeAtomIndex: representativeIndex,
        element: representative.element,
        multiplicity: indices.length,
        memberSiteIds: indices.map(index => supercell.atoms[index].id),
        deltaNByElement: removedDelta,
        deltaN: -1,
        symmetryOperationCount: mapping.used.length,
        rejectedOperationCount: mapping.rejected.length,
        mappingKind: supercell.mappingKind,
        preserveHostSymmetryDuringRelaxation: false,
        relaxationSymmetryPolicy: supercell.relaxationSymmetry.policy,
      };
    }).sort((a, b) => a.representativeAtomIndex - b.representativeAtomIndex);
    if (orbits.reduce((sum, orbit) => sum + orbit.multiplicity, 0) !== supercell.atomCount) fail('Vacancy orbit multiplicities do not cover each supercell site exactly once.');
    return { orbits, operationCount: mapping.used.length, rejectedOperationCount: mapping.rejected.length, tolerance: mapping.tolerance };
  }
  function structureForVacancy(supercell, descriptor) {
    if (!descriptor || descriptor.kind !== 'vacancy' || descriptor.deltaN !== -1) fail('A neutral vacancy descriptor with ΔN=-1 is required.');
    const index = supercell.atoms.findIndex(atom => atom.id === descriptor.supercellSiteId);
    if (index < 0) fail('Vacancy descriptor site is not in the calculation supercell.');
    const removed = supercell.atoms[index], atoms = supercell.atoms.filter((_, atomIndex) => atomIndex !== index).map(({ cosetKey, cosetIndex, primitiveTranslation, primitiveFractional, fractional, hostAtomIndex, hostSiteId, id, ...atom }) => ({ ...atom }));
    if (atoms.length !== supercell.atomCount - 1) fail('Vacancy structure did not remove exactly one atom.');
    return {
      cell: supercell.cell.map(row => row.slice()),
      pbc: [true, true, true],
      atoms,
      defect: { defectId: descriptor.defectId, kind: 'vacancy', charge: 0, removedElement: removed.element, deltaNByElement: { ...descriptor.deltaNByElement }, deltaN: -1 },
      symmetry: { preserveHostSymmetryDuringRelaxation: false, policy: 'relax without host symmetry constraints' },
    };
  }
  function substitutionForOrbit(orbit, dopant) {
    if (!dopant || dopant === orbit.element || !root.ElementStyles?.[dopant]?.atomic_number) fail('Choose a valid dopant distinct from the host species.');
    return {...orbit, defectId: `substitution:${dopant}:${orbit.defectId}`, kind: 'substitution', dopant,
      deltaNByElement: {[orbit.element]: -1, [dopant]: 1}, deltaN: 0};
  }
  // Geometric seeds for relaxation, ranked by clearance from the host atoms.
  // Use a periodic host-cell grid, refine local maxima, and merge near-equivalent
  // positions under the host operations compatible with the calculation cell.
  function findInterstitialSites({host, supercell, operations}) {
    const resolution = 8;
    const offsets = [-1, 0, 1].flatMap(a => [-1, 0, 1].flatMap(b => [-1, 0, 1]
      .map(c => [a, b, c]))).filter(offset => offset.some(Boolean));
    const index = ([a, b, c]) => (mod(a, resolution) * resolution + mod(b, resolution)) * resolution + mod(c, resolution);
    const distance = (a, b) => nearestPeriodicDistance(a.map((value, axis) => value - b[axis]), host.cell);
    const clearance = point => host.atoms.reduce((closest, atom) => Math.min(closest, distance(point, atom.fractional)), Infinity);
    const samples = Array.from({length: resolution ** 3}, (_, i) => {
      const grid = [Math.floor(i / resolution ** 2), Math.floor(i / resolution) % resolution, i % resolution];
      const position = grid.map(value => value / resolution);
      return {grid, position, separation: clearance(position)};
    });
    const seeds = samples.filter(sample => sample.separation >= 1.2 &&
      offsets.every(offset => sample.separation >= samples[index(sample.grid.map((value, axis) => value + offset[axis]))].separation - 1e-9))
      .sort((a, b) => b.separation - a.separation).slice(0, 24);
    for (const seed of seeds) {
      for (const step of [1/16, 1/32, 1/64, 1/128]) {
        const origin = seed.position;
        for (const offset of offsets) {
          const point = origin.map((value, axis) => mod(value + step * offset[axis], 1));
          const gap = clearance(point);
          if (gap > seed.separation + 1e-9) {
            seed.position = point;
            seed.separation = gap;
          }
        }
      }
    }
    const compatible = operations.map(operation => normalizeOperation(operation, true)).filter(({rotation}) =>
      root.PhononSupercellLattice.rotationPreservesSupercell(supercell.matrix,
        [0, 1, 2].map(row => rotation.slice(row * 3, row * 3 + 3))));
    const sites = [];
    for (const seed of seeds.sort((a, b) => b.separation - a.separation)) {
      const images = compatible.map(({rotation, translation}) =>
        matVec(rotation, seed.position).map((value, axis) => value + translation[axis]));
      if (sites.some(site => images.some(image => distance(image, site.hostFractional) < 0.25))) continue;
      const supercellFractional = root.PhononSupercellLattice.supercellFractional(seed.position, supercell.matrix);
      sites.push({hostFractional: seed.position, supercellFractional, separation: seed.separation});
      if (sites.length === 3) break;
    }
    return sites;
  }

  function interstitialForSite(supercell, site, index, element) {
    return {
      defectId: `interstitial:${supercell.hostId}:S${supercell.repeats.join('x')}:${index + 1}:${element}`,
      kind: 'interstitial', charge: 0, element, siteNumber: index + 1, separation: site.separation,
      insertionFractional: site.supercellFractional, representativeAtomIndex: supercell.atomCount,
      deltaN: 1, deltaNByElement: {[element]: 1},
      relaxationSymmetryPolicy: supercell.relaxationSymmetry.policy,
    };
  }

  function structureForDefect(supercell, descriptor) {
    if (descriptor?.kind === 'vacancy') return structureForVacancy(supercell, descriptor);
    if (descriptor?.kind === 'interstitial') {
      if (descriptor.charge !== 0 || descriptor.deltaN !== 1 || !root.ElementStyles?.[descriptor.element]?.atomic_number) {
        fail('A valid neutral interstitial is required.');
      }
      const fractional = vector3(descriptor.insertionFractional, 'Interstitial position');
      const atoms = supercell.atoms.map(({element, position}) => ({element, position: position.slice()}));
      atoms.push({element: descriptor.element, position: root.Structures.cartesian(fractional, supercell.cell)});
      return {cell: supercell.cell.map(row => row.slice()), pbc: [true, true, true], atoms, defect: {...descriptor}};
    }
    const site = supercell.atoms[descriptor?.representativeAtomIndex];
    if (descriptor?.kind !== 'substitution' || !site || site.id !== descriptor.supercellSiteId ||
        site.element !== descriptor.element || descriptor.charge !== 0 || descriptor.deltaN !== 0 ||
        descriptor.dopant === site.element || !root.ElementStyles?.[descriptor.dopant]?.atomic_number) {
      fail('A valid neutral substitution on the calculation supercell is required.');
    }
    return {
      cell: supercell.cell.map(row => row.slice()), pbc: [true, true, true],
      atoms: supercell.atoms.map((atom, index) => ({
        element: index === descriptor.representativeAtomIndex ? descriptor.dopant : atom.element,
        position: atom.position.slice(),
      })),
      defect: {...descriptor},
      symmetry: {preserveHostSymmetryDuringRelaxation: false, policy: 'relax without host symmetry constraints'},
    };
  }
  function localVacancyEnvironment(perfect, initial, final, descriptor) {
    const site = descriptor.representativeAtomIndex;
    const hostSpecies = perfect.atomic_numbers;
    const substitution = descriptor.kind === 'substitution';
    const interstitial = descriptor.kind === 'interstitial';
    const expected = interstitial ? [...hostSpecies, root.ElementStyles[descriptor.element].atomic_number]
      : substitution ? hostSpecies.map((number, index) => index === site ? root.ElementStyles[descriptor.dopant].atomic_number : number)
      : hostSpecies.filter((_, index) => index !== site);
    const cell = perfect.cell_a;
    const validSite = interstitial ? site === hostSpecies.length : site >= 0 && site < hostSpecies.length &&
      root.Structures.elementSymbol(hostSpecies[site]) === descriptor.element;
    if (!validSite || (!interstitial && !substitution && descriptor.kind !== 'vacancy') ||
        [initial, final].some(state => JSON.stringify(state.cell_a) !== JSON.stringify(cell) ||
          JSON.stringify(state.atomic_numbers) !== JSON.stringify(expected))) {
      fail('The relaxed defect cannot be matched to the fixed perfect supercell.');
    }
    const {fractional, cartesian, elementSymbol} = root.Structures;
    const center = interstitial ? initial.positions_a[site] : perfect.positions_a[site];
    const nearest = (to, from) => root.PhononSymmetry.nearestImage(
      fractional(to.map((value, axis) => value - from[axis]), cell), cell);
    const atoms = initial.positions_a.map((position, index) => {
      const local = nearest(position, center);
      const displacement = nearest(final.positions_a[index], position);
      const start = cartesian(local.fractional, cell), vector = cartesian(displacement.fractional, cell);
      const end = start.map((value, axis) => value + vector[axis]);
      return {hostIndex: interstitial || substitution || index < site ? index : index + 1, inserted: interstitial && index === site, element: elementSymbol(expected[index]),
        start, end, vector, initialDistance: local.distance, finalDistance: Math.hypot(...end), displacement: displacement.distance};
    });
    return {center, atoms};
  }

  async function analyzeHostAndGenerate(input, repeats, options = {}) {
    if (!root.PhononSymmetry?.analyzeStructure) fail('The local host-symmetry analyzer is unavailable.');
    const host = structureForMapping(input);
    const analysis = await root.PhononSymmetry.analyzeStructure(host, { tolerance: options.tolerance ?? 1e-5 });
    const supercell = buildSupercell(host, repeats, options);
    const operations = analysis.dataset?.operations;
    const grouping = vacancyOrbits(supercell, operations, { tolerance: options.tolerance ?? 1e-5, rotationTransposed: true });
    return { host, supercell, operations, symmetry: { spaceGroupNumber: analysis.spaceGroupNumber, spaceGroupSymbol: analysis.spaceGroupSymbol, tolerance: options.tolerance ?? 1e-5 }, ...grouping };
  }

  const api = Object.freeze({ buildSupercell, mapHostImage, inversePeriodicMap, normalizeOperation, operationPermutations, vacancyOrbits, structureForVacancy, substitutionForOrbit, structureForDefect, localVacancyEnvironment, findInterstitialSites, interstitialForSite, analyzeHostAndGenerate });
  root.NeutralDefect = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis === 'object' ? globalThis : this);
