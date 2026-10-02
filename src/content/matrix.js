// 2D affine matrices as [a, b, c, d, e, f] (ISO 32000-1, section 8.3.4).

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** Returns m1 × m2 (apply m1 first, then m2). */
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (for vectors). */
export function applyVector(m, x, y) {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [...IDENTITY];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];
