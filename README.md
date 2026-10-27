# صورتك بالـ 0 و 1 — Binary Portrait

**جرّبها:** https://learnwithhamasa.github.io/binary-portrait/

حوّل أي صورة إلى أصفار وآحاد كما يراها الكمبيوتر:
**1 = أسود · 0 = أبيض · كل خانة = بكسل واحد** (صورة 1-بت).
مجانية بالكامل، وصورتك لا تُرفع لأي سيرفر — كل المعالجة تتم داخل المتصفح.

---

Turn any photo into a true 1-bit binary portrait made of real `0` and `1` characters.
Every digit is an actual pixel (1 = black, 0 = white); nothing is random or decorative.

- Grayscale → CLAHE contrast → contrast/gamma → area downsample → unsharp → Otsu threshold or Floyd–Steinberg dithering
- Exports: 9:16 story (2160×3840), 1:1 post (3840×3840), full 4K grid, and the raw matrix as TXT
- 100% client-side static site (HTML/CSS/JS, no build step), hosted free on GitHub Pages

Note: this is a simplified educational encoding (1 bit per pixel). Real grayscale images
typically use 8 bits per pixel and color images 24 bits.

Made by **حماسة (Hamasa)**.
