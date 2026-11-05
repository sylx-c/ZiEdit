export const GUARD_MAX_SIDE = 16384;
export const GUARD_MAX_PIXELS = 66_000_000;

export const shouldGuard = (w: number, h: number): boolean =>
  w > GUARD_MAX_SIDE || h > GUARD_MAX_SIDE || w * h > GUARD_MAX_PIXELS;

export const isProbeableImage = (path: string): boolean => {
  const filename = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = filename.lastIndexOf('.');
  const extension = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
  return ['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(extension);
};
