import type { CameraFrame } from './types.ts';

export function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

export class OrbitCamera {
  yaw = 0.72;
  pitch = 0.72;
  distance = 60;
  target: [number, number, number] = [0, 3, 0];
  private extent = 30;
  private cleanups: (() => void)[] = [];
  reset(extent: number) {
    this.extent = extent;
    this.distance = extent * 2.6 + 20;
    this.yaw = 0.72;
    this.pitch = 0.72;
    this.target = [0, 3, 0];
  }
  frame(aspect: number): CameraFrame {
    const cp = Math.cos(this.pitch),
      sp = Math.sin(this.pitch),
      sy = Math.sin(this.yaw),
      cy = Math.cos(this.yaw);
    const z = [sy * cp, sp, cy * cp],
      x = [cy, 0, -sy],
      y = [-sy * sp, cp, -cy * sp];
    const eye = this.target.map((v, i) => v + z[i] * this.distance);
    const dot = (v: number[]) => v.reduce((sum, a, i) => sum + a * eye[i], 0);
    const view = Float32Array.from([
      x[0],
      y[0],
      z[0],
      0,
      x[1],
      y[1],
      z[1],
      0,
      x[2],
      y[2],
      z[2],
      0,
      -dot(x),
      -dot(y),
      -dot(z),
      1,
    ]);
    const near = 0.1,
      far = Math.max(1000, this.extent * 20),
      f = 1 / Math.tan((46 * Math.PI) / 360);
    const projection = Float32Array.from([
      f / aspect,
      0,
      0,
      0,
      0,
      f,
      0,
      0,
      0,
      0,
      (far + near) / (near - far),
      -1,
      0,
      0,
      (2 * far * near) / (near - far),
      0,
    ]);
    return { projection, view, viewProjection: multiply(projection, view) };
  }
  attach(element: HTMLElement, onChange: () => void) {
    let pointer: number | undefined,
      lastX = 0,
      lastY = 0;
    const down = (event: PointerEvent) => {
      pointer = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      element.setPointerCapture(pointer);
    };
    const move = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      this.yaw -= (event.clientX - lastX) * 0.006;
      this.pitch = Math.max(0.12, Math.min(1.4, this.pitch + (event.clientY - lastY) * 0.006));
      lastX = event.clientX;
      lastY = event.clientY;
      onChange();
    };
    const up = () => {
      pointer = undefined;
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      this.distance = Math.max(
        6,
        Math.min(this.extent * 8 + 100, this.distance * Math.exp(event.deltaY * 0.001)),
      );
      onChange();
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('wheel', wheel, { passive: false });
    this.cleanups.push(() => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('wheel', wheel);
    });
  }
  dispose() {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
  }
}
