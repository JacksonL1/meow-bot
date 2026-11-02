"use strict";
// 生成 src-tauri/icons/icon.ico（Windows 资源）+ tray.png（托盘）。
// 不引第三方库：PNG 用 zlib 手编，ICO 用 PNG 内嵌（Vista+ 支持）。
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const W = size, H = size;
  const px = Buffer.alloc(W * H * 4); // RGBA
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const S = size / 256; // 以 256 为设计基准
  const inTri = (x, y, ax, ay, bx, by, cx, cy) => {
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  const FUR = [245, 239, 230], EAR = [226, 214, 201], DARK = [43, 58, 85], PINK = [224, 158, 158];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = x / S, fy = y / S;
      // 耳朵（两片三角，先画，被头盖住根部）
      const leftEar = inTri(fx, fy, 66, 96, 96, 26, 132, 92);
      const rightEar = inTri(fx, fy, 190, 96, 160, 26, 124, 92);
      if (leftEar || rightEar) { set(x, y, ...EAR); continue; }
      // 头：圆心 (128,146) 半径 96
      const dx = fx - 128, dy = fy - 146;
      if (dx * dx + dy * dy <= 96 * 96) {
        // 眼睛
        const e1 = (fx - 102) ** 2 + (fy - 138) ** 2 <= 15 * 15;
        const e2 = (fx - 154) ** 2 + (fy - 138) ** 2 <= 15 * 15;
        if (e1 || e2) { set(x, y, ...DARK); continue; }
        // 鼻子（小三角）
        if (inTri(fx, fy, 120, 166, 136, 166, 128, 178)) { set(x, y, ...PINK); continue; }
        set(x, y, ...FUR);
        continue;
      }
      set(x, y, 0, 0, 0, 0);
    }
  }

  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const imgs = sizes.map((s) => ({ s, data: png(s) }));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(imgs.length, 4);
  const entries = [];
  let offset = 6 + 16 * imgs.length;
  for (const im of imgs) {
    const e = Buffer.alloc(16);
    e[0] = im.s >= 256 ? 0 : im.s;
    e[1] = im.s >= 256 ? 0 : im.s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(im.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.data.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...imgs.map((i) => i.data)]);
}

const dir = path.join(__dirname, "..", "src-tauri", "icons");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "icon.ico"), ico([16, 32, 48, 64, 256]));
fs.writeFileSync(path.join(dir, "tray.png"), png(32));
fs.writeFileSync(path.join(dir, "icon.png"), png(256));
console.log("[icons] 写出 icon.ico / tray.png / icon.png 到", dir);
