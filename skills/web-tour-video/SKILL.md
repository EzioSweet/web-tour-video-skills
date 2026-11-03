---
name: web-tour-video
description: End-to-end production of narrated, subtitled 1920x1080 MP4 walkthroughs for web apps from a Markdown brief. Use when the user asks for a software tour video, screen recording with Chinese voiceover, or invokes the web-tour-video workflow.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video

把用户给的 Markdown brief 变成带中文配音、字幕、假光标和点击涟漪的 `final.mp4`。

## 驱动方式（对所有 agent 生效）

- **默认 native 单 agent 驱动**：由一个主 agent 顺序执行 INTAKE → RECON → STORYBOARD → AUDIO → RECORD → RENDER → QA。
- 子 skill 是**分阶段指令模块**，不是独立 sub-agent。主 agent 直接读取对应阶段的 SKILL.md 并运行脚本。
- 所有阶段共享同一会话上下文、同一份用户确认和同一模型。

如果某个 agent 运行时选择/要求用 sub-agent 驱动：

- 子 agent 的 **model 必须与主 agent 完全一致**（同一 provider、同一 model id；推理等级也不要降级）。
- 不得为了省钱/提速给子 agent 换小模型。
- 子 agent 仍必须遵守当前阶段的 gate；最终验收和向用户汇报由主 agent 负责。
- 如果运行时无法保证“子 agent 模型 = 主 agent 模型”，就退回 native 模式，不要用 sub-agent。

## 先读

1. `references/workflow.md` — 阶段、产物、gate、返工规则
2. `references/brief-format.md` — 输入 MD 的解析约定
3. `references/acceptance.md` — 最终验收清单

## 硬规则

- **默认在 STORYBOARD 后停下来审旁白。** 用户没明确说“旁白确认 / 继续 / 可以”之前，不要运行 AUDIO。确认后运行 `pipeline.mjs approve`。
- **不要猜选择器。** 先跑 RECON，拿真实 DOM/截图；低置信度就继续探测或问用户。
- **不要执行 sudo，不要擅自安装系统包。** 缺依赖只给安装命令。
- **不要声称已经“听”过音频。** 多音字是否读对只能人耳确认；ASR 也检测不出多音字。
- **不要跳过 QA 的看图步骤。** 抽帧后必须逐张查看，不能只看脚本日志。
- **危险动作**（删除、支付、发送、发布、改真实数据）没有用户明确授权时，停下来问。
- 所有产物放 `runs/<slug>/`；最终交付在 `runs/<slug>/out/`。
- **首帧必须是完整页面。** 预加载由 record 裁掉，不要在 step 1 写 `goto`。
- **动作时长 ≤ 旁白时长。** click ≈ 1.2s、输入 ≈ 0.12s/字；超了就拆步。
- **导航 click 放下一步开头**，不要放在上一步末尾；否则页面先切走、旁白还在讲上一页。
- **提交/发布/删除类操作**要用户明确授权，并记录产生了哪些数据（例如新建的记录 id）。
- 改旁白/lexicon 后 approval 失效，必须重新审、重新 `approve`。

## 阶段与子 skill

进入某阶段前，**只读该阶段对应子 skill 的 SKILL.md**，不要一次性全读。

| 阶段 | 读这个 skill | 主要命令 | 产物 |
|---|---|---|---|
| INTAKE | 本文件 | `pipeline.mjs doctor --run ...` | `work/brief.json`、`state` |
| RECON | `../web-tour-video-recon/SKILL.md` | `node .agents/skills/web-tour-video-recon/scripts/recon.mjs --run ...` | `work/recon/` |
| STORYBOARD | `../web-tour-video-storyboard/SKILL.md` | `pipeline.mjs validate --run ...` | `storyboard.json`、`narration.md`、`work/pron_plan.md` |
| AUDIO | `../web-tour-video-audio/SKILL.md` | `pipeline.mjs audio --run ...` | `out/a*.mp3`、`out/durations.json`、`out/tts_texts.json` |
| RECORD | `../web-tour-video-record/SKILL.md` | `pipeline.mjs record --run ...` | `out/video.webm`、`work/timings.json` |
| RENDER | `../web-tour-video-render/SKILL.md` | `pipeline.mjs render --run ...` | `out/subs.srt`、`out/final.mp4`、`work/encode.json` |
| QA | `../web-tour-video-qa/SKILL.md` | `pipeline.mjs qa --run ...` | `out/frames/`、`out/qa_report.md` |

