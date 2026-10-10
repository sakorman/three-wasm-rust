/** Resolve required elements once, checking the real DOM rather than asserting a type. */
function element<T extends HTMLElement>(id: string, kind: { new(): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error(`Expected ${kind.name} with id="${id}"`);
  return value;
}

export const ui = {
  stage: element('stage', HTMLDivElement),
  rustCanvas: element('rust-canvas', HTMLCanvasElement),
  threeCanvas: element('three-canvas', HTMLCanvasElement),
  mode: element('mode', HTMLSelectElement),
  count: element('count', HTMLSelectElement),
  pause: element('pause', HTMLButtonElement),
  reset: element('reset', HTMLButtonElement),
  benchmark: element('benchmark', HTMLButtonElement),
  download: element('download', HTMLButtonElement),
  status: element('status', HTMLSpanElement),
  statusDot: element('status-dot', HTMLSpanElement),
  sceneLabel: element('scene-label', HTMLSpanElement),
  error: element('error', HTMLDivElement),
  fps: element('fps', HTMLElement),
  compute: element('compute', HTMLElement),
  render: element('render', HTMLElement),
  results: element('results', HTMLTableSectionElement),
  progress: element('bench-progress', HTMLDivElement),
};
