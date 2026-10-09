export interface Point {
  x: number;
  y: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** EAR clásico: (‖p2−p6‖ + ‖p3−p5‖) / (2·‖p1−p4‖). Ojo cerrado ≈ < 0.22. */
export function eyeAspectRatio(eye: Point[]): number {
  const horizontal = dist(eye[0], eye[3]);
  if (horizontal === 0) return 0;
  return (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * horizontal);
}

/**
 * Estima el giro de la cabeza comparando la distancia de la nariz a cada
 * lado de la mandíbula (landmarks 68: 0 y 16 mandíbula, 30 punta de la nariz).
 * 0 = de frente; |yaw| > 0.35 = cabeza girada.
 */
export function headYaw(points: Point[]): number {
  const nose = points[30];
  const left = Math.abs(nose.x - points[0].x);
  const right = Math.abs(points[16].x - nose.x);
  const total = left + right;
  if (total === 0) return 0;
  return (right - left) / total;
}

/** Percentil por rango más cercano; `values` no se modifica. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
