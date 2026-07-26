const sharp = require("sharp");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ICONS_DIR = path.join(__dirname, "src-tauri", "icons");
const SVG_PATH = path.join(ICONS_DIR, "icon.svg");
const svgBuffer = fs.readFileSync(SVG_PATH);

// 需要生成的 PNG 尺寸
const PNG_SIZES = [
  { name: "32x32.png", size: 32 },
  { name: "128x128.png", size: 128 },
  { name: "128x128@2x.png", size: 256 },
  { name: "256x256.png", size: 256 },
  { name: "512x512.png", size: 512 },
];

async function main() {
  console.log("🎨 生成 Pic2WebP 图标 (方案 E: 大→小 + 对勾)\n");

  // 1. 生成所有 PNG
  for (const { name, size } of PNG_SIZES) {
    const outPath = path.join(ICONS_DIR, name);
    await sharp(svgBuffer, { density: 384 })
      .resize(size, size)
      .png()
      .toFile(outPath);
    console.log(`  ✅ ${name} (${size}x${size})`);
  }

  // 2. 生成 logo.png (512x512, 用于其他用途)
  await sharp(svgBuffer, { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(path.join(ICONS_DIR, "logo.png"));
  console.log("  ✅ logo.png (512x512)");

  // 3. 生成 .icns (macOS)
  // iconutil 需要 .iconset 目录
  const iconsetDir = path.join(ICONS_DIR, "icon.iconset");
  if (fs.existsSync(iconsetDir)) {
    fs.rmSync(iconsetDir, { recursive: true });
  }
  fs.mkdirSync(iconsetDir, { recursive: true });

  const iconsetEntries = [
    { src: 16, name: "icon_16x16.png" },
    { src: 32, name: "icon_16x16@2x.png" },
    { src: 32, name: "icon_32x32.png" },
    { src: 64, name: "icon_32x32@2x.png" },
    { src: 128, name: "icon_128x128.png" },
    { src: 256, name: "icon_128x128@2x.png" },
    { src: 256, name: "icon_256x256.png" },
    { src: 512, name: "icon_256x256@2x.png" },
    { src: 512, name: "icon_512x512.png" },
    { src: 1024, name: "icon_512x512@2x.png" },
  ];

  for (const { src, name } of iconsetEntries) {
    await sharp(svgBuffer, { density: 384 })
      .resize(src, src)
      .png()
      .toFile(path.join(iconsetDir, name));
  }

  const icnsPath = path.join(ICONS_DIR, "icon.icns");
  execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);
  fs.rmSync(iconsetDir, { recursive: true });
  console.log("  ✅ icon.icns (macOS)");

  // 4. 生成 .ico (Windows)
  // ICO 文件格式：头部 + 目录 + 图像数据（PNG 嵌入）
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const pngChunks = [];

  for (const size of icoSizes) {
    const png = await sharp(svgBuffer, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer();
    pngChunks.push({ size, data: png });
  }

  // ICO header
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * pngChunks.length;
  let offset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: ICO
  header.writeUInt16LE(pngChunks.length, 4); // count

  const dirEntries = [];
  for (const { size, data } of pngChunks) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // color count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(data.length, 8); // size
    entry.writeUInt32LE(offset, 12); // offset
    dirEntries.push(entry);
    offset += data.length;
  }

  const icoPath = path.join(ICONS_DIR, "icon.ico");
  const icoBuffer = Buffer.concat([header, ...dirEntries, ...pngChunks.map((c) => c.data)]);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log("  ✅ icon.ico (Windows)");

  console.log("\n✅ 所有图标生成完成！");
}

main().catch((err) => {
  console.error("❌ 生成失败:", err);
  process.exit(1);
});
