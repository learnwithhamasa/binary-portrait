"""
binary_image.py — Turn a photograph into a TRUE 1-bit binary typography image.

Educational convention (used everywhere in this script):
    1 = Black pixel
    0 = White pixel

Every character drawn in the output images is read directly from the binary
matrix that is also exported to TXT. Nothing is random or decorative.

Note for the video: this is a simplified 1-bit monochrome encoding (1 bit per
pixel, only black or white). Real grayscale images usually use 8 bits per pixel
(256 shades), and color images typically use 24 bits per pixel (8 bits each for
Red, Green and Blue).

Install:
    python -m pip install opencv-python pillow numpy

Run:
    python binary_image.py --input photo.png              # results -> <photo folder>/binary_output
    python binary_image.py --input photo.png --cols 240   # override grid width
    python binary_image.py --input other.jpg --output out_dir --cols 120
"""

import argparse
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# =============================================================================
# CONFIGURATION — edit these values
# =============================================================================
INPUT_PATH = "F:/Hamasa/Reels/E7/content/trika.png"   # PNG with transparency: transparent = white (0)
OUTPUT_DIR = None                   # None = "binary_output" next to the input image

# Grid resolution: number of binary pixels (characters) per row.
# Try 80, 120, 160, 240. Rows are computed automatically from the aspect ratio.
GRID_COLS = 160

# Final render width in pixels (3840 = 4K UHD). Cell size is derived from it,
# so every grid size still exports at >= 4K.
TARGET_WIDTH = 3840
MARGIN_CELLS = 2                     # white border around the grid, in cells

# Fonts (any monospaced TTF). Bold font is used for "1", regular for "0".
FONT_REGULAR = r"C:\Windows\Fonts\consola.ttf"
FONT_BOLD = r"C:\Windows\Fonts\consolab.ttf"
FONT_SCALE = 0.95                    # glyph height relative to the cell height
ONE_STROKE = 0.06                    # extra thickness for "1" (fraction of cell width, 0 = off)

# Cell shape = cell height / cell width. Digits are tall and narrow, so 1.5
# packs them densely (darker, more readable image). Rows are reduced by the same
# factor, so the photo's aspect ratio is always preserved. 1.0 = square cells.
CELL_ASPECT = 1.5

# Colors
BG_COLOR = (255, 255, 255)           # pure white background
ONE_COLOR = (0, 0, 0)                # "1" = black pixel -> bold black digit
ZERO_COLOR = (222, 222, 222)         # "0" = white pixel -> very light gray digit

# Faint grid lines
SHOW_GRID_LINES = False
GRID_LINE_COLOR = (238, 238, 238)

# Preprocessing (applied to the grayscale image before binarization)
USE_CLAHE = True                     # local contrast enhancement (faces!)
CLAHE_CLIP = 3.0
CLAHE_TILES = 8
CONTRAST = 1.15                      # 1.0 = unchanged, >1 more contrast
BRIGHTNESS = 0                       # added after contrast (-255..255)
GAMMA = 1.4                          # <1 brightens midtones, >1 darkens
SHARPEN = 1.0                        # unsharp-mask amount on the grid image (0 = off)

# Thresholding method for the plain black/white version:
#   "otsu"      automatic global threshold (good default)
#   "adaptive"  local threshold — keeps edges/features, more texture
#   "fixed"     uses FIXED_THRESHOLD
THRESHOLD_METHOD = "otsu"
FIXED_THRESHOLD = 128
ADAPTIVE_BLOCK = 15                  # odd number, in grid pixels
ADAPTIVE_C = 4

# Floyd–Steinberg dithering for the dithered version
DITHER_SERPENTINE = True             # alternate scan direction (fewer artifacts)

# Close-up (05): size of the crop in cells, and render width
CLOSEUP_COLS = 40
CLOSEUP_WIDTH = 3840
# Close-up center as (x, y) fractions of the image, or None = auto face detection
# (Haar cascade; falls back to the upper-center if unavailable in your OpenCV build)
CLOSEUP_CENTER = (0.43, 0.30)
# =============================================================================


def load_grayscale(path):
    """Load with Pillow, convert with OpenCV.

    Returns (gray, alpha). Transparent areas are composited onto white, and
    alpha (0..255) is kept so those areas can be forced to 0 = white later.
    """
    pil = Image.open(path).convert("RGBA")
    rgba = np.array(pil)
    alpha = rgba[..., 3]
    white = np.full_like(rgba[..., :3], 255)
    a = (alpha[..., None] / 255.0)
    rgb = (rgba[..., :3] * a + white * (1 - a)).astype(np.uint8)
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), alpha


