/* app.js — UI, canvas rendering and exports. Image math lives in core.js (BinaryCore). */
(function () {
  "use strict";
  const C = window.BinaryCore;
  const $ = (id) => document.getElementById(id);

  const SITE_URL = "learnwithhamasa.github.io/binary-portrait";
  const MAX_SOURCE = 1200;          // working resolution (longest side)
  const CELL_ASPECT = 1.5;          // cell = 2k wide x 3k tall
  const MAX_CANVAS_AREA = 16e6;     // stay under mobile Safari's canvas limit
  const NAVY = "#111820", AMBER = "#e8a80c", ZERO = "#dedede", ONE = "#000000";
  const DEFAULTS = { cols: 140, mode: "dither", bright: 0, contrast: 1.15, invert: false };

  let src = null;                   // { gray, alpha, width, height }
  let cache = {};                   // CLAHE results per invert setting
  let matrix = null;                // current { rows, cols, data }
  let mode = DEFAULTS.mode;
  let zoomCenter = { x: 0.5, y: 0.33 };   // fraction of the image
  let pending = false;

  const mark = new Image();          // logo mark only, amber, transparent background (for navy bands)
  mark.src = "assets/mark.png";
  const markNavy = new Image();      // same mark in navy, used for the watermark over the art
  markNavy.src = "assets/mark-navy.png";
  const fontsReady = Promise.all([
    document.fonts.load('800 40px "JetBrains Mono"'),
    document.fonts.load('400 40px "JetBrains Mono"'),
    document.fonts.load('800 40px "Cairo"'),
  ]).catch(() => {});

  // ---------------------------------------------------------------- settings
  function settings() {
    const bright = +$("bright").value;
    return {
      cols: +$("cols").value,
      mode,
      contrast: +$("contrast").value,
      gamma: 1.4 * Math.pow(2, -bright / 40),   // brighter slider -> lower gamma
      sharpen: 1.0,
      invert: $("invert").checked,
      cellAspect: CELL_ASPECT,
    };
  }

  // ---------------------------------------------------------------- glyph tiles
  const tileCache = new Map();
  /** Two pre-rendered cells for size k: "1" bold black, "0" light gray. */
  function tiles(k) {
    if (tileCache.has(k)) return tileCache.get(k);
    const w = 2 * k, h = 3 * k;
    const make = (ch, weight, color, stroke) => {
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${weight} ${Math.round(h * 0.82)}px "JetBrains Mono", monospace`;
      ctx.textBaseline = "alphabetic";
      const m = ctx.measureText(ch);
      const L = m.actualBoundingBoxLeft, R = m.actualBoundingBoxRight;
      const A = m.actualBoundingBoxAscent, D = m.actualBoundingBoxDescent;
      const x = (w - (L + R)) / 2 + L, y = (h - (A + D)) / 2 + A;   // exact ink-box centering
      ctx.fillStyle = color;
      ctx.fillText(ch, x, y);
      if (stroke > 0) {
        ctx.strokeStyle = color; ctx.lineWidth = stroke; ctx.lineJoin = "round";
        ctx.strokeText(ch, x, y);
      }
      return cv;
    };
    // Stroke thickens "1" so black areas read as dark even at small cell sizes
    const t = [make("0", 400, ZERO, 0), make("1", 800, ONE, Math.max(1, w * 0.12))];
    tileCache.set(k, t);
    return t;
  }

  /** Draw the matrix: one digit per cell, read straight from the data. */
  function drawGrid(ctx, m, x0, y0, k, r0 = 0, c0 = 0, rows = m.rows, cols = m.cols) {
    const t = tiles(k), w = 2 * k, h = 3 * k;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = m.data[(r0 + r) * m.cols + (c0 + c)];
        ctx.drawImage(t[v], x0 + c * w, y0 + r * h);
      }
    }
  }

  // ---------------------------------------------------------------- watermark
  /**
   * Watermark baked into the pixels of the art itself: diagonal rows of the navy logo mark tiled
   * over the whole area (cropping can't remove it), and one larger mark near the bottom.
   * scale = tile mark size as a fraction of the area's shorter side.
   */
  function drawWatermark(ctx, x, y, w, h, scale = 0.05, stamp = true) {
    const fs = Math.max(8, Math.round(Math.min(w, h) * scale));
    const R = Math.hypot(w, h) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(-Math.PI / 7);
    const tw = fs * 4.2, lh = fs * 3.2;                    // tile spacing
    ctx.globalAlpha = 0.22;
    for (let row = 0, yy = -R; yy <= R + lh; yy += lh, row++) {
      for (let xx = -R - (row % 2) * tw / 2; xx <= R; xx += tw) {
        ctx.drawImage(markNavy, xx, yy - fs / 2, fs, fs);
      }
    }
    ctx.restore();
    if (!stamp) return;

    // One stronger mark, centered near the bottom of the art (white glow keeps it readable on black "1"s)
    const s = Math.round(Math.min(w, h) * 0.1);
    ctx.save();
    ctx.shadowColor = "rgba(255,255,255,0.95)";
    ctx.shadowBlur = s * 0.12;
    ctx.globalAlpha = 0.92;
    ctx.drawImage(markNavy, x + (w - s) / 2, y + h - s - h * 0.04, s, s);
    ctx.restore();
  }

  // ---------------------------------------------------------------- live preview
  function schedule() {
    if (pending || !src) return;
    pending = true;
    requestAnimationFrame(async () => {
      await fontsReady;
      pending = false;
      matrix = C.buildMatrix(src, settings(), cache);
      drawPreview();
      drawZoom();
    });
  }

  function zoomWindow() {
    const zc = Math.min(28, matrix.cols), zr = Math.min(10, matrix.rows);
    const c0 = Math.max(0, Math.min(matrix.cols - zc, Math.round(zoomCenter.x * matrix.cols - zc / 2)));
    const r0 = Math.max(0, Math.min(matrix.rows - zr, Math.round(zoomCenter.y * matrix.rows - zr / 2)));
    return { c0, r0, zc, zr };
  }

  function drawPreview() {
    const cv = $("preview");
    const cssW = cv.parentElement.clientWidth - 32;
    const k = Math.max(1, Math.round((cssW * (window.devicePixelRatio || 1)) / matrix.cols / 2));
    cv.width = matrix.cols * 2 * k;
    cv.height = matrix.rows * 3 * k;
    const ctx = cv.getContext("2d");
    drawGrid(ctx, matrix, 0, 0, k);
    drawWatermark(ctx, 0, 0, cv.width, cv.height);
    // Outline the zoomed area
    const { c0, r0, zc, zr } = zoomWindow();
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = Math.max(2, k);
    ctx.strokeRect(c0 * 2 * k, r0 * 3 * k, zc * 2 * k, zr * 3 * k);
  }

  function drawZoom() {
    const { c0, r0, zc, zr } = zoomWindow();
    const k = 20;
    const cv = $("zoom");
    cv.width = zc * 2 * k;
    cv.height = zr * 3 * k;
    const ctx = cv.getContext("2d");
    drawGrid(ctx, matrix, 0, 0, k, r0, c0, zr, zc);
    drawWatermark(ctx, 0, 0, cv.width, cv.height, 0.16, false);
  }

  // ---------------------------------------------------------------- loading
  function loadFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * s));
      const h = Math.max(1, Math.round(img.naturalHeight * s));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      src = C.toGray(ctx.getImageData(0, 0, w, h).data, w, h);
      cache = {};
      zoomCenter = { x: 0.5, y: 0.33 };
      URL.revokeObjectURL(url);
      $("work").hidden = false;
      $("drop").classList.add("compact");
      schedule();
      $("work").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); alert("مش عارفين نفتح الصورة دي، جرّب صورة تانية."); };
    img.src = url;
  }

  // ---------------------------------------------------------------- exports
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Logo badge + site link, centered in a band of height bandH starting at y. */
  function drawBrand(ctx, W, y, bandH) {
    const size = Math.round(bandH * 0.55);
    ctx.font = `600 ${Math.round(size * 0.42)}px "JetBrains Mono", monospace`;
    const textW = ctx.measureText(SITE_URL).width;
    const gap = size * 0.3;
    const x = (W - (size + gap + textW)) / 2;
    const cy = y + bandH / 2;
    ctx.drawImage(mark, x, cy - size / 2, size, size);
    ctx.fillStyle = "#c9d2db";
    ctx.textAlign = "left";
    ctx.direction = "ltr";
    ctx.textBaseline = "middle";
    ctx.fillText(SITE_URL, x + size + gap, cy);
  }

  /** Social layout (story / square): navy frame, title, white card with the grid, brand footer. */
  function renderSocial(W, H) {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = NAVY;
    ctx.fillRect(0, 0, W, H);

    const pad = Math.round(W * 0.055);
    const titleSize = Math.round(Math.min(W, H) * 0.055);
    const headerH = Math.round(titleSize * 3.2);
    const footerH = Math.round(Math.min(W, H) * 0.12);

    // Title (Arabic, RTL)
    ctx.direction = "rtl";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${titleSize}px "Cairo", sans-serif`;
    ctx.fillText("صورتي بالـ 0 و 1", W / 2, pad + titleSize * 0.9);
    ctx.font = `600 ${Math.round(titleSize * 0.5)}px "Cairo", sans-serif`;
    ctx.fillStyle = AMBER;
    ctx.fillText("1 = أسود  ·  0 = أبيض  ·  كل خانة = بكسل", W / 2, pad + titleSize * 2.25);

    // White card with the grid, as large as fits
    const cardX = pad, cardY = pad + headerH, cardW = W - 2 * pad, cardH = H - cardY - footerH - pad * 0.5;
    const inner = Math.round(pad * 0.4);
    const k = Math.max(1, Math.floor(Math.min((cardW - 2 * inner) / (matrix.cols * 2), (cardH - 2 * inner) / (matrix.rows * 3))));
    const gw = matrix.cols * 2 * k, gh = matrix.rows * 3 * k;
    const bw = gw + 2 * inner, bh = gh + 2 * inner;
    const bx = Math.round((W - bw) / 2);

    // Spare vertical space (tall formats): add a zoomed strip of the real digits below
    const gap = Math.round(pad * 0.9), labelH = Math.round(titleSize * 0.9);
    const spare = cardH - bh - gap - labelH;
    const k2 = Math.floor((cardW - 2 * inner) / (Math.min(20, matrix.cols) * 2));
    const zr = Math.min(12, Math.floor((spare - 2 * inner) / (3 * k2)));
    const withZoom = zr >= 3;
    const blockH = withZoom ? bh + gap + labelH + zr * 3 * k2 + 2 * inner : bh;
    const by = Math.round(cardY + (cardH - blockH) / 2);

    ctx.fillStyle = "#fff";
    roundRect(ctx, bx, by, bw, bh, inner);
    ctx.fill();
    drawGrid(ctx, matrix, bx + inner, by + inner, k);
    drawWatermark(ctx, bx, by, bw, bh);

    if (withZoom) {
      const zc = Math.min(20, matrix.cols);
      const c0 = Math.max(0, Math.min(matrix.cols - zc, Math.round(zoomCenter.x * matrix.cols - zc / 2)));
      const r0 = Math.max(0, Math.min(matrix.rows - zr, Math.round(zoomCenter.y * matrix.rows - zr / 2)));
      // Outline the zoomed area on the full grid
      ctx.strokeStyle = AMBER;
      ctx.lineWidth = Math.max(3, k);
      ctx.strokeRect(bx + inner + c0 * 2 * k, by + inner + r0 * 3 * k, zc * 2 * k, zr * 3 * k);

      const ly = by + bh + gap;
      ctx.direction = "rtl";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = AMBER;
      ctx.font = `600 ${Math.round(titleSize * 0.5)}px "Cairo", sans-serif`;
      ctx.fillText("🔍 مكبّرة: كل رقم هنا = بكسل واحد من الصورة", W / 2, ly + labelH / 2);

      const zw = zc * 2 * k2 + 2 * inner, zh = zr * 3 * k2 + 2 * inner;
      const zx = Math.round((W - zw) / 2), zy = ly + labelH;
      ctx.fillStyle = "#fff";
      roundRect(ctx, zx, zy, zw, zh, inner);
      ctx.fill();
      drawGrid(ctx, matrix, zx + inner, zy + inner, k2, r0, c0, zr, zc);
      drawWatermark(ctx, zx, zy, zw, zh, 0.13, false);
    }

    drawBrand(ctx, W, H - footerH - pad * 0.3, footerH);
    return cv;
  }

  /** Full-resolution grid (≥4K wide when possible) on pure white + slim brand band. */
  function renderFull() {
    const margin = 2;
    let k = Math.ceil(3840 / ((matrix.cols + 2 * margin) * 2));
    const area = (kk) => (matrix.cols + 2 * margin) * 2 * kk * ((matrix.rows + 2 * margin) * 3 * kk * 1.08);
    while (k > 1 && area(k) > MAX_CANVAS_AREA) k--;
    const W = (matrix.cols + 2 * margin) * 2 * k;
    const gridH = (matrix.rows + 2 * margin) * 3 * k;
    const bandH = Math.round(W * 0.07);
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = gridH + bandH;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, gridH);
    drawGrid(ctx, matrix, margin * 2 * k, margin * 3 * k, k);
    drawWatermark(ctx, 0, 0, W, gridH);
    ctx.fillStyle = NAVY;
    ctx.fillRect(0, gridH, W, bandH);
    drawBrand(ctx, W, gridH, bandH);
    return cv;
  }

  async function deliver(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "صورتي بالـ 0 و 1" }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function exportAs(kind, button) {
    if (!matrix) return;
    const status = $("status");
    button.disabled = true;
    status.textContent = "بنجهّزها…";
    try {
      await fontsReady;
      await Promise.all([mark, markNavy].map((im) => im.complete || new Promise((r) => { im.onload = im.onerror = r; })));
      await new Promise((r) => setTimeout(r, 30));   // let the status paint first
      if (kind === "txt") {
        await deliver(new Blob([C.matrixToTxt(matrix)], { type: "text/plain" }), "binary_matrix.txt");
      } else {
        const cv = kind === "story" ? renderSocial(2160, 3840)
                 : kind === "square" ? renderSocial(3840, 3840)
                 : renderFull();
        const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
        if (!blob) throw new Error("toBlob failed");
        await deliver(blob, `binary-portrait-${kind}.png`);
      }
      status.textContent = "تم ✓ شيّرها واعمل منشن لـ حماصه 💛";
    } catch (e) {
      console.error(e);
      status.textContent = "حصلت مشكلة وإحنا بنجهّزها — جرّب دقة أقل.";
    } finally {
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- events
  $("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); loadFile(e.dataTransfer.files[0]); });

  $("cols").addEventListener("input", () => { $("colsOut").textContent = $("cols").value; schedule(); });
  ["bright", "contrast", "invert"].forEach((id) => $(id).addEventListener("input", schedule));

  document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".seg button").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-checked", x === b);
    });
    schedule();
  }));

  $("reset").addEventListener("click", () => {
    $("cols").value = DEFAULTS.cols; $("colsOut").textContent = DEFAULTS.cols;
    $("bright").value = DEFAULTS.bright; $("contrast").value = DEFAULTS.contrast;
    $("invert").checked = DEFAULTS.invert;
    document.querySelector('.seg button[data-mode="dither"]').click();
  });
  $("another").addEventListener("click", () => $("file").click());

  $("preview").addEventListener("click", (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    zoomCenter = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    drawPreview();
    drawZoom();
  });

  document.querySelectorAll("[data-export]").forEach((b) =>
    b.addEventListener("click", () => exportAs(b.dataset.export, b)));

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => matrix && drawPreview(), 150);
  });
})();
