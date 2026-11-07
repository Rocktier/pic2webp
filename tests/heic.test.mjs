// HEIC/HEIF 支持的结构判据（1.0.1）。
//
// 为什么单独写一个文件：`tests/formats.test.mjs` 只判「image features →
// 白名单」这一个方向，而 HEIC 根本不是 image feature。只把 heic 加进
// formats.js、后端一行不动，那套判据会全绿 —— 用户能选中文件，界面全是
// 灰底占位，转换全失败（D-121 同型、D-126 明写的盲区）。
//
// 所以这里的核心是一条**反向判据**：白名单里每种格式，都必须能在后端
// 找到对应解码实现；HEIC 还额外要求两端（macOS ImageIO / Windows WIC）
// 都接上、三处解码点都走统一入口。
//
// 判据本身也做正反对照（准则 #11 / D-115）：完整仓库判绿，删掉任一环
// 节必须判红，空目录必须判红（存在性断言不许在「没文件」时假绿）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DIALOG_IMAGE_EXTENSIONS, FORMAT_ALIASES } from "../src/formats.js";
import { translateBackendMessage } from "../src/i18n.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const WATCHED = [
  "src/formats.js",
  "src/i18n.js",
  "src/app.js",
  "src/index.html",
  "src-tauri/src/lib.rs",
  "src-tauri/src/heic.rs",
  "src-tauri/Cargo.toml",
];

function read(root, rel) {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function enabledImageFeatures(cargo) {
  const line = cargo.split("\n").find((l) => /^image\s*=/.test(l));
  if (!line) return [];
  const m = line.match(/features\s*=\s*\[([^\]]*)\]/);
  return m ? m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean) : [];
}

