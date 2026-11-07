// 右侧结果区的收尾动作 —— 单一来源。
//
// 2026-11-07 事故：转换跑完点 Clear，右侧还挂着 `4/4 (100%)` 进度条与旧统计，
// 要重启应用才消失。根因有两处：
//   1. `convert-done` 把 isConverting 置 false 之后，没有人再调 updateProgress()，
//      于是进度条停在「转换中」的最后一帧，一直到下次转换才被覆盖；
//   2. 清空列表的代码写了两份（Clear 按钮 / ⌘⌫），两份都只清了统计面板、没管进度条。
//
// 所以这里把「收起进度条」和「清空结果」各自收成一个函数，两个入口共用。
// 判据见 tests/result-ui.test.mjs。

/** 收起进度条：容器隐藏、填充归零、文字清空。 */
export function hideProgressUi({ container, fill, text } = {}) {
  if (container) container.hidden = true;
  if (fill) fill.style.width = "0%";
  // 文字不清会在下次开始转换的第一帧闪出上一批的 "4/4 (100%)"
  if (text) text.textContent = "";
}

/**
 * 清空列表后的结果区收尾：进度条与统计一起收，数字回到初始态。
 * 参数全是可选元素 —— 缺哪个跳哪个，不因为一个元素被裁掉就整块崩。
 */
export function resetResultUi({ statsPanel, progress, stats, retryAllBtn } = {}) {
  hideProgressUi(progress || {});
  if (statsPanel) {
    statsPanel.hidden = true;
    // 转换完成时挂上的脉冲动画类，留着会在下次出现时自己跑一遍
    if (statsPanel.classList && typeof statsPanel.classList.remove === "function") {
      statsPanel.classList.remove("pulse");
    }
  }
  const { success, skip, fail, saved } = stats || {};
  if (success) success.textContent = "0";
  if (skip) skip.textContent = "0";
  if (fail) fail.textContent = "0";
  // 初始占位符是 — 而不是 0 B：没跑过转换时不该显示"省了 0 B"
  if (saved) saved.textContent = "—";
  if (retryAllBtn) retryAllBtn.hidden = true;
}