## INTAKE

1. 用户消息里可能是 brief 正文，也可能是路径。路径就读取；正文就保存到 `runs/<slug>/brief.md`。
2. slug 用 `YYYY-MM-DD-<host>-<short-kebab>`，例如 `2026-11-03-app-example-checkout`。不要用中文做目录名。
3. 解析 brief，写 `runs/<slug>/work/brief.json`：
   ```json
   {
     "url": "https://app.example.com",
     "storageState": "auth.json",
     "language": "中文",
     "video": { "width": 1920, "height": 1080 },
     "goal": "...",
     "flow": ["...", "..."],
     "narration": { "tone": "...", "mustSay": [], "avoid": [] },
     "acceptance": []
   }
   ```
4. 运行环境检查：
   ```bash
   node .agents/skills/web-tour-video/scripts/pipeline.mjs doctor --run runs/<slug>
   ```
5. 在聊天里回显 intake 摘要：URL、步骤数、登录态、分辨率、阻塞项。默认不等待确认，继续 RECON；但缺登录/缺依赖/危险动作要停。

## RECON

读 `../web-tour-video-recon/SKILL.md`，按里面流程：
- 首次 `recon.mjs --run ...` 拿首页截图和元素表。
- 需要弹窗/二级菜单时，写 `work/recon/probe.json` 动作序列再跑。
- 最终写 `work/recon/selectors.json`，每个 step 一个选择器 + confidence。
- 低置信度不要进入 STORYBOARD。

## STORYBOARD + 审旁白

读 `../web-tour-video-storyboard/SKILL.md`，写 `runs/<slug>/storyboard.json`，然后：

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs validate --run runs/<slug>
```

校验通过后，把 `runs/<slug>/narration.md` 的内容整理成聊天里的“旁白审阅”：
- 每步：字幕、朗读文本、动作、lexicon/风险点
- 最后问：“旁白是否确认？确认后我继续配音、录屏、渲染。”

**停在这里，等用户回复。** 用户确认后：

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs approve --run runs/<slug>
```

如果用户要改旁白：改 `storyboard.json` → 重新 `validate` → 重新给用户审。旧 approval 会因为 hash 变化自动失效。

## AUDIO → RECORD → RENDER → QA

用户确认后可以逐段跑，也可以：

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs all --run runs/<slug>
```

`all` 会先重新 validate，再要求 approval，然后 audio → record → render → qa。

每个阶段都读对应子 skill 的 gate；不通过就停下来修，不要带着坏产物往下跑。

## QA 与返工

读 `../web-tour-video-qa/SKILL.md`：
- 跑 `pipeline.mjs qa`，拿到 frames 列表。
- 用你的图片查看工具逐张看 `out/frames/*.jpg`。
- 把观察写进 `out/qa_report.md`，不要只写“看起来没问题”。
- 有问题按 `references/workflow.md` 的返工表回到最早受影响阶段。
- 最多 3 轮；仍失败就如实列未解决项，不要谎报通过。

## 最终汇报

必须包含：
- `final.mp4` 路径、时长、分辨率、编码模式
- 每段起止时间
- 做过的修复
- 仍存在的疑点
- 提交类操作产生的记录 id（如果有）
- `out/pron_report.md` 路径
- `out/qa_report.md` 路径

## 常用命令

```bash
# 环境
node .agents/skills/web-tour-video/scripts/pipeline.mjs doctor --run runs/<slug>

# 侦察
node .agents/skills/web-tour-video-recon/scripts/recon.mjs --run runs/<slug>

# 校验 + 生成旁白审阅
node .agents/skills/web-tour-video/scripts/pipeline.mjs validate --run runs/<slug>

# 用户确认后
node .agents/skills/web-tour-video/scripts/pipeline.mjs approve --run runs/<slug>

# 全流程
node .agents/skills/web-tour-video/scripts/pipeline.mjs all --run runs/<slug>

# 单段
node .agents/skills/web-tour-video/scripts/pipeline.mjs audio --run runs/<slug>
node .agents/skills/web-tour-video/scripts/pipeline.mjs record --run runs/<slug>
node .agents/skills/web-tour-video/scripts/pipeline.mjs render --run runs/<slug>
node .agents/skills/web-tour-video/scripts/pipeline.mjs qa --run runs/<slug>

# 状态
node .agents/skills/web-tour-video/scripts/pipeline.mjs status --run runs/<slug>
```