/** 唯一判据函数。返回问题列表；空数组 = 绿。对任意目录都能跑。 */
function coverageIssues(root) {
  const issues = [];
  const cargo = read(root, "src-tauri/Cargo.toml");
  const lib = read(root, "src-tauri/src/lib.rs");
  const heic = read(root, "src-tauri/src/heic.rs");
  const formats = read(root, "src/formats.js");
  const i18n = read(root, "src/i18n.js");
  const features = enabledImageFeatures(cargo);

  // ① 白名单里的每种格式都要有解码实现 —— 反向判据本体。
  //    必须从 formats.js 的**源码**重新解析别名表：只 import 常量的话，
  //    临时红样例往文件里加一个 avif，判据读到的还是旧对象，会假绿。
  const aliasBlock = formats.match(/export const FORMAT_ALIASES = \{([\s\S]*?)\};/);
  if (!aliasBlock) {
    issues.push("formats.js 里解析不出 FORMAT_ALIASES");
  } else {
    const pairs = [...aliasBlock[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [
      m[1],
      [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
    ]);
    for (const [canonical, aliases] of pairs) {
      if (aliases.length === 0) issues.push(`${canonical} 没有后缀`);
      if (features.includes(canonical)) continue;
      if (canonical !== "heic") {
        issues.push(`${canonical}（.${aliases.join(" / .")}）既不在 image features 里，也没有系统解码器`);
      }
    }
  }

  // ② HEIC 的两端实现，缺一端就是「两端都做」没兑现。
  if (!heic) {
    issues.push("缺 src-tauri/src/heic.rs");
  } else {
    if (!heic.includes("CGImageSourceCreateImageAtIndex")) issues.push("macOS ImageIO 实现缺失");
    if (!heic.includes("CreateDecoderFromFilename")) issues.push("Windows WIC 实现缺失");
    if (!heic.includes("apply_exif_orientation")) issues.push("EXIF 方向修正缺失");
    if (!heic.includes("heic_codec_missing")) issues.push("系统解码器缺失的错误码不存在");
  }
  if (!lib.includes("pub mod heic;")) issues.push("lib.rs 没有声明 heic 模块");
  if (!cargo.includes("Win32_Graphics_Imaging")) issues.push("Cargo.toml 没开 WIC feature");

  // ③ 三处解码点 + dims 保护都要接统一入口，不许有绕过。
  for (const call of [
    "fn decode_image(",
    "decode_image(Path::new(&path), Some(sz))",
    "decode_image(path, None)",
  ]) {
    if (!lib.includes(call)) issues.push(`统一解码入口缺一处：${call}`);
  }
  if (!lib.includes("heic::decode(")) issues.push("主转换没有走 HEIC 系统解码器");
  if (!lib.includes("heic::dimensions(")) issues.push("25MP 尺寸保护没覆盖 HEIC");
  if (lib.includes("let supported = [")) issues.push("还有硬编码的后端格式白名单");
  if ((lib.match(/let supported = SUPPORTED_EXTS;/g) || []).length !== 2) {
    issues.push("collect / CLI 两处没有共用 SUPPORTED_EXTS");
  }
  for (const ext of ["heic", "heif"]) {
    if (!lib.includes(`"${ext}"`)) issues.push(`SUPPORTED_EXTS 缺 .${ext}`);
  }

  // ④ 前端：白名单、过期文案、错误码映射。
  if (!formats.includes('"heic"') || !formats.includes('"heif"')) issues.push("formats.js 缺 HEIC 后缀");
  if (i18n.includes("unsupported-heic") || i18n.includes("暂不支持 HEIC")) {
    issues.push("还残留「暂不支持 HEIC」的过期文案");
  }
  for (const key of ["msg-heic-codec-missing", "msg-heic-decode-fail"]) {
    // 至少两门各一条；translateBackendMessage 里还会再出现一次 key，
    // 所以是「>= 2」不是「== 2」。
    if ((i18n.match(new RegExp(`"${key}"`, "g")) || []).length < 2) {
      issues.push(`${key} 没有中英两门词条`);
    }
  }
  if (!i18n.includes("heic_codec_missing") || !i18n.includes('key: "msg-heic-codec-missing"')) {
    issues.push("后端错误码没接进 translateBackendMessage");
  }
  return issues;
}

/** 复制最小文件集到 /tmp，按需做字符串替换，产出红样例。 */
function fixture(mutators = {}) {
  const root = mkdtempSync(join(tmpdir(), "p2w-heic-"));
  for (const rel of WATCHED) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    let text = read(repo, rel);
    for (const [needle, repl] of Object.entries(mutators)) {
      text = text.replaceAll(needle, repl);
    }
    writeFileSync(dest, text);
  }
  return root;
}

function withFixture(mutators, fn) {
  const root = fixture(mutators);
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("真实仓库：HEIC 覆盖判据全绿", () => {
  assert.deepEqual(coverageIssues(repo), []);
});

test("白名单里必须有 heic / heif", () => {
  assert.ok(DIALOG_IMAGE_EXTENSIONS.includes("heic"));
  assert.ok(DIALOG_IMAGE_EXTENSIONS.includes("heif"));
});

test("加一个没有后端实现的新格式，判据必须判红", () => {
  withFixture({ '  tiff: ["tif", "tiff"],': '  tiff: ["tif", "tiff"],\n  avif: ["avif"],' }, (root) => {
    assert.ok(
      coverageIssues(root).some((s) => s.includes("avif")),
      "只改白名单不改后端竟然判绿 —— 反向判据失效",
    );
  });
});

test("删掉 Windows 实现，判据必须判红（两端都做不许缩水成一端）", () => {
  withFixture({ CreateDecoderFromFilename: "WIC_DECODER_GONE" }, (root) => {
    assert.ok(coverageIssues(root).some((s) => s.includes("Windows WIC")));
  });
});

test("删掉 heic.rs，判据必须判红", () => {
  withFixture({}, (root) => {
    rmSync(join(root, "src-tauri/src/heic.rs"));
    assert.ok(coverageIssues(root).some((s) => s.includes("heic.rs")));
  });
});

test("把 CLI 解码退回裸 ImageReader，判据必须判红", () => {
  withFixture({ "decode_image(path, None)": "ImageReader::open(src)?.decode()?" }, (root) => {
    assert.ok(coverageIssues(root).length > 0);
  });
});

test("SUPPORTED_EXTS 漏掉 heic，判据必须判红", () => {
  withFixture({ '"tif", "tiff", "heic", "heif"': '"tif", "tiff"' }, (root) => {
    assert.ok(coverageIssues(root).some((s) => s.includes("SUPPORTED_EXTS 缺")));
  });
});

test("空目录 / 文件缺失必须判红，不许假绿（D-115）", () => {
  const root = mkdtempSync(join(tmpdir(), "p2w-heic-empty-"));
  try {
    assert.ok(coverageIssues(root).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("后端错误码要翻译成可操作文案，不是裸码", () => {
  const missing = translateBackendMessage("heic_codec_missing:decoder:0x80070002");
  assert.match(missing, /HEIF Image Extensions/);
  assert.doesNotMatch(missing, /heic_codec_missing/);
  const failed = translateBackendMessage("heic_decode_fail:bitmap_context");
  assert.match(failed, /HEIC decode failed/);
});

test("fixture 复制的是磁盘上的最新文件，不是 import 缓存", () => {
  withFixture({}, (root) => {
    assert.deepEqual(coverageIssues(root), []);
  });
});
