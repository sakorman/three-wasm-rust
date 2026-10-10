import { box, cylinder, sphere } from './geometry.ts';
import type { EngineScene, MaterialData, Scenario } from './types.ts';

export const scenarioNames: Record<Scenario, string> = {
  city: '街区 · 稀疏更新',
  warehouse: '仓库 · 静态批次',
  hierarchy: '机械阵列 · 层级运动',
};

export function createEngineScene(scenario: Scenario, count: number, seed = 2026): EngineScene {
  if (!Number.isInteger(count) || count < 100 || count > 20000)
    throw new Error('Mesh count must be 100–20,000');
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const geometries = [box(), cylinder(), sphere()];
  const materials: MaterialData[] = [
    { name: 'concrete', color: [0.42, 0.54, 0.58], unlit: false },
    { name: 'copper', color: [0.88, 0.49, 0.25], unlit: false },
    { name: 'ivory', color: [0.85, 0.83, 0.71], unlit: false },
    { name: 'teal', color: [0.24, 0.66, 0.65], unlit: false },
    { name: 'steel', color: [0.24, 0.32, 0.4], unlit: false },
    { name: 'ground', color: [0.12, 0.19, 0.22], unlit: false },
    { name: 'signal', color: [0.98, 0.74, 0.36], unlit: true },
  ];
  const parents: number[] = [],
    transforms: number[] = [],
    meshNodes: number[] = [],
    groups: number[] = [],
    radii: number[] = [],
    animated: number[] = [];
  const batchGeometries: number[] = [],
    batchMaterials: number[] = [],
    groupMap = new Map<string, number>();
  const node = (parent: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
    const id = parents.length;
    parents.push(parent);
    transforms.push(x, y, z, 0, 0, 0, 1, sx, sy, sz);
    return id;
  };
  const mesh = (
    parent: number,
    geo: number,
    mat: number,
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
  ) => {
    if (meshNodes.length >= count) return -1;
    const id = node(parent, x, y, z, sx, sy, sz),
      key = `${geo}:${mat}`;
    let group = groupMap.get(key);
    if (group === undefined) {
      group = groupMap.size;
      groupMap.set(key, group);
      batchGeometries.push(geo);
      batchMaterials.push(mat);
    }
    meshNodes.push(id);
    groups.push(group);
    radii.push(geometries[geo].radius);
    return id;
  };
  const perCell = scenario === 'city' ? 9 : scenario === 'warehouse' ? 18 : 8;
  const side = Math.ceil(Math.sqrt((count - 1) / perCell));
  const spacing = scenario === 'city' ? 10 : scenario === 'warehouse' ? 7 : 8;
  const extent = (side * spacing) / 2;
  mesh(-1, 0, 5, 0, -0.4, 0, extent * 2 + 8, 0.7, extent * 2 + 8);
  for (let cell = 0; meshNodes.length < count; cell++) {
    const x = ((cell % side) - (side - 1) / 2) * spacing,
      z = (Math.floor(cell / side) - (side - 1) / 2) * spacing;
    const root = node(-1, x, 0, z);
    if (scenario === 'city') {
      const height = 3 + random() * 12,
        w = 2.5 + random() * 2,
        d = 2.5 + random() * 2;
      mesh(root, 0, cell % 4, 0, height / 2, 0, w, height, d);
      mesh(root, 0, 4, 0, height + 0.2, 0, w + 0.3, 0.4, d + 0.3);
      for (let floor = 0; floor < 3; floor++)
        mesh(root, 0, 6, 0, 1.5 + (floor * (height - 2)) / 3, d / 2 + 0.015, w * 0.76, 0.25, 0.08);
      mesh(root, 1, 4, 3, 0.85, 2, 0.2, 1.7, 0.2);
      mesh(root, 2, 3, 3, 2, 2, 1.4, 1.4, 1.4);
      const sign = mesh(root, 0, 1, -3, 2, 2, 1.2, 0.8, 0.2);
      if (sign >= 0 && cell % 4 === 0) animated.push(sign);
      mesh(root, 0, 2, 0, 0.015, -4, 0.2, 0.05, 1.8);
    } else if (scenario === 'warehouse') {
      for (const dx of [-2, 2])
        for (const dz of [-1, 1]) mesh(root, 0, 4, dx, 2.5, dz, 0.18, 5, 0.18);
      for (const y of [0.5, 2.1, 3.7]) {
        mesh(root, 0, 0, 0, y, 0, 4.3, 0.15, 2.5);
        for (let slot = 0; slot < 3; slot++)
          mesh(
            root,
            slot === 2 ? 1 : 0,
            1 + ((cell + slot) % 3),
            (slot - 1) * 1.2,
            y + 0.55,
            0,
            0.9,
            1,
            0.95,
          );
      }
      mesh(root, 0, 6, -1.7, 4.6, 1.12, 0.6, 0.25, 0.06);
      mesh(root, 2, 3, 1.6, 4.6, 0, 0.7, 0.7, 0.7);
    } else {
      animated.push(root);
      mesh(root, 1, 4, 0, 0.35, 0, 2.4, 0.7, 2.4);
      mesh(root, 0, 1, 0, 1.8, 0, 0.7, 2.8, 0.7);
      const arm = node(root, 0, 3.2, 0);
      animated.push(arm);
      mesh(arm, 0, 0, 1.5, 0, 0, 3.5, 0.35, 0.35);
      mesh(arm, 2, 6, 3, 0, 0, 0.8, 0.8, 0.8);
      const joint = node(arm, 3, -0.4, 0);
      animated.push(joint);
      mesh(joint, 0, 2, 0.7, -0.7, 0, 1.8, 0.25, 0.35);
      mesh(joint, 1, 3, 1.5, -1, 0, 0.4, 0.8, 0.4);
      mesh(root, 2, 3, -1, 0.65, -1, 0.5, 0.5, 0.5);
      mesh(root, 0, 6, 0, 0.025, -3, 1.8, 0.05, 0.18);
    }
  }
  return {
    name: scenarioNames[scenario],
    scenario,
    seed,
    extent,
    geometries,
    materials,
    parents: Int32Array.from(parents),
    transforms: Float32Array.from(transforms),
    meshNodes: Uint32Array.from(meshNodes),
    groups: Uint32Array.from(groups),
    radii: Float32Array.from(radii),
    batchGeometries: Uint32Array.from(batchGeometries),
    batchMaterials: Uint32Array.from(batchMaterials),
    animatedNodes: Uint32Array.from(animated),
  };
}
