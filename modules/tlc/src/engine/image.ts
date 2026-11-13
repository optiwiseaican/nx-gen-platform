/**
 * Images for the TLC engine, ported from the TLC Tablet app (engine/image). An RgbImage keeps
 * ARGB pixels packed as 32-bit integers (the tablet's Bitmap layout); a GrayImage keeps one
 * 32-bit float per pixel on a 0..255 scale. Float32 arithmetic is reproduced with Math.fround so
 * results agree with the tablet bit for bit, which the golden tests rely on.
 */

export type Channel = 'INTENSITY' | 'RED' | 'GREEN' | 'BLUE';

const f = Math.fround;
const C_R = f(0.299);
const C_G = f(0.587);
const C_B = f(0.114);

export const argb = (r: number, g: number, b: number): number => (0xff000000 | (r << 16) | (g << 8) | b) | 0;
export const red = (p: number): number => (p >> 16) & 0xff;
export const green = (p: number): number => (p >> 8) & 0xff;
export const blue = (p: number): number => p & 0xff;
export const maxChannel = (p: number): number => Math.max(red(p), green(p), blue(p));

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** Kotlin roundToInt: nearest integer, ties towards +∞ (same as Math.round). */
export const roundToInt = (v: number): number => Math.round(v);
/** Kotlin toInt(): truncation towards zero. */
export const toInt = (v: number): number => Math.trunc(v);

export class RgbImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly pixels: Int32Array,
  ) {
    if (!(width > 0 && height > 0)) throw new Error('Image must be non-empty');
    if (pixels.length !== width * height) throw new Error(`Expected ${width * height} pixels, got ${pixels.length}`);
  }

  get(x: number, y: number): number {
    return this.pixels[y * this.width + x];
  }

  channel(channel: Channel): GrayImage {
    const out = new Float32Array(this.pixels.length);
    const px = this.pixels;
    for (let i = 0; i < px.length; i++) {
      const p = px[i];
      const r = (p >> 16) & 0xff;
      const g = (p >> 8) & 0xff;
      const b = p & 0xff;
      switch (channel) {
        case 'INTENSITY':
          out[i] = f(f(f(C_R * r) + f(C_G * g)) + f(C_B * b));
          break;
        case 'RED':
          out[i] = r;
          break;
        case 'GREEN':
          out[i] = g;
          break;
        case 'BLUE':
          out[i] = b;
          break;
      }
    }
    return new GrayImage(this.width, this.height, out);
  }

  /** Applies a per-component transform (alpha is kept). */
  mapComponents(transform: (v: number) => number): RgbImage {
    const lut = new Int32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = clamp(transform(i), 0, 255);
    const out = new Int32Array(this.pixels.length);
    for (let i = 0; i < out.length; i++) {
      const p = this.pixels[i];
      out[i] = (p & 0xff000000) | (lut[(p >> 16) & 0xff] << 16) | (lut[(p >> 8) & 0xff] << 8) | lut[p & 0xff];
    }
    return new RgbImage(this.width, this.height, out);
  }
}

export class GrayImage {
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Float32Array,
  ) {
    if (!(width > 0 && height > 0)) throw new Error('Image must be non-empty');
    if (data.length !== width * height) throw new Error(`Expected ${width * height} values, got ${data.length}`);
  }

  get(x: number, y: number): number {
    return this.data[y * this.width + x];
  }

  /** Bilinear sample in float32 arithmetic; coordinates are clamped to the image. */
  sample(x: number, y: number): number {
    const cx = clamp(x, 0, this.width - 1);
    const cy = clamp(y, 0, this.height - 1);
    const x0 = toInt(cx);
    const y0 = toInt(cy);
    const x1 = Math.min(x0 + 1, this.width - 1);
    const y1 = Math.min(y0 + 1, this.height - 1);
    const fx = f(cx - x0);
    const fy = f(cy - y0);
    const w = this.width;
    const d = this.data;
    const top = f(f(d[y0 * w + x0] * f(1 - fx)) + f(d[y0 * w + x1] * fx));
    const bottom = f(f(d[y1 * w + x0] * f(1 - fx)) + f(d[y1 * w + x1] * fx));
    return f(f(top * f(1 - fy)) + f(bottom * fy));
  }

  toArgb(): Int32Array {
    const out = new Int32Array(this.data.length);
    for (let i = 0; i < out.length; i++) {
      const v = clamp(roundToInt(this.data[i]), 0, 255);
      out[i] = argb(v, v, v);
    }
    return out;
  }
}

