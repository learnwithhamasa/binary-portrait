# حوّل أي صورة لأصفار ووحايد — Binary Portrait

**جرّبها:** https://learnwithhamasa.github.io/binary-portrait/

حوّل أي صورة لأصفار ووحايد زي ما الكمبيوتر بيشوفها:
**1 = أسود · 0 = أبيض · كل خانة = بكسل واحد** (صورة 1-بت).
ببلاش خالص، وصورتك مش بتترفع على أي سيرفر — كل حاجة بتحصل جوه المتصفح.

---

Turn any photo into a true 1-bit binary portrait made of real `0` and `1` characters.
Every digit is an actual pixel (1 = black, 0 = white); nothing is random or decorative.

- Grayscale → CLAHE contrast → contrast/gamma → area downsample → unsharp → Otsu threshold or Floyd–Steinberg dithering
- Exports: 9:16 story (2160×3840), 1:1 post (3840×3840), full 4K grid, and the raw matrix as TXT
- 100% client-side static site (HTML/CSS/JS, no build step), hosted free on GitHub Pages

Note: this is a simplified educational encoding (1 bit per pixel). Real grayscale images
typically use 8 bits per pixel and color images 24 bits.

Made by **حماصه (Hamasa)**.

## Project structure

```
index.html, style.css     the website (served by GitHub Pages)
js/core.js                image → 0/1 matrix (pure functions, also runs in Node)
js/app.js                 UI, preview, watermark, exports
assets/                   logo, watermark marks, favicon, share image
python/binary_image.py    offline generator for the reel (4K images + TXT matrix)
```

Python: `python -m pip install opencv-python pillow numpy`, then
`python python/binary_image.py --input photo.png` (results go to `binary_output/` next to the photo).
