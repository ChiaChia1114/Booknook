/**
 * Detects WebGL rendered in software (no GPU acceleration: SwiftShader, llvmpipe …).
 * CesiumJS needs hardware acceleration for interactive frame rates; without it the live
 * console starts in 2D (the user can still switch to 3D).
 */
let cached: boolean | null = null;

export function softwareWebGL(): boolean {
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return (cached = true);
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    cached = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    cached = true;
  }
  return cached;
}
