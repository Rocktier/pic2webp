// 「转换结束」与「清空列表」时右侧结果区的收尾契约。
//
// 背景（2026-11-07）：转换跑完后点 Clear，右侧还挂着 `4/4 (100%)` 进度条与旧统计，
// 要重启应用才消失。根因不在 Clear —— `convert-done` 把 isConverting 置 false 后
// 没有任何人调 updateProgress()，进度条从「转换中」一直留在「已结束」。
// Clear 只是把它露出来：它只清了 stats-panel，没管进度条。
//
// 这里用最小 DOM 桩锁住两条契约：
//   1. 批次结束 → 进度条收起、统计保留（结果要能被看到）；
//   2. 清空列表 → 进度条与统计一起收，且数字回到初始态。
import { test } from "node:test";
import assert from "node:assert/strict";

import { hideProgressUi, resetResultUi } from "../src/result-ui.js";

function el(init = {}) {
  return {
    hidden: false,
    textContent: null,
    style: {},
    classList: {
      _set: new Set(init.classes || []),
      remove(c) { this._set.delete(c); },
      add(c) { this._set.add(c); },
      has(c) { return this._set.has(c); },
    },
  };
}

function ports() {
  return {
    progress: { container: el(), fill: el(), text: el({}) },
    statsPanel: el({ classes: ["pulse"] }),
    stats: { success: el(), skip: el(), fail: el(), saved: el() },
    retryAllBtn: el(),
  };
}

test("hideProgressUi 收起进度条并清掉旧读数", () => {
  const p = ports();
  p.progress.container.hidden = false;
  p.progress.fill.style.width = "100%";
  p.progress.text.textContent = "4/4 (100%)";

  hideProgressUi(p.progress);

  assert.equal(p.progress.container.hidden, true, "进度条容器必须隐藏");
  assert.equal(p.progress.fill.style.width, "0%", "进度填充要归零，否则下次开始会闪一帧满格");
  assert.equal(p.progress.text.textContent, "", "旧的 4/4 (100%) 必须清掉");
});

test("resetResultUi 清空列表后统计与进度条一起收，数字回到初始态", () => {
  const p = ports();
  // 复现事故现场：转换完成的界面状态
  p.progress.container.hidden = false;
  p.progress.fill.style.width = "100%";
  p.progress.text.textContent = "4/4 (100%)";
  p.statsPanel.hidden = false;
  p.stats.success.textContent = "4";
  p.stats.skip.textContent = "0";
  p.stats.fail.textContent = "0";
  p.stats.saved.textContent = "1.2 MB";
  p.retryAllBtn.hidden = false;

  resetResultUi(p);

  assert.equal(p.progress.container.hidden, true, "进度条必须收起（1.0.0 的 bug 就是这条）");
  assert.equal(p.progress.text.textContent, "", "进度文字必须清空");
  assert.equal(p.statsPanel.hidden, true, "统计面板必须隐藏");
  assert.equal(p.stats.success.textContent, "0");
  assert.equal(p.stats.saved.textContent, "—", "Saved 要回到占位符，不是 0 B");
  assert.equal(p.retryAllBtn.hidden, true, "「重试全部失败项」不能留到下一次");
  assert.equal(p.statsPanel.classList.has("pulse"), false, "脉冲动画类不能残留");
});

test("resetResultUi 容忍缺失的元素（老 DOM / 裁剪版）", () => {
  assert.doesNotThrow(() => resetResultUi({}));
  assert.doesNotThrow(() => resetResultUi({ statsPanel: el(), progress: { container: el() } }));
});
