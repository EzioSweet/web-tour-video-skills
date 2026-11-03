---
name: web-tour-video-render
description: Mix per-step audio, burn SRT subtitles, encode HEVC via VAAPI or libx265, and verify with ffprobe for web-tour-video. Use during the RENDER phase.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video — Render

> 执行模式：由 `web-tour-video` 主 agent 直接执行。若运行时采用 sub-agent，子 agent 的 model 必须与主 agent 完全一致。


目标：把 `video.webm`、逐段音频、`timings.json` 合成 `final.mp4`，并烧录 narration 字幕。

## 输入

- `runs/<slug>/out/video.webm`
- `runs/<slug>/out/durations.json`
- `runs/<slug>/work/timings.json`
- `runs/<slug>/storyboard.json`

## 命令

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs render --run runs/<slug>

# 软件编码（需要 ffmpeg 带 libx265）
ENCODER=cpu node .agents/skills/web-tour-video/scripts/pipeline.mjs render --run runs/<slug>
```

## 流程

1. 读 storyboard / durations / timings，构建 `prepared`（每步 narration、音频、startMs、duration）；如果 `timings.video.trimStartMs > 0`，在输入 `video.webm` 前加 `-ss`，把预加载白屏裁掉并保持时间轴对齐。
2. 生成 `out/subs.srt`：
   - 每步一条
   - 内容取 `narration`，绝不取 ttsText
   - start = `startMs + OFFSET_MS`
   - end = start + 旁白时长 + 350ms，且不超过下一步起点 - 80ms
3. ffmpeg 混音：
   - 每个音频 `adelay=<startMs+OFFSET>:all=1`
   - `amix=inputs=N:normalize=0:duration=longest`
   - `apad=whole_dur=<videoDuration>`
   - `alimiter=limit=0.95`
4. 烧字幕 + 浏览器外框：
   - `subtitles=filename=subs.srt:force_style='FontName=Noto Sans CJK SC,FontSize=12,Outline=1.5,MarginV=26,...'`
   - storyboard 有 `chrome` 时，`[chrome][video]vstack` 后再烧字幕；`chromeUrl` 变化的步骤用 `overlay enable='between(t,...)'` 切地址栏
   - VAAPI 滤镜顺序必须是 `[输入] -> subtitles -> format=nv12 -> hwupload`
5. 编码：
   - 默认 VAAPI：`-vaapi_device <device>` 在所有输入前；`-c:v hevc_vaapi -qp ${VIDEO_QP:-18} -tag:v hvc1`
   - CPU：`-c:v libx265 -crf ${VIDEO_QP:-18} -preset medium -pix_fmt yuv420p -tag:v hvc1`
   - 音频统一 AAC 192k / 48k / stereo
6. ffprobe 校验：hevc、aac、1920x1080、时长与录屏误差 < 0.9s。
7. 写 `work/encode.json` 和 `out/pron_report.md`（带最终时间轴）。

## Gate

- `out/final.mp4` 存在。
- 视频流 hevc，音频流 aac，分辨率正确，时长正确。
- `trimStartMs` 已裁掉，首帧是完整页面。
- `out/subs.srt` 无拼音/音素标记。
- `out/pron_report.md` 已更新为最终时间轴。

## 浏览器外框（可选）

- storyboard 顶层写：
  ```json
  "chrome": { "height": 76, "title": "Example App", "url": "app.example.com" }
  ```
- 录制视口变成 `video.height - chrome.height`（例：1080-76=1004），成片仍为 `video.height`。
- 某一步需要地址栏变化时，在该步写 `chromeUrl`；RENDER 按该步 `startMs` 切换。
- 外框由 `web-tour-video/lib/browser_chrome.mjs`（Node + Playwright 渲 HTML）生成，**不需要 Python/PIL**。
- 当前样式是 Safari：红黄绿交通灯、白色活动标签页、居中地址胶囊。
- `chrome.height` 建议 72–80；页面高度必须是偶数。
- 地址栏里不要放真实账号/UUID；用 `app.example.com/cases/…` 这类省略写法。

## 质量

- `VIDEO_QP` 默认 18。UI 文字对量化敏感，`qp 24` 会明显发软，不要改回去。
- 如果首帧是白屏/加载中，先查 `timings.video.trimStartMs` 是否为 0；为 0 说明预加载没生效，回 RECORD。

## 回退

- VAAPI 设备不存在或 ffmpeg 没 `hevc_vaapi`：自动回退 CPU。
- VAAPI 运行失败：自动回退 CPU；两条错误都保留。
- CPU 需要 libx265；当前系统没有就明确报错，给安装命令，不要静默用 h264。

## 常见问题

- 无权限：用户加入 `render` 组，重新登录。
- Docker：映射 `/dev/dri`。
- 花屏：检查 `format=nv12` 和 `hwupload` 顺序。
