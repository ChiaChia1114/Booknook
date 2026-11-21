import { openSync, readSync, closeSync } from 'node:fs';

/** Raster formats accepted for payload images, identified by their magic bytes. */
export const SAFE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff'] as const;
export type SafeImageType = (typeof SAFE_IMAGE_TYPES)[number];

/**
 * Detects the image type from the file signature, ignoring the client-supplied MIME type.
 * Anything else (SVG, HTML, PDF, …) returns null and must not be served as an image.
 */
export function sniffImageType(head: Uint8Array): SafeImageType | null {
  const b = (i: number) => head[i] ?? -1;
  const ascii = (from: number, s: string) => [...s].every((ch, i) => b(from + i) === ch.charCodeAt(0));
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x89 && ascii(1, 'PNG') && b(4) === 0x0d && b(5) === 0x0a) return 'image/png';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if ((ascii(0, 'II') && b(2) === 42 && b(3) === 0) || (ascii(0, 'MM') && b(2) === 0 && b(3) === 42)) return 'image/tiff';
  return null;
}

export function sniffImageFile(path: string): SafeImageType | null {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const n = readSync(fd, head, 0, 16, 0);
    return sniffImageType(head.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

export function isSafeImageType(mime: string): mime is SafeImageType {
  return (SAFE_IMAGE_TYPES as readonly string[]).includes(mime);
}