def enhance(gray):
    """Optional contrast enhancement to preserve facial details."""
    out = gray.copy()
    if USE_CLAHE:
        clahe = cv2.createCLAHE(clipLimit=CLAHE_CLIP,
                                tileGridSize=(CLAHE_TILES, CLAHE_TILES))
        out = clahe.apply(out)
    out = cv2.convertScaleAbs(out, alpha=CONTRAST, beta=BRIGHTNESS)
    if GAMMA != 1.0:
        lut = np.array([((i / 255.0) ** GAMMA) * 255 for i in range(256)],
                       dtype=np.uint8)
        out = cv2.LUT(out, lut)
    return out


def grid_shape(img_h, img_w, cols):
    """Rows so that (cols x rows) cells reproduce the original aspect ratio."""
    rows = round(cols * (img_h / img_w) / CELL_ASPECT)
    return rows, cols


def downsample(gray, rows, cols):
    """Each grid cell = exactly one sampled pixel (area average of its region)."""
    return cv2.resize(gray, (cols, rows), interpolation=cv2.INTER_AREA)


def to_binary_threshold(small):
    """Return matrix with 1 = black, 0 = white."""
    if THRESHOLD_METHOD == "otsu":
        _, bw = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    elif THRESHOLD_METHOD == "adaptive":
        bw = cv2.adaptiveThreshold(small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                   cv2.THRESH_BINARY, ADAPTIVE_BLOCK, ADAPTIVE_C)
    else:
        _, bw = cv2.threshold(small, FIXED_THRESHOLD, 255, cv2.THRESH_BINARY)
    # bw: 255 = white, 0 = black  ->  1 = black, 0 = white
    return (bw == 0).astype(np.uint8)


def to_binary_dithered(small):
    """Floyd–Steinberg error diffusion. Output is strictly 0/1 (1 = black)."""
    img = small.astype(np.float32)
    h, w = img.shape
    out = np.zeros((h, w), dtype=np.uint8)
    for y in range(h):
        reverse = DITHER_SERPENTINE and (y % 2 == 1)
        xs = range(w - 1, -1, -1) if reverse else range(w)
        d = -1 if reverse else 1      # direction of "forward" neighbor
        for x in xs:
            old = img[y, x]
            new = 255.0 if old >= 128 else 0.0
            out[y, x] = 0 if new == 255.0 else 1
            err = old - new
            if 0 <= x + d < w:
                img[y, x + d] += err * 7 / 16
            if y + 1 < h:
                if 0 <= x - d < w:
                    img[y + 1, x - d] += err * 3 / 16
                img[y + 1, x] += err * 5 / 16
                if 0 <= x + d < w:
                    img[y + 1, x + d] += err * 1 / 16
    return out


def matrix_to_image(matrix):
    """1-bit PIL image from the matrix (1 = black -> pixel 0)."""
    return Image.fromarray(((1 - matrix) * 255).astype(np.uint8)).convert("1")


def make_tiles(cell_w, cell_h):
    """Pre-render the two glyph tiles once: index 0 -> '0', index 1 -> '1'."""
    size = max(6, int(cell_h * FONT_SCALE))
    font_r = ImageFont.truetype(FONT_REGULAR, size)
    font_b = ImageFont.truetype(FONT_BOLD, size)
    tiles = []
    for ch, font, color in (("0", font_r, ZERO_COLOR), ("1", font_b, ONE_COLOR)):
        tile = Image.new("RGB", (cell_w, cell_h), BG_COLOR)
        draw = ImageDraw.Draw(tile)
        # Center the glyph's ink box precisely in the cell
        l, t, r, b = draw.textbbox((0, 0), ch, font=font)
        x = (cell_w - (r - l)) / 2 - l
        y = (cell_h - (b - t)) / 2 - t
        stroke = round(cell_w * ONE_STROKE) if ch == "1" else 0
        draw.text((x, y), ch, font=font, fill=color, stroke_width=stroke, stroke_fill=color)
        if SHOW_GRID_LINES:
            draw.line([(cell_w - 1, 0), (cell_w - 1, cell_h - 1)], fill=GRID_LINE_COLOR)
            draw.line([(0, cell_h - 1), (cell_w - 1, cell_h - 1)], fill=GRID_LINE_COLOR)
        tiles.append(np.array(tile))
    return np.stack(tiles)            # shape (2, cell_h, cell_w, 3)


