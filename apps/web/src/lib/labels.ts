/** Screen-space helpers for placing map labels without overlaps (3D planner and live view). */

export interface Rect {
  l: number;
  r: number;
  t: number;
  b: number;
}

export const overlaps = (a: Rect, b: Rect): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

export const rectAround = (x: number, y: number, w: number, h: number): Rect => ({ l: x - w / 2, r: x + w / 2, t: y - h / 2, b: y + h / 2 });

const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
const widths = new Map<string, number>();

/** Rendered width (px) of a label text in a CSS font (cached). */
export function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  const hit = widths.get(key);
  if (hit !== undefined) return hit;
  let w = text.length * 7;
  if (measureCtx) {
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
  }
  if (widths.size > 1000) widths.clear();
  widths.set(key, w);
  return w;
}
