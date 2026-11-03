---
name: web-tour-video-recon
description: Inspect a target web app with Playwright and produce validated selectors, screenshots, login-state checks, and a recon report for the web-tour-video workflow. Use during the RECON phase.
metadata:
  execution-mode: native
  subagent-model: same-as-main
---

# Web Tour Video — Recon

> 执行模式：由 `web-tour-video` 主 agent 直接执行。若运行时采用 sub-agent，子 agent 的 model 必须与主 agent 完全一致。


目标：在写分镜之前，拿到真实页面结构、真实选择器、登录态和截图。**不要靠猜。**

## 前置

- 主 skill 已创建 `runs/<slug>/`，并写好 `work/brief.json`。
- 登录态：有桌面时可用 `npx playwright codegen --save-storage=auth.json <url>`；**无显示器/纯 tty 时不要用 codegen**，走下面的无头登录。

### 无显示器登录（headless）

```bash
cd runs/<slug>
printf '{"username":"...","password":"..."}' > work/secrets.json
chmod 600 work/secrets.json

node ../../.agents/skills/web-tour-video/scripts/headless-login.mjs \
  --url <登录页> --out auth.json --secrets work/secrets.json \
  --user-selector '#username' --pass-selector '#password' \
  --submit-selector 'button[type="submit"]' \
  --success-selector '<登录后的稳定元素>' \
  --screenshot work/recon/screenshots/login-check.png
```

通用脚本在 `.agents/skills/web-tour-video/scripts/headless-login.mjs`，项目相关的只是选择器参数。

- 凭据只放 `work/secrets.json`（已 gitignore）或环境变量，不要打印、不要贴进聊天。
- 登录成功后必须重新打开一次 `/`，确认不是登录页，并截一张 `work/recon/screenshots/login-check.png`。
- 登录接口/字段从真实页面拿（`input id`、按钮文本），不要猜。
- `auth.json` 含 cookie，不要提交；会话过期就重跑登录脚本。

## 命令

```bash
# 首页侦察
node .agents/skills/web-tour-video-recon/scripts/recon.mjs --run runs/<slug>

# 带动作探测（弹窗、二级菜单）
node .agents/skills/web-tour-video-recon/scripts/recon.mjs \
  --run runs/<slug> \
  --actions runs/<slug>/work/recon/probe.json
```

`probe.json` 是动作数组，和 storyboard 的 actions 同格式：

```json
[
  { "type": "click", "selector": "[data-testid=\"new-task\"]" },
  { "type": "wait", "ms": 500 }
]
```

脚本会输出：
- `work/recon/recon.md`
- `work/recon/summary.json`
- `work/recon/elements-00-home.json`
- `work/recon/elements-probe-NN.json`
- `work/recon/screenshots/*.png`

## 流程

1. 读 `recon.md`，看标题、控制台错误、失败请求、页面文字、元素表。
2. 看 `screenshots/00-home.png`，确认页面不是登录页/空页/错误页。
3. 对流程里需要弹窗/菜单的步骤，写 `probe.json`，再跑一次，拿到弹窗内元素。
4. 多步向导/表单：先用 `probe.json` 把所有步骤名、关键输入 id、下一步/提交按钮探完；不要把 12 步向导留到 RECORD 才第一次走。
5. 输入框 id 含点号（如 `time-70.0000`）时，CSS 要写 `[id="time-70.0000"]`，不要写 `#time-70.0000`。
6. 为每个动作选 1 个选择器，写 `work/recon/selectors.json`：

```json
{
  "steps": [
    {
      "step": 2,
      "selector": "[data-testid=\"new-task\"]",
      "confidence": "high",
      "note": "任务面板右上角；probe 后仍可见"
    },
    {
      "step": 3,
      "target": "任务名称输入框",
      "selector": "[data-testid=\"task-input\"]",
      "confidence": "high"
    },
    {
      "step": 4,
      "target": "优先级 + 创建",
      "selectors": ["[data-testid=\"priority-high\"]", "[data-testid=\"create-task\"]"],
      "confidence": "high"
    }
  ]
}
```

一个步骤有多个动作时，用 `selectors` 数组；只有一个目标时用 `selector`。

## 选择器优先级

1. `[data-testid="..."]`
2. `[role="button"]` + accessible name / `getByRole`
3. `[name="..."]`、`#id`
4. `[aria-label="..."]`
5. 稳定文本（`text=...` / `getByText`）
6. CSS class（最后手段，容易随样式变化）

## Gate

- 每个需要点击/输入/悬停的步骤都有选择器；多动作步骤用 `selectors` 数组。
- 选择器在截图中真实可见，或经过 probe 后可见。
- 没有多个元素同时匹配同一选择器（如果有，换成更具体的）。
- 登录态有效；如果页面跳到登录页，停下让用户生成 auth.json。
- 页面有报错/404/空白，先停下告诉用户，不要继续写分镜。
- 向导的“下一步/查看总结/提交”都已真实点到过；提交类操作有用户授权。

## 不要

- 不要在这个阶段写旁白。
- 不要把低置信度选择器硬塞进 storyboard。
- 不要修改页面数据，除非用户明确要求；探测优先用只读操作。
- **不要默认点“提交/发布/支付/删除”**。提交会创建真实记录、占用资源；必须用户明确授权。
- 侦察阶段为了看等待页而提交时：记下新建的 case id（如 #5、#6），并在交付时告知用户“测试提交留下了哪些记录”，避免重复提交、把账号刷满。
- 导出类按钮会触发下载；确认 `acceptDownloads`，且下载文件不要留在 run 目录里冒充产物。
