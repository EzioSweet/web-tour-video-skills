---
name: web-tour-video-qa
description: Extract frames, inspect visuals and text, and drive up to 3 repair rounds for a web-tour-video run. Use during the QA phase.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video — QA

> 执行模式：由 `web-tour-video` 主 agent 直接执行。若运行时采用 sub-agent，子 agent 的 model 必须与主 agent 完全一致。


目标：证明视频真的能看，而不是“编码成功”。

## 输入

- `runs/<slug>/out/final.mp4`
- `runs/<slug>/work/timings.json`
- `runs/<slug>/storyboard.json`
- `runs/<slug>/out/durations.json`
- `runs/<slug>/work/encode.json`

## 命令

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs qa --run runs/<slug>
```

脚本会：
- 每 3 秒抽一帧到 `out/frames/`
- 优先 ffmpeg 解 final.mp4；没有 HEVC 解码器时用 GStreamer VAAPI；再不行用 video.webm + 字幕滤镜
- 检查 SRT/tts_texts/段落完整性/媒体流
- 写 `out/qa_report.md` 骨架和 `work/qa.json`

## 必须做的视觉复核

1. 用你的图片查看工具逐张看 `out/frames/*.jpg`。
2. 检查：
   - 页面报错 / 404 / 控制台错误
   - 空白页 / 加载中 / 骨架屏（**第一帧 frame_000 必须是完整页面**）
   - 弹窗遮挡
   - 假光标缺失或位置不对；**初始光标是否压在图表上弹出 tooltip**
   - 元素没点到 / 点错元素
   - 中文方块字
   - 字幕拼音/音素/裁切
   - 滚动/悬停/输入过程是否自然
   - **向导步骤：字幕说的是不是当前页**（常见错位：页面已到 transport，字幕还在讲 impurity）
   - 导出弹窗/toast、提交后的运行页是否真的入镜
3. 把观察写进 `out/qa_report.md` 的“视觉检查”和“观察记录”，不要只写“无问题”。
4. 复核完成后，把 `work/qa.json` 的 `visualOk` 改成 `true`，并把摘要写进 `visualNotes`。
5. 如果发现问题，定位到 step（用 `work/timings.json`），按主 skill 的返工表修。

## 定点抽帧

- `qa` 默认 3 秒一帧，会漏掉 1–2 秒的加载/切换状态。
- 首帧、提交后运行页、弹窗、向导切换这些关键点，用 `video.webm` 定点抽帧复核（ffmpeg 解 VP9 正常）：
  ```bash
  ffmpeg -ss 12.4 -i out/video.webm -frames:v 1 /tmp/check.png
  ```
- 注意 `video.webm` 不含 Safari 外框和字幕；要检查外框/字幕时，用 GStreamer 解 `final.mp4`。

## 返工

| 问题 | 修哪里 |
|---|---|
| 旁白/字幕错 | `storyboard.json` → validate → 重新审 → audio |
| 选择器/点击/滚动错 | `storyboard.json` actions → record |
| 字幕字号/编码 | render |
| 抽帧/报告 | qa |

最多 3 轮。第 3 轮仍有问题，交付时列出未解决项和对应时间点，不要谎报通过。

## Gate

- 机械检查 0 问题。
- 每一帧都实际看过。
- 首帧无白屏/加载，无意外 tooltip，向导字幕与页面同步。
- `out/qa_report.md` 有具体观察，不是模板。
- 仍有疑点时明确列出。
