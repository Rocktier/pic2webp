// 接线判据：函数写对了，但没人调它 —— 这次两个 bug 都是这种形态。
//
// 1. `convert-done` 里 `isConverting = false` 之后没有任何刷新动作，
//    进度条停在最后一帧（`4/4 (100%)` 一直挂着）；
// 2. 清空列表写了两份实现（Clear 按钮 / ⌘⌫），两份都漏了进度条。
//
// 这两条测不了「用户看到什么」，只能测「代码有没有按约定接上」。
// 属于结构断言，故意写得窄：只盯调用点与重复实现，不猜实现细节。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "..", "src", "app.js"), "utf8");

/** 粗粒度取一段代码块：从起始标记到下一次 `\n  }` 或 `\n});` 收尾。 */
function block(startMarker) {
  const i = SRC.indexOf(startMarker);
  assert.notEqual(i, -1, `app.js 里找不到 ${startMarker}`);
  const rest = SRC.slice(i);
  const end = rest.search(/\n\s*\}\);/);
  return end === -1 ? rest : rest.slice(0, end);
}

test("convert-done 落定后必须刷新进度条", () => {
  const b = block('listen("convert-done"');
  assert.match(
    b,
    /updateProgress\s*\(/,
    "convert-done 里没有 updateProgress() —— 进度条会停在转换中的最后一帧",
  );
});

test("清空列表只有一份实现，Clear 按钮与 ⌘⌫ 共用", () => {
  const defs = [...SRC.matchAll(/function clearAllFiles\s*\(/g)].length;
  const calls = [...SRC.matchAll(/(?<!function )clearAllFiles\s*\(/g)].length;
  assert.equal(defs, 1, "clearAllFiles 应当只定义一次");
  assert.ok(calls >= 2, `clearAllFiles 的调用点只有 ${calls} 个，两个入口没都接上`);
});

test("不允许再出现内联的清空实现（files = [] 紧跟 stats = null）", () => {
  // clearAllFiles 自己当然会写这两行 —— 把它整段剔掉，再看剩下还有没有第二份。
  const i = SRC.indexOf("function clearAllFiles");
  assert.notEqual(i, -1, "找不到 clearAllFiles 的定义");
  const end = SRC.indexOf("\n}", i);
  assert.notEqual(end, -1, "clearAllFiles 的函数体没有正常收尾");
  const rest = SRC.slice(0, i) + SRC.slice(end);
  assert.doesNotMatch(
    rest,
    /files\s*=\s*\[\];[^\n]*\n\s*stats\s*=\s*null;/,
    "还有一处内联清空：它会又一次漏掉进度条，请改调 clearAllFiles()",
  );
});

test("文件对话框的后缀白名单只从 formats.js 取", () => {
  assert.match(SRC, /import\s*\{[^}]*DIALOG_IMAGE_EXTENSIONS[^}]*\}\s*from\s*["']\.\/formats\.js["']/);
  assert.doesNotMatch(
    SRC,
    /extensions:\s*\[/,
    "app.js 里还有写死的后缀数组 —— 会与 formats.js 分叉（.tif 就是这么漏的）",
  );
});

test("导入校验与对话框共用同一份白名单（不要第二份 SUPPORTED_EXTS）", () => {
  // 事故形态：filters 与 addFiles 各有一份后缀数组，两份都漏 .tif。
  // 只修一处的话，另一处仍然会把文件挡在门外（拖放路径就走 addFiles）。
  assert.doesNotMatch(
    SRC,
    /(SUPPORTED_EXTS|const\s+\w*EXTS?\w*\s*=\s*\[)/,
    "app.js 里又出现了本地后缀数组，请改用 formats.js 的 DIALOG_IMAGE_EXTENSIONS",
  );
  assert.match(
    SRC,
    /DIALOG_IMAGE_EXTENSIONS\.includes\(\s*fileExt\(/,
    "addFiles 的导入校验没有用共享白名单",
  );
});