def render_grid(matrix, target_width, margin_cells=MARGIN_CELLS):
    """Draw one digit per cell, read straight from the matrix."""
    rows, cols = matrix.shape
    cell_w = int(np.ceil(target_width / (cols + 2 * margin_cells)))
    cell_h = int(round(cell_w * CELL_ASPECT))
    tiles = make_tiles(cell_w, cell_h)
    # tiles[matrix] -> (rows, cols, cell_h, cell_w, 3) -> stitched image
    body = tiles[matrix].transpose(0, 2, 1, 3, 4).reshape(rows * cell_h, cols * cell_w, 3)
    mh, mw = margin_cells * cell_h, margin_cells * cell_w
    canvas = np.full((body.shape[0] + 2 * mh, body.shape[1] + 2 * mw, 3), BG_COLOR, np.uint8)
    canvas[mh:mh + body.shape[0], mw:mw + body.shape[1]] = body
    return Image.fromarray(canvas)


def find_face_center(gray, rows, cols):
    """Locate the face with OpenCV's Haar cascade; return its eye-level center in grid coords."""
    h, w = gray.shape
    if CLOSEUP_CENTER is not None:
        return int(CLOSEUP_CENTER[1] * rows), int(CLOSEUP_CENTER[0] * cols)
    faces = ()
    try:  # Haar cascades are missing from some OpenCV builds -> fall back gracefully
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(80, 80))
    except AttributeError:
        pass
    if len(faces):
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        cx, cy = x + fw / 2, y + fh * 0.42          # around the eyes
    else:
        cx, cy = w / 2, h * 0.4
    return int(cy / h * rows), int(cx / w * cols)


def save_matrix_txt(matrix, path):
    """One line per row, digits only — exactly what is drawn on screen."""
    with open(path, "w", encoding="ascii", newline="\n") as f:
        for row in matrix:
            f.write("".join("1" if v else "0" for v in row) + "\n")
    # Self-check: the file round-trips to the identical matrix
    with open(path, encoding="ascii") as f:
        back = np.array([[int(c) for c in line.strip()] for line in f if line.strip()], np.uint8)
    assert np.array_equal(back, matrix), "TXT export does not match the rendered matrix!"


