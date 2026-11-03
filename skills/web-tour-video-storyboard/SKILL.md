---
name: web-tour-video-storyboard
description: Turn a brief and recon selectors into a validated storyboard.json with clean Chinese narration, actions, lexicon, and pronunciation plan for web-tour-video. Use during the STORYBOARD phase.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video — Storyboard

> 执行模式：由 `web-tour-video` 主 agent 直接执行。若运行时采用 sub-agent，子 agent 的 model 必须与主 agent 完全一致。


目标：把流程写成“一步一段旁白 + 一组动作”的分镜，并生成给用户审的 `narration.md`。

## 先读

- `references/storyboard-schema.md`
- `references/pronunciation.md`
- `../web-tour-video/templates/selectors.json`
- `../web-tour-video/schemas/storyboard.schema.json`

## 输入

- `runs/<slug>/work/brief.json`
- `runs/<slug>/work/recon/selectors.json`
- `runs/<slug>/work/recon/recon.md`

## 输出

- `runs/<slug>/storyboard.json`（人工可编辑，唯一事实来源）
- `runs/<slug>/narration.md`（由 validate 脚本生成，给用户审）
- `runs/<slug>/work/pron_plan.md`（发音风险计划）

## 写分镜

每步结构：

```json
{
  "narration": "干净原文，用于字幕和审阅；绝不能出现拼音/音素",
  "tts_text": "可选；手写朗读文本，优先级最高，不再套 lexicon",
  "actions": [
    { "type": "goto", "url": "..." },
    { "type": "wait", "ms": 500 },
    { "type": "click", "selector": "..." },
    { "type": "type", "selector": "...", "text": "..." },
    { "type": "scroll", "y": 400 },
    { "type": "hover", "selector": "..." }
  ]
}
```

规则：

- 一步只讲一件事，2–6 秒；超过 60 字考虑拆步。
- 旁白口语化，不要营销腔；不要念 UI 上已经很明显的东西。
- 动作要跟旁白同步：先 wait 300–500ms 再点击，让观众听到动词时看到点击。
- 弹窗/菜单步骤，先确认 `selectors.json` 里有弹窗内的选择器。
- 每步 actions 不要超过 6 个；复杂流程拆步。
- 最后一步之后脚本会自动留 800ms，不需要写 wait 800。

### 时长与导航（踩过的坑）

- record 是“**先执行完 actions，再按旁白时长补等待**”，不是边说边做。
- 估算：1 个 click ≈ 1.2s，1 个输入 ≈ 0.12s/字，1 个弹窗选择 ≈ 1s；`wait` 全部计入。
- 一步的预估动作时长必须 ≤ 旁白时长；否则会出现页面先切走、旁白还在讲上一页，或 3–8 秒静音。
- **导航 click 放在下一步 actions 开头**（“下一项/上一步/进入详情/提交”），不要放在上一步末尾。
- 逐步表单/向导：每页一步，前一页不点“下一项”，进入下一页时再点；不要把“下一项”和“讲解当页”塞进同一步。
- 一个弹窗操作链（打开 → 选两个参数 → 关掉 → 下一项）拆成 2–3 步，每步配旁白。
- 长流程（>25 步）先想清楚是否真要一镜到底；拆集或精简比硬塞更好。

## 发音

- `narration` 永远干净；拼音/CMU 只能出现在 `tts_text` 或 `lexicon`。
- 多音字：优先改写措辞避开；必须注音时，只替换那个字，用大写拼音+声调，例如 `重要` → `ZHONG4要`。
- 英文词/品牌名：TTS 只认 CMU 音素（如 `[B EY1 S]`），**不支持 IPA 符号**（`/siː/` 这种会被当字面量读）。
- 品牌名先问用户怎么读；确认后写进 lexicon，例如 `Acme` → `[AE1 K M IY0]`。中文近似音（如“阿克米”）容易和英文读音打架，能用音素就用音素。
- 改了品牌/多音字 lexicon 后，看 `out/durations.json` 第一段时长有没有异常暴涨；暴涨通常说明音素没被解析、被逐字母念了。
- 阿拉伯数字：不要留给 TTS；在 `tts_text` 里写汉字读法。`123` → `一百二十三`，`50%` → `百分之五十`，`v2.1` → `二点一版本`。
- 非语言标签（`[laughter]` 等）演示旁白不用。
- ü（`lv`/`nv`）和轻声官方示例未覆盖；不要自动使用，先问用户或单独实测。
- 全局词典放 `lexicon`，按匹配串长度从长到短、单次替换，不会二次替换。
- 专业表述不要自相矛盾：说“输运程序”就别同时声称“把平衡/加热/杂质耦合求解”；不确定时先问用户产品定位。

## 校验 + 审旁白

```bash
node .agents/skills/web-tour-video/scripts/pipeline.mjs validate --run runs/<slug>
```

通过后：
1. 读 `runs/<slug>/narration.md`。
2. 在聊天里输出“旁白审阅”：每步字幕、朗读文本、动作、lexicon/风险。
3. 问用户是否确认。
4. **停下来等回复。** 不要运行 audio。
5. 用户确认后由主 skill 运行 `pipeline.mjs approve`。

## Gate

- `validate` 0 错误。
- 每步有 narration 和 actions。
- 选择器全部来自 recon，不用猜。
- narration 无拼音/音素；tts 文本无阿拉伯数字。
- 每步预估动作时长 ≤ 旁白时长；导航 click 不在上一步末尾。
- 用户已确认旁白（approval hash 匹配）。

## 不要

- 不要生成音频。
- 不要录屏。
- 不要在 narration 里写“点击 [data-testid=...]”这种技术词。
- 不要把字幕写成朗读文本；字幕永远用 narration。
