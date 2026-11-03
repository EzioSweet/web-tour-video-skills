# 编码

## VAAPI（默认）

```bash
ffmpeg -vaapi_device /dev/dri/renderD128 \
  -ss 5.553 \
  -i video.webm -i a01.mp3 ... \
  -filter_complex "[1:a]adelay=...:all=1[a1];..." \
  -map 0:v:0 -map "[aout]" \
  -vf "subtitles=filename=subs.srt:force_style='...',format=nv12,hwupload" \
  -c:v hevc_vaapi -qp 18 -tag:v hvc1 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -t <videoDuration> -movflags +faststart -y final.mp4
```

- `-ss` 来自 `timings.video.trimStartMs`，用来裁掉录屏预加载；不要再手工保留白帧。
- `-vaapi_device` 必须在所有输入之前。
- 滤镜顺序必须是 `subtitles -> format=nv12 -> hwupload`。
- 有浏览器外框时，先 `[chrome][video]vstack` 再烧字幕。
- `VIDEO_QP` 默认 18；`qp 24` 会让 UI 文字明显发软。
- 无权限：用户加入 `render` 组；Docker 映射 `/dev/dri`。
- 花屏：先检查 `format=nv12` 和 `hwupload` 位置。

## CPU（libx265）

```bash
-c:v libx265 -crf 18 -preset medium -pix_fmt yuv420p -tag:v hvc1
```

当前机器 ffmpeg 可能没有 libx265；没有就明确报错，不要静默用 h264。

## 校验

`ffprobe` 必须确认：

- 视频流 `hevc`
- 音频流存在且 `aac`
- 分辨率 1920x1080
- 时长与录屏误差 < 0.9s
