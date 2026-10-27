/*
 * core.js — pure image functions (no DOM), ported from binary_image.py.
 *
 * Convention used everywhere:  1 = Black pixel,  0 = White pixel.
 * A matrix is { rows, cols, data: Uint8Array(rows * cols) } in row-major order.
 */
(function (root) {
  "use strict";

  /** RGBA bytes -> { gray, alpha } (Rec.601 like OpenCV). Transparent areas are composited onto white. */
  function toGray(rgba, width, height) {
    const n = width * height;
    const gray = new Uint8Array(n);
    const alpha = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const a = rgba[p + 3] / 255;
      const g = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      gray[i] = Math.round(g * a + 255 * (1 - a));
      alpha[i] = rgba[p + 3];
    }
    return { gray, alpha, width, height };
  }

  /** CLAHE (contrast limited adaptive histogram equalization), same idea as cv2.createCLAHE. */
  function clahe(gray, width, height, clipLimit = 3.0, tiles = 8) {
    const tw = width / tiles, th = height / tiles;
    const luts = [];
    for (let ty = 0; ty < tiles; ty++) {
      for (let tx = 0; tx < tiles; tx++) {
        const x0 = Math.floor(tx * tw), x1 = Math.floor((tx + 1) * tw);
        const y0 = Math.floor(ty * th), y1 = Math.floor((ty + 1) * th);
        const hist = new Uint32Array(256);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) hist[gray[y * width + x]]++;
        }
        const area = Math.max(1, (x1 - x0) * (y1 - y0));
        // Clip the histogram and redistribute the excess evenly
        const limit = Math.max(1, Math.floor(clipLimit * area / 256));
        let excess = 0;
        for (let i = 0; i < 256; i++) {
          if (hist[i] > limit) { excess += hist[i] - limit; hist[i] = limit; }
        }
        const add = Math.floor(excess / 256);
        let rest = excess - add * 256;
        for (let i = 0; i < 256; i++) { hist[i] += add; if (rest > 0) { hist[i]++; rest--; } }
        // Cumulative distribution -> lookup table
        const lut = new Uint8Array(256);
        let sum = 0;
        for (let i = 0; i < 256; i++) { sum += hist[i]; lut[i] = Math.min(255, Math.round(sum * 255 / area)); }
        luts.push(lut);
      }
    }
    // Bilinear interpolation between the 4 nearest tile centers
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const fy = y / th - 0.5;
      const ty0 = Math.max(0, Math.min(tiles - 1, Math.floor(fy)));
      const ty1 = Math.min(tiles - 1, ty0 + 1);
      const wy = Math.max(0, Math.min(1, fy - ty0));
      for (let x = 0; x < width; x++) {
        const fx = x / tw - 0.5;
        const tx0 = Math.max(0, Math.min(tiles - 1, Math.floor(fx)));
        const tx1 = Math.min(tiles - 1, tx0 + 1);
        const wx = Math.max(0, Math.min(1, fx - tx0));
        const v = gray[y * width + x];
        const top = luts[ty0 * tiles + tx0][v] * (1 - wx) + luts[ty0 * tiles + tx1][v] * wx;
        const bot = luts[ty1 * tiles + tx0][v] * (1 - wx) + luts[ty1 * tiles + tx1][v] * wx;
        out[y * width + x] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
    return out;
  }

  /** Contrast (multiply) then gamma, via one lookup table. Gamma > 1 darkens midtones. */
  function toneCurve(gray, contrast = 1.15, gamma = 1.4) {
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const c = Math.min(255, Math.max(0, i * contrast));
      lut[i] = Math.round(Math.pow(c / 255, gamma) * 255);
    }
    const out = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = lut[gray[i]];
    return out;
  }

  /** Rows so that cols x rows cells keep the photo's aspect ratio (cellAspect = cell height / width). */
  function gridShape(height, width, cols, cellAspect = 1.5) {
    return { rows: Math.max(1, Math.round(cols * (height / width) / cellAspect)), cols };
  }

  /** Area-average downsample: each grid cell = exactly one sampled pixel (like cv2.INTER_AREA). */
  function downsample(src, width, height, rows, cols) {
    const out = new Float32Array(rows * cols);
    const sx = width / cols, sy = height / rows;
    for (let r = 0; r < rows; r++) {
      const y0 = r * sy, y1 = (r + 1) * sy;
      for (let c = 0; c < cols; c++) {
        const x0 = c * sx, x1 = (c + 1) * sx;
        let sum = 0, wsum = 0;
        for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
          const wy = Math.min(y + 1, y1) - Math.max(y, y0);
          if (wy <= 0) continue;
          for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
            const wx = Math.min(x + 1, x1) - Math.max(x, x0);
            if (wx <= 0) continue;
            sum += src[y * width + x] * wx * wy;
            wsum += wx * wy;
          }
        }
        out[r * cols + c] = sum / wsum;
      }
    }
    return out;
  }

  /** Unsharp mask at grid resolution (Gaussian sigma = 1): crisper eyes, brows, beard. */
  function sharpen(img, rows, cols, amount = 1.0) {
    if (amount <= 0) return img;
    const k = [0.00443, 0.05399, 0.24197, 0.39894, 0.24197, 0.05399, 0.00443]; // sigma 1, size 7
    const tmp = new Float32Array(img.length), blur = new Float32Array(img.length);
    const clampIdx = (v, max) => (v < 0 ? 0 : v >= max ? max - 1 : v);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0;
        for (let i = -3; i <= 3; i++) s += img[r * cols + clampIdx(c + i, cols)] * k[i + 3];
        tmp[r * cols + c] = s;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let s = 0;
        for (let i = -3; i <= 3; i++) s += tmp[clampIdx(r + i, rows) * cols + c] * k[i + 3];
        blur[r * cols + c] = s;
      }
    }
    const out = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) {
      out[i] = Math.min(255, Math.max(0, img[i] * (1 + amount) - blur[i] * amount));
    }
    return out;
  }

  /** Otsu threshold on the grid image -> 1 = black (value <= t), 0 = white. */
  function otsu(img) {
    const hist = new Float64Array(256);
    for (let i = 0; i < img.length; i++) hist[Math.round(img[i])]++;
    const total = img.length;
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * hist[i];
    let wB = 0, sumB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    const out = new Uint8Array(img.length);
    for (let i = 0; i < img.length; i++) out[i] = Math.round(img[i]) <= t ? 1 : 0;
    return out;
  }

  /** Floyd–Steinberg error diffusion (serpentine). Output strictly 0/1, 1 = black. */
  function floydSteinberg(img, rows, cols) {
    const buf = Float32Array.from(img);
    const out = new Uint8Array(img.length);
    for (let y = 0; y < rows; y++) {
      const reverse = y % 2 === 1;
      const d = reverse ? -1 : 1;
      for (let i = 0; i < cols; i++) {
        const x = reverse ? cols - 1 - i : i;
        const idx = y * cols + x;
        const old = buf[idx];
        const white = old >= 128;
        out[idx] = white ? 0 : 1;
        const err = old - (white ? 255 : 0);
        if (x + d >= 0 && x + d < cols) buf[idx + d] += err * 7 / 16;
        if (y + 1 < rows) {
          if (x - d >= 0 && x - d < cols) buf[idx + cols - d] += err * 3 / 16;
          buf[idx + cols] += err * 5 / 16;
          if (x + d >= 0 && x + d < cols) buf[idx + cols + d] += err * 1 / 16;
        }
      }
    }
    return out;
  }

  /**
   * Full pipeline: source { gray, alpha, width, height } (+ cached CLAHE) -> binary matrix.
   * opts: { cols, mode: "dither" | "threshold", contrast, gamma, sharpen, invert, cellAspect }
   */
  function buildMatrix(src, opts, cache = {}) {
    const { width, height } = src;
    const key = "clahe:" + (opts.invert ? 1 : 0);
    if (!cache[key]) {
      let g = src.gray;
      if (opts.invert) {
        g = new Uint8Array(g.length);
        for (let i = 0; i < g.length; i++) g[i] = src.alpha[i] < 128 ? 255 : 255 - src.gray[i];
      }
      cache[key] = clahe(g, width, height);
    }
    const toned = toneCurve(cache[key], opts.contrast, opts.gamma);
    const { rows, cols } = gridShape(height, width, opts.cols, opts.cellAspect || 1.5);
    let small = downsample(toned, width, height, rows, cols);
    small = sharpen(small, rows, cols, opts.sharpen ?? 1.0);

    // Transparent cells are background -> pure white -> always 0
    const alphaSmall = downsample(src.alpha, width, height, rows, cols);
    const background = new Uint8Array(rows * cols);
    for (let i = 0; i < small.length; i++) {
      if (alphaSmall[i] < 128) { background[i] = 1; small[i] = 255; }
    }
    const data = opts.mode === "threshold" ? otsu(small) : floydSteinberg(small, rows, cols);
    for (let i = 0; i < data.length; i++) if (background[i]) data[i] = 0;
    return { rows, cols, data };
  }

  /** One line per row, digits only — exactly what is drawn. */
  function matrixToTxt(m) {
    const lines = [];
    for (let r = 0; r < m.rows; r++) {
      let s = "";
      for (let c = 0; c < m.cols; c++) s += m.data[r * m.cols + c] ? "1" : "0";
      lines.push(s);
    }
    return lines.join("\n") + "\n";
  }

  const api = { toGray, clahe, toneCurve, gridShape, downsample, sharpen, otsu, floydSteinberg, buildMatrix, matrixToTxt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BinaryCore = api;
})(typeof self !== "undefined" ? self : this);
