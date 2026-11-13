/** Image decoding and encoding for the module API (pure JavaScript, bundled). */
import { decode as decodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';
import { RgbImage, argb } from '../engine';
import { imageType } from '../shared/tlc';

/** Decodes a PNG or JPEG into the engine's ARGB image; throws for anything else. */
export function decodeImage(data: Buffer): RgbImage {
  const type = imageType(data);
  if (type === 'image/png') {
    const png = PNG.sync.read(data);
    return fromRgba(png.width, png.height, png.data);
  }
  if (type === 'image/jpeg') {
    const jpg = decodeJpeg(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 60 });
    return fromRgba(jpg.width, jpg.height, jpg.data);
  }
  throw new Error('The file is not a PNG or JPEG image.');
}

function fromRgba(width: number, height: number, rgba: Uint8Array | Buffer): RgbImage {
  const px = new Int32Array(width * height);
  for (let i = 0; i < px.length; i++) px[i] = argb(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
  return new RgbImage(width, height, px);
}

/** Encodes an ARGB image as PNG (RGB, no alpha). */
export function encodePng(image: RgbImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height, colorType: 2 });
  for (let i = 0; i < image.pixels.length; i++) {
    const p = image.pixels[i];
    png.data[4 * i] = (p >> 16) & 0xff;
    png.data[4 * i + 1] = (p >> 8) & 0xff;
    png.data[4 * i + 2] = p & 0xff;
    png.data[4 * i + 3] = 0xff;
  }
  return PNG.sync.write(png, { colorType: 2 });
}

/** RGB bytes of an image, for a hash that does not depend on the file encoding. */
export function pixelBytes(image: RgbImage): Buffer {
  const bytes = Buffer.alloc(image.pixels.length * 3);
  for (let i = 0; i < image.pixels.length; i++) {
    const p = image.pixels[i];
    bytes[3 * i] = (p >> 16) & 0xff;
    bytes[3 * i + 1] = (p >> 8) & 0xff;
    bytes[3 * i + 2] = p & 0xff;
  }
  return bytes;
}