/** Non-destructive post-processing; the original capture is never modified. */
export interface PostProcessing {
  /** Input level mapped to black (0..254). */
  blackPoint: number;
  /** Input level mapped to white (blackPoint+1..255). */
  whitePoint: number;
  /** 3×3 median: removes salt-and-pepper sensor noise (long UV 366 exposures). */
  denoise: boolean;
}

export const DEFAULT_POST_PROCESSING: PostProcessing = { blackPoint: 0, whitePoint: 255, denoise: false };

export function validatePostProcessing(p: PostProcessing): string[] {
  const problems: string[] = [];
  if (!(Number.isInteger(p.blackPoint) && p.blackPoint >= 0 && p.blackPoint <= 254)) problems.push('blackPoint must be 0..254');
  if (!(Number.isInteger(p.whitePoint) && p.whitePoint > p.blackPoint && p.whitePoint <= 255)) problems.push('whitePoint must be > blackPoint and <= 255');
  return problems;
}

export const isIdentityProcessing = (p: PostProcessing): boolean => p.blackPoint === 0 && p.whitePoint === 255 && !p.denoise;

export const ImageOps = {
  contrastStretch(value: number, black: number, white: number): number {
    return clamp(roundToInt(((value - black) * 255.0) / (white - black)), 0, 255);
  },

  apply(image: RgbImage, settings: PostProcessing): RgbImage {
    if (isIdentityProcessing(settings)) return image;
    let out = image;
    if (settings.denoise) out = ImageOps.median3(out);
    if (settings.blackPoint !== 0 || settings.whitePoint !== 255) {
      out = out.mapComponents((v) => ImageOps.contrastStretch(v, settings.blackPoint, settings.whitePoint));
    }
    return out;
  },

  /** 3×3 median per colour component; edges use clamped neighbours. */
  median3(image: RgbImage): RgbImage {
    const w = image.width;
    const h = image.height;
    const out = new Int32Array(w * h);
    const r = new Int32Array(9);
    const g = new Int32Array(9);
    const b = new Int32Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = clamp(y + dy, 0, h - 1);
          for (let dx = -1; dx <= 1; dx++) {
            const p = image.get(clamp(x + dx, 0, w - 1), yy);
            r[k] = (p >> 16) & 0xff;
            g[k] = (p >> 8) & 0xff;
            b[k] = p & 0xff;
            k++;
          }
        }
        r.sort();
        g.sort();
        b.sort();
        out[y * w + x] = (image.get(x, y) & 0xff000000) | (r[4] << 16) | (g[4] << 8) | b[4];
      }
    }
    return new RgbImage(w, h, out);
  },

  /** Blue→red heatmap of a gray image, for spotting faint bands. */
  heatmap(gray: GrayImage): Int32Array {
    const out = new Int32Array(gray.data.length);
    for (let i = 0; i < out.length; i++) {
      const t = clamp(gray.data[i] / 255, 0, 1);
      const r = roundToInt(255 * clamp(1.5 - Math.abs(4 * t - 3), 0, 1));
      const g = roundToInt(255 * clamp(1.5 - Math.abs(4 * t - 2), 0, 1));
      const b = roundToInt(255 * clamp(1.5 - Math.abs(4 * t - 1), 0, 1));
      out[i] = argb(r, g, b);
    }
    return out;
  },
};
