import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const screenshot = require("screenshot-desktop");
const sharp = require("sharp");

export async function captureJpeg() {
  const img = await screenshot({ format: "jpg" });
  const buf = Buffer.isBuffer(img) ? img : Buffer.from(img);
  return sharp(buf)
    .resize({ width: 960, withoutEnlargement: true })
    .jpeg({ quality: 42, mozjpeg: true })
    .toBuffer();
}
