---
name: web-tour-video-audio
description: Generate per-step Chinese voiceover via an OpenAI-compatible TTS endpoint, apply pronunciation lexicon, retry failures, probe real durations, and write tts_texts.json/pron_report.md for web-tour-video. Use during the AUDIO phase.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video — Audio

> 执行模式：由 `web-tour-video` 主 agent 直接执行。若运行时采用 sub-agent，子 agent 的 model 必须与主 agent 完全一致。


目标：先为所有旁白生成音频并读真实时长，再让录屏跟着声音走。

## 输入

- `runs/<slug>/storyboard.json`
- `runs/<slug>/work/approval.json`（必须已确认旁白）
- TTS：`TTS_BASE_URL` / `TTS_MODEL` / `TTS_VOICE`，默认 `http://localhost:8735`

## 命令

```bash
# 正常配音
node .agents/skills/web-tour-video/scripts/pipeline.mjs audio --run runs/<slug>

# 发音实测（a/b/c）
node .agents/skills/web-tour-video-audio/scripts/tts.mjs --run runs/<slug> --pron-test

# 单段测试
node .agents/skills/web-tour-video-audio/scripts/tts.mjs --text "测试文本" --out /tmp/test.mp3
```

## 流程

1. 检查 approval：storyboard 改过就必须重新审。
2. 先校验所有朗读文本；有阿拉伯数字/非法拼音直接报错，不生成半套音频。
3. 逐段调用 `POST /v1/audio/speech`：
   ```json
   { "model": "...", "input": "...", "voice": "...", "response_format": "mp3" }
   ```
   `TTS_API_KEY` 存在时带 `Authorization: Bearer`。
4. 失败重试 2 次（总共 3 次）；仍失败报“第几段”。
5. 每段生成后用 ffprobe 读真实时长；不要估算。
6. 逐段写 `out/tts_texts.json` 和 `out/durations.json`。
7. 生成 `out/pron_report.md`（时间轴待录屏后补）。

## 产物

- `out/a01.mp3` …
- `out/tts_texts.json`：每段 narration、ttsText、source、lexiconHits、markers、audio、durationSeconds、attempts
- `out/durations.json`：同上，供 record/render 使用
- `out/pron_report.md`
- `out/pron_test/`（仅 `--pron-test`）

## TTS 配置

- base URL 默认 `http://localhost:8735`。
- `model` / `voice` 留空表示用服务端默认。
- 服务没有 `/v1/models` 或 `/v1/audio/voices` 时不要硬编造；留空或问用户。
- 换引擎只改 `scripts/tts.mjs`，不要动 storyboard/render。

## 发音

- lexicon 应用规则：最长匹配优先、单次扫描、不二次替换。
- `tts_text` 优先级最高，不再套 lexicon。
- 每段 `markers` 记录拼音/CMU 位置，`pron_report.md` 用它列“只听这些位置”。
- 不要声称“听过了”；脚本不做听觉判断。
- 品牌名：TTS 只支持 CMU 音素，**不支持 IPA**（`/siː/` 会被逐字符念）。用户给的英文读法要转成 CMU，例如 `Acme` → `[AE1 K M IY0]`。
- 中英混排的近似音（如“西包德尔”）容易与英文读音打架；用户明确要英文音标时，优先整段用 CMU。
- 生成后抽看第 1 段时长：如果某个品牌词的音素没被解析、被逐字母念，时长会异常拉长（同期文本比预期多 3–5 秒），要停下来问用户或换写法。
- 多音字 lexicon（如“模型”→“MO2型”）只改朗读，不改字幕；不要把这些标记写进 narration。

## Gate

- 段数 = storyboard 步数。
- 每段时长 > 0，文件 > 800 字节。
- `tts_texts.json` 的 ttsText 无阿拉伯数字。
- narration 无拼音/音素。
- 品牌名/多音字的 markers 已记录，第 1 段时长没有异常膨胀。
- `durations.json` 存在且每步都有。

## 失败处理

- TTS 不可达：停下，给启动 OmniVoice 的命令。
- 某段 3 次失败：指出段号、HTTP 状态、响应片段；不要继续录屏。
- 时长异常（0 或极短）：删掉该段重试，不要写进 durations。