def render_matrix_txt(txt_path, target_width):
    """Render the exported TXT file itself as an image: the raw data the computer stores.

    Plain monospaced text (no tone/color tricks), with row numbers on the left
    and a column ruler on top so viewers can see it is a real data matrix.
    """
    with open(txt_path, encoding="ascii") as f:
        lines = [line.strip() for line in f if line.strip()]
    rows, cols = len(lines), len(lines[0])
    gutter = len(str(rows - 1)) + 3                      # e.g. "100 │ "
    total_chars = gutter + cols + 4                      # + side padding

    # Pick the font size so the full line fits the target width
    probe = ImageFont.truetype(FONT_REGULAR, 100)
    size = int(100 * target_width / (probe.getlength("0") * total_chars))
    font = ImageFont.truetype(FONT_REGULAR, size)
    char_w = font.getlength("0")
    line_h = round(size * 1.15)
    pad_x, pad_y = 2 * char_w, 2 * line_h

    width = int(round(char_w * total_chars))
    height = int(pad_y * 2 + line_h * (rows + 2))
    img = Image.new("RGB", (width, height), BG_COLOR)
    draw = ImageDraw.Draw(img)
    data_x = pad_x + gutter * char_w
    muted = (170, 170, 170)

    # Column ruler: a tick number every 10 columns
    for c in range(0, cols, 10):
        draw.text((data_x + c * char_w, pad_y), str(c), font=font, fill=muted)
    top = pad_y + 2 * line_h
    draw.line([(data_x - char_w * 0.5, top - line_h * 0.4), (data_x + cols * char_w, top - line_h * 0.4)],
              fill=(210, 210, 210), width=max(1, size // 20))

    # Rows: row number, separator, then the exact characters from the TXT file
    for r, line in enumerate(lines):
        y = top + r * line_h
        draw.text((pad_x, y), f"{r:>{gutter - 3}} │", font=font, fill=muted)
        draw.text((data_x, y), line, font=font, fill=(25, 25, 25))
    return img


def comparison(gray, grid_img, label_left, label_right):
    """Grayscale original beside the binary typography, same height."""
    h = grid_img.height
    left = Image.fromarray(gray).convert("RGB")
    left = left.resize((round(left.width * h / left.height), h), Image.LANCZOS)
    gap = h // 20
    label_h = h // 12
    canvas = Image.new("RGB", (left.width + grid_img.width + 3 * gap, h + label_h + 2 * gap), BG_COLOR)
    canvas.paste(left, (gap, gap))
    canvas.paste(grid_img, (2 * gap + left.width, gap))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT_BOLD, label_h // 2)
    for text, x0, width in ((label_left, gap, left.width),
                            (label_right, 2 * gap + left.width, grid_img.width)):
        draw.text((x0 + width / 2, h + gap + label_h / 2), text, font=font, fill=(40, 40, 40), anchor="mm")
    return canvas


def main():
    parser = argparse.ArgumentParser(description="Binary (0/1) typography portrait")
    parser.add_argument("--input", default=INPUT_PATH)
    parser.add_argument("--output", default=OUTPUT_DIR)
    parser.add_argument("--cols", type=int, default=GRID_COLS)
    parser.add_argument("--width", type=int, default=TARGET_WIDTH)
    args = parser.parse_args()
    if args.output is None:
        args.output = os.path.join(os.path.dirname(os.path.abspath(args.input)), "binary_output")
    os.makedirs(args.output, exist_ok=True)
    out = lambda name: os.path.join(args.output, name)

    # 1) Grayscale
    gray, alpha = load_grayscale(args.input)
    Image.fromarray(gray).save(out("01_grayscale.png"))

    # 2) Preprocess + sample one pixel per grid cell
    rows, cols = grid_shape(*gray.shape, args.cols)
    small = downsample(enhance(gray), rows, cols)
    if SHARPEN > 0:  # unsharp mask at grid resolution: crisper eyes, brows, beard
        blur = cv2.GaussianBlur(small, (0, 0), 1.0)
        small = cv2.addWeighted(small, 1 + SHARPEN, blur, -SHARPEN, 0)
    background = downsample(alpha, rows, cols) < 128     # transparent cells
    small[background] = 255                              # background is pure white

    # 3) Binary matrices (1 = black, 0 = white); background cells are always 0
    m_thresh = to_binary_threshold(small)
    m_dither = to_binary_dithered(small)
    m_thresh[background] = 0
    m_dither[background] = 0

    # 02: true 1-bit image, upscaled with NEAREST so each binary pixel stays a crisp square
    bw = matrix_to_image(m_thresh)
    scale = max(1, args.width // cols)
    bw.resize((cols * scale, rows * scale), Image.NEAREST).save(out("02_black_white.png"))
    matrix_to_image(m_dither).resize((cols * scale, rows * scale), Image.NEAREST) \
        .save(out("02b_black_white_dithered.png"))

    # 03 / 04: binary typography
    grid_thresh = render_grid(m_thresh, args.width)
    grid_dither = render_grid(m_dither, args.width)
    grid_thresh.save(out("03_binary_grid.png"))
    grid_dither.save(out("04_binary_grid_dithered.png"))

    # 05: close-up around the eyes (dithered matrix), re-rendered at large cell size
    cy, cx = find_face_center(gray, rows, cols)
    cw = min(CLOSEUP_COLS, cols)
    ch = min(rows, round(cw * 9 / 16 / CELL_ASPECT))
    x0 = int(np.clip(cx - cw // 2, 0, cols - cw))
    y0 = int(np.clip(cy - ch // 2, 0, rows - ch))
    crop = m_dither[y0:y0 + ch, x0:x0 + cw]
    render_grid(crop, CLOSEUP_WIDTH, margin_cells=0).save(out("05_binary_closeup.png"))

    # 06: the actual matrices
    save_matrix_txt(m_thresh, out("06_binary_matrix.txt"))
    save_matrix_txt(m_dither, out("06b_binary_matrix_dithered.txt"))

    # 08: the TXT matrices rendered as images (read back from the files themselves)
    render_matrix_txt(out("06_binary_matrix.txt"), args.width).save(out("08_binary_matrix.png"))
    render_matrix_txt(out("06b_binary_matrix_dithered.txt"), args.width) \
        .save(out("08b_binary_matrix_dithered.png"))

    # 07: comparison
    comparison(gray, grid_dither,
               "Grayscale: 8 bits / pixel",
               "Binary: 1 bit / pixel   (1 = Black, 0 = White)").save(out("07_comparison.png"))

    print(f"Grid: {cols} x {rows} = {cols * rows} binary pixels")
    print(f"Black pixels (1): threshold={int(m_thresh.sum())}, dithered={int(m_dither.sum())}")
    print(f"Close-up rows {y0}-{y0 + ch - 1}, cols {x0}-{x0 + cw - 1} of the dithered matrix")
    print(f"Outputs written to: {os.path.abspath(args.output)}")


if __name__ == "__main__":
    main()
