/**
 * Draws the extension's icon (two stacked envelopes on a rounded blue square) and encodes it as a
 * PNG, so the repository needs no binary file and no image tooling.
 */
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Distance from a point to the segment a-b. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x1 - r, x));
  const cy = Math.max(y0 + r, Math.min(y1 - r, y));
  return Math.hypot(x - cx, y - cy) <= r;
}

const BG = [37, 99, 235];
const PAPER = [255, 255, 255];
const BACK = [191, 219, 254];

/** The colour at a point of the 1×1 design (null: transparent). */
function paint(x, y) {
  if (!inRoundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.2)) return null;
  const envelope = (ox, oy, w, h, fill) => {
    if (x < ox || x > ox + w || y < oy || y > oy + h) return null;
    const flap = segDist(x, y, ox, oy, ox + w / 2, oy + h * 0.55) < 0.022 || segDist(x, y, ox + w, oy, ox + w / 2, oy + h * 0.55) < 0.022;
    return flap ? BG : fill;
  };
  return envelope(0.2, 0.42, 0.62, 0.4, PAPER) ?? envelope(0.3, 0.2, 0.52, 0.34, BACK) ?? BG;
}

export function makeIcon(size = 512) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = paint((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round((255 * a) / (ss * ss));
      }
    }
  }
  return encodePng(size, rgba);
}
