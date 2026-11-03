---
name: web-tour-video-record
description: Record a Playwright video with fake cursor, click ripples, smooth mouse/typing/scrolling, and narration-paced waits; write video.webm and timings.json for web-tour-video. Use during the RECORD phase.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video — Record

> 执行模式：由 `web-tour-video` 主 agent 直接执行。若运行时采用 sub-agent，子 agent 的 model 必须与主 agent 完全一致。


目标：按 `out/durations.json` 的旁白时长录屏，画面节奏跟着声音走。

## 输入

- `runs/<slug>/storyboard.json`
- `runs/<slug>/out/durations.json`
- `runs/<slug>/auth.json`（可选）

## 命令

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs record --run runs/<slug>

# 调试
HEADED=1 node .agents/skills/web-tour-video/scripts/pipeline.mjs record --run runs/<slug>
xvfb-run -a node .agents/skills/web-tour-video/scripts/pipeline.mjs record --run runs/<slug>
```

## 流程

1. 检查 `out/durations.json` 每步都有时长；缺了就回 AUDIO。
2. 检查登录态；无显示器时不要依赖 `playwright codegen`，用 RECON 阶段的无头登录脚本生成 `auth.json`（见 recon skill）。
3. `chromium.launch({ headless: !HEADED })`。
4. `newContext`：
   - `viewport` = `storyboard.width` × (`storyboard.height` - `chrome.height`)
   - `recordVideo.size` 必须与 viewport 完全一致（成片高度由 RENDER 叠加外框补回）
   - `storageState`（存在时）
   - `locale: zh-CN`、`deviceScaleFactor: 1`
5. `context.addInitScript(installCursorOverlay)` 注入假光标 + 红色点击涟漪。
6. 逐步执行 actions，记录相对录屏起点的 `startMs/endMs`。
7. 每步 actions 完成后：
   `sleep(max(0, 旁白时长 + 600ms - 操作耗时))`
8. 最后 sleep 800ms，`page.close()` → `context.close()` → 读 `video.path()`。
9. 把视频移到 `out/video.webm`，写 `work/timings.json`。

## 预加载与时间轴裁切（重要）

- storyboard 没有写 `goto` 时，record 会先打开首页、等 `networkidle` + 1.2s，**再**开始计时。
- 预加载画面仍会录进 `video.webm`，record 把这段时长写进 `timings.video.trimStartMs`，RENDER 用 `-ss` 裁掉。
- 因此**不要在 step 1 里写 `goto`**；显式 `goto` 会跳过预加载，开场白屏几秒。
- 录屏日志里的“已完成时长”是裁切后的时长；`video.webm` 本身比它长是正常的。
- 如果改了 record 的计时逻辑，务必同步改 render 的 `-ss trimStartMs`，否则音画整体错位。

## 画面规则

- 鼠标移动平滑：≥30 步，约 350–450ms。
- 点击前停 250ms；点击按下/抬起之间有 50–60ms，让涟漪可见。
- 输入逐字打，delay 100–120ms。
- 滚动分 6–18 个小步，每步 70ms，不要一次跳到底。
- 操作前 `waitFor({state:'visible'})` + `scrollIntoViewIfNeeded`。
- 点击前用 `elementFromPoint` 确认中心点没被遮挡；不要用 `locator.click({trial:true})`（部分页面会慢 1s+）。
- 假光标 `pointer-events:none`，z-index 最高；页面跳转后 init script 会重新注入。
- 初始光标放在页面右下角（`width-80, height-60`），不要放画面中心：中心往往压着图表，会一直弹出 tooltip，污染开场。
- 忽略新文档加载时 Chromium 补发的 `(0,0)` mousemove，否则光标会卡在左上角。

## 动作耗时预算（最容易翻车）

- record 是“**先把 actions 全做完，再按旁白时长补等待**”，不是边说边做。
- 单次 click 约 0.8–1.2s（移动 350–450ms + 点击前 250ms + 按下/抬起）；`wait` 全部计入动作时长。
- 一步的 `动作总时长` 必须 ≤ `旁白时长`，否则会出现“页面先切走、旁白还在讲上一页”或长时间静音。
- 经验值：1 个 click ≈ 1.2s，1 个输入 ≈ 0.12s/字，1 个弹窗选择 ≈ 1s。
- 导航/“下一项”/“提交”这类会改变页面的 click，放在**下一步 actions 的开头**，不要放在上一步末尾；否则上一步旁白还没说完，页面已经切走。
- 超过预算就拆步：把“打开弹窗 / 选参数 / 关闭并继续”拆成 2–3 步，每步配一句旁白。
- 一步 actions 控制在 4 个以内；超过 5 个基本一定超时。

## 产物

- `out/video.webm`
- `work/timings.json`：
  ```json
  {
    "video": { "file": "out/video.webm", "durationSeconds": 26.24, "trimStartMs": 5553, "width": 1920, "height": 1080 },
    "steps": [{ "index": 1, "startMs": 20, "endMs": 4557, "actionMs": 1730, "waitMs": 2800, "audioDurationSeconds": 3.94 }]
  }
  ```
- `work/record.log`

## Gate

- `video.webm` 存在且时长 > 0。
- viewport = recordVideo size = `video.width` × (`video.height - chrome.height`)。
- 每步都有 timing。
- 裁切后的时长（`durationSeconds`）与时间轴预期误差 < 1s。
- 操作耗时没有超过旁白（超过会 warn；warn 必须在 RENDER 前清零，否则拆步或加长旁白）。
- 第一帧不是白屏/加载中。

## 不要

- 不要编码、不烧字幕。
- 不要在 RECORD 前改 narration；改了要回 AUDIO。
