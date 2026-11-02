// A PNG reader for the screencast's frames (8-bit RGB or RGBA, not interlaced: what Chromium's Page.startScreencast
// sends with format "png"), and the two pixel tests of BAR-03 (app.md:1098): a frame is blank when 99.5% of its pixels
// are one colour, and a white flash when more than half its pixels have a luminance above 0.9.
import { inflateSync } from "node:zlib";

/** @returns {{ width: number, height: number, channels: number, data: Uint8Array }} */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      if (depth !== 8 || body[12] !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`png: depth ${depth} colour ${colour} interlace ${body[12]}`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[out + x - channels] : 0;
      const b = y > 0 ? data[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? data[out - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`png: filter ${f}`);
      data[out + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}

/** BAR-03's two tests on one frame: the share of its most common colour and of its bright pixels. */
export function framePixels(png) {
  const { width, height, channels, data } = decodePng(png);
  const counts = new Map();
  let bright = 0;
  let n = 0;
  // every second pixel each way: a quarter of the frame, enough for a 99.5% share
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = (r << 16) | (g << 8) | b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.9) bright += 1;
      n += 1;
    }
  }
  let top = 0;
  for (const v of counts.values()) if (v > top) top = v;
  return { oneColour: n ? top / n : 1, bright: n ? bright / n : 0, blank: n === 0 || top / n >= 0.995, white: n > 0 && bright / n > 0.5 };
}
