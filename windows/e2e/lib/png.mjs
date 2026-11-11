// The pixels of a PNG, enough for the WebDriver's screenshots (8 bits, RGB
// or RGBA, not interlaced), on node:zlib: no image library.

import { inflateSync } from "node:zlib";

/** { width, height, rgba } of `png`, one byte per channel, four per pixel. */
export function decodePng(png) {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || body[12] !== 0) {
        throw new Error(`PNG not read here: depth ${depth}, color type ${color}, interlace ${body[12]}`);
      }
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[out + x - channels] : 0;
      const b = y > 0 ? px[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? px[out - stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[out + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) for (let k = 0; k < channels; k++) rgba[i * 4 + k] = px[i * channels + k];
  return { width, height, rgba };
}

/**
 * How many pixels of the box `{ x, y, w, h }` (in the images' pixels) differ
 * between `a` and `b` by more than `tolerance` on some channel.
 */
export function pixelsChanged(a, b, box, tolerance = 60) {
  let changed = 0;
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(a.width, b.width, Math.ceil(box.x + box.w));
  const y1 = Math.min(a.height, b.height, Math.ceil(box.y + box.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(a.rgba[i + k] - b.rgba[j + k]) > tolerance) {
          changed++;
          break;
        }
      }
    }
  }
  return changed;
}
