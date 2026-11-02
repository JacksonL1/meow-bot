"use strict";
// 生成 src-tauri/icons/icon.ico（Windows 资源）+ tray.png（托盘）+ icon.png。
// 不引第三方库：PNG 用 zlib 手编，ICO 用 PNG 内嵌（Vista+ 支持）。
//
// ---- 为什么要超采样 ----
// 上一版是"每个像素问一次点在不在形状里"，非黑即白。在 256px 上看没问题，
// 但托盘图标真正被用到的尺寸是 16~24px：那时猫脸的半径只有 6 个像素，
// 边缘全是一格一格的台阶，耳朵退化成两块直角三角——远看像颗花椰菜。
//
// 修法不是"画得更大"（尺寸是系统定的，改不了），是**先在 4 倍分辨率上判覆盖，
// 再按覆盖率平均**。256 设计坐标 → 每条边都能落在 1/4 像素上，缩小后是灰阶过渡。
//
// ---- 为什么小尺寸要另一套几何 ----
// 抗锯齿解决"锯齿"，解决不了"特征小于一个像素"。16px 时眼白（半径 15 设计单位）
// 只有 0.94px，抗锯齿把它摊成一层雾，整张脸就只剩一个圆。
// 所以 ≤24px 走 simplify：眼睛放大、去掉鼻子、耳朵加厚——把"能认出是猫"
// 的那几个特征保住，细节全部让位。
//
// 降采样必须用**预乘 alpha**：透明像素的 RGB 是 (0,0,0)，
// 直接平均会把黑边混进轮廓里（半透明边缘发灰发脏）；先乘 a、平均后再除回去才对。

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

// 设计坐标系恒为 256×256，与实际输出尺寸无关。
const FUR = [246, 240, 231];
const EAR = [228, 216, 204];
const EAR_IN = [214, 178, 178];
const DARK = [42, 56, 82];
const PINK = [224, 158, 158];
const SHADE = [228, 219, 208];

function inTri(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// 返回设计坐标 (fx, fy) 处该画什么：null = 透明，否则 [r,g,b]
function sample(fx, fy, small) {
  // 小尺寸的几何：耳朵往外挪、放大，眼睛放大，没有鼻子。
  const ear = small
    ? { l: [58, 100, 94, 14, 140, 96], r: [198, 100, 162, 14, 116, 96] }
    : { l: [66, 96, 96, 26, 132, 92], r: [190, 96, 160, 26, 124, 92] };
  const le = ear.l, re = ear.r;

  // 耳朵先画，头会盖住根部，露出的是两个尖
  if (inTri(fx, fy, le[0], le[1], le[2], le[3], le[4], le[5]) || inTri(fx, fy, re[0], re[1], re[2], re[3], re[4], re[5])) {
    // 耳朵里侧的内耳：只在够大的尺寸画，否则是噪点
    if (!small && (inTri(fx, fy, 74, 92, 96, 40, 122, 90) || inTri(fx, fy, 182, 92, 160, 40, 134, 90))) {
      return EAR_IN;
    }
    return EAR;
  }

  const dx = fx - 128;
  const dy = fy - 146;
  const r = small ? 100 : 96;
  if (dx * dx + dy * dy > r * r) return null;

  const eyeR = small ? 24 : 15;
  const eyeY = small ? 134 : 138;
  const eyeDX = small ? 34 : 26;
  if ((fx - (128 - eyeDX)) ** 2 + (fy - eyeY) ** 2 <= eyeR * eyeR) return DARK;
  if ((fx - (128 + eyeDX)) ** 2 + (fy - eyeY) ** 2 <= eyeR * eyeR) return DARK;

  if (!small) {
    if (inTri(fx, fy, 120, 166, 136, 166, 128, 178)) return PINK;
    // 下巴一层浅影：给 256px 的脸一点体积，不然是个纯色圆盘
    if (dy > 40) return SHADE;
  }
  return FUR;
}

const SS = 4; // 每边 4 个样本 → 16 次/像素，够平了；再高只是编译时间

function png(size) {
  const W = size;
  const H = size;
  const out = Buffer.alloc(W * H * 4);
  const small = size <= 24; // 特征塞不下的时候换几何，见文件头
  const scale = 256 / size;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) * scale;
          const fy = (y + (sy + 0.5) / SS) * scale;
          const c = sample(fx, fy, small);
          if (!c) continue;
          ar += c[0];
          ag += c[1];
          ab += c[2];
          aa += 1;
        }
      }
      const i = (y * W + x) * 4;
      if (aa === 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
        continue;
      }
      // 未覆盖的样本按"透明"参与平均，所以覆盖率就是 alpha
      const n = SS * SS;
      out[i] = Math.round(ar / aa);
      out[i + 1] = Math.round(ag / aa);
      out[i + 2] = Math.round(ab / aa);
      out[i + 3] = Math.round((aa / n) * 255);
    }
  }

  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter type 0
    out.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
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
const sizes = [16, 20, 24, 32, 48, 64, 256];
fs.writeFileSync(path.join(dir, "icon.ico"), ico(sizes));
fs.writeFileSync(path.join(dir, "tray.png"), png(32));
fs.writeFileSync(path.join(dir, "icon.png"), png(256));
console.log("[icons] 写出 icon.ico（" + sizes.join("/") + "）/ tray.png(32) / icon.png(256) 到", dir);
