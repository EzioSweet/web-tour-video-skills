# Web Tour Video Workflow

## 状态机

```text
INTAKE → RECON → STORYBOARD → [等待用户确认旁白] → AUDIO → RECORD → RENDER → QA → DELIVER
```

`work/validate.json` 记录 STORYBOARD gate；`work/approval.json` 记录用户确认和 storyboard hash；`work/state.json` 记录最后完成的阶段。
`pipeline.mjs audio/all` 会检查 hash；storyboard 改过就必须重新审。

## 阶段产物

| 阶段 | 目录 | 必须产物 | Gate |
|---|---|---|---|
| INTAKE | `runs/<slug>/` | `brief.md`、`work/brief.json` | URL/步骤/分辨率/登录态明确 |
| RECON | `work/recon/` | `recon.md`、`selectors.json`、`screenshots/` | 每步有高置信选择器 |
| STORYBOARD | `runs/<slug>/` | `storyboard.json`、`narration.md`、`work/pron_plan.md` | schema/朗读文本校验通过 |
| AUDIO | `out/` | `a*.mp3`、`durations.json`、`tts_texts.json` | 每段时长 > 0，无数字残留 |
| RECORD | `out/`、`work/` | `video.webm`、`timings.json` | viewport=record size，所有 action 成功 |
| RENDER | `out/`、`work/` | `subs.srt`、`final.mp4`、`encode.json` | hevc + aac + 分辨率 + 时长 |
| QA | `out/` | `frames/`、`qa_report.md`、`work/qa.json` | 机械检查 + 逐帧视觉复核 |

## 返工表

| 发现的问题 | 从哪一步重跑 |
|---|---|
| narration / lexicon / tts_text 改了 | `validate` → 重新审 → `audio` → `record` → `render` → `qa` |
| 只改 selector / 等待 / 滚动 / 点击顺序 | `record` → `render` → `qa` |
| 只改字幕字号/位置/编码参数 | `render` → `qa` |
| 只是抽帧/报告问题 | `qa` |
| 页面本身改版 | `recon` → `storyboard` → 全部 |
| 开场白屏/首帧是加载中 | 查 `trimStartMs`；回 `record`（预加载）→ `render` → `qa` |
| 页面先切走、旁白还在讲上一页 / 长时间静音 | `storyboard` 拆步或把导航 click 移到下一步开头 → `validate` → 重新审 → `audio` → `record` → `render` |
| 初始光标压在图表上弹 tooltip | `record` 初始光标位置 → `record` → `render` |
| 品牌名/多音字读错 | `storyboard` lexicon → `validate` → 重新审 → `audio` → `record` → `render` |
| 提交类操作产生了真实数据 | 记录新建的 case id，交付时告知用户；不要为了重录反复提交 |

改完 `storyboard.json` 后旧 approval 自动失效；不要用旧 approval 直接跑 audio。

## 并发与顺序

- 先 AUDIO 再 RECORD：录屏要用真实旁白时长补等待。
- 不要在 AUDIO 之前 RECORD。
- RENDER 依赖 RECORD 的 `timings.json` 和 AUDIO 的 `durations.json`。
- QA 只读 `final.mp4` 和 `work/timings.json`，不改上游。

## 失败处理

- AUDIO 失败：指出第几段、TTS HTTP 状态、重试次数；不要生成半套 durations。
- RECORD 失败：保存日志，指出第几步哪个 action；不要进入 RENDER。
- 操作耗时 warn 未清零：不要硬跑 RENDER，先拆步或加长旁白。
- 预加载未裁切（`trimStartMs=0` 且首帧白屏）：不要交付，回 RECORD。
- RENDER 失败：保留 VAAPI stderr；如果回退 CPU 也失败，列两条错误。
- QA 机械失败：先修文本/媒体问题；视觉失败按返工表。
- 最多 3 轮 QA。第 3 轮仍失败，交付时明确列未解决项。

## 文件失效规则

- AUDIO 重跑会删掉 `video.webm`、`final.mp4`、`frames/`、`timings.json`、`encode.json`。
- RECORD 重跑会删掉 `final.mp4`、`subs.srt`、`frames/`、`encode.json`。
- RENDER 重跑会删掉 `frames/`、`qa_report.md`。
- 不要手工保留旧 `final.mp4` 冒充新产物。

## 安全

- `auth.json` 含 cookies，不要打印内容，不要提交。
- 危险操作（删除/支付/发送/发布）必须用户明确授权。
- 不执行 sudo；缺依赖给命令。
