import { describe, expect, it } from 'vitest';
import { eyeAspectRatio, headYaw, percentile, type Point } from './liveness-math';

/** Six-point eye contour (p1..p6) with the given width and lid opening. */
const eye = (width: number, opening: number): Point[] => [
  { x: 0, y: 0 },
  { x: width / 3, y: -opening / 2 },
  { x: (2 * width) / 3, y: -opening / 2 },
  { x: width, y: 0 },
  { x: (2 * width) / 3, y: opening / 2 },
  { x: width / 3, y: opening / 2 },
];

/** 68 landmarks where only the jaw ends (0, 16) and nose tip (30) matter. */
const face = (jawLeft: number, nose: number, jawRight: number): Point[] => {
  const points = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  points[0] = { x: jawLeft, y: 0 };
  points[16] = { x: jawRight, y: 0 };
  points[30] = { x: nose, y: 0 };
  return points;
};

describe('eyeAspectRatio', () => {
  it('is opening / width for an evenly shaped eye', () => {
    expect(eyeAspectRatio(eye(30, 9))).toBeCloseTo(0.3);
  });

  it('drops below the closed-eye threshold when the lids meet', () => {
    expect(eyeAspectRatio(eye(30, 9))).toBeGreaterThan(0.22);
    expect(eyeAspectRatio(eye(30, 3))).toBeLessThan(0.22);
  });

  it('is scale invariant', () => {
    expect(eyeAspectRatio(eye(300, 90))).toBeCloseTo(eyeAspectRatio(eye(30, 9)));
  });

  it('returns 0 for a degenerate eye instead of dividing by zero', () => {
    expect(eyeAspectRatio(eye(0, 0))).toBe(0);
  });
});

describe('headYaw', () => {
  it('is 0 when the nose is centred between the jaw ends', () => {
    expect(headYaw(face(0, 50, 100))).toBe(0);
  });

  it('has opposite signs for opposite turns', () => {
    expect(headYaw(face(0, 30, 100))).toBeCloseTo(0.4);
    expect(headYaw(face(0, 70, 100))).toBeCloseTo(-0.4);
  });

  it('returns 0 when all points collapse', () => {
    expect(headYaw(face(10, 10, 10))).toBe(0);
  });
});

describe('percentile', () => {
  it('picks nearest-rank values', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 75)).toBe(4);
    expect(percentile(values, 100)).toBe(5);
  });

  it('does not mutate its input', () => {
    const values = [3, 1, 2];
    percentile(values, 50);
    expect(values).toEqual([3, 1, 2]);
  });
});
