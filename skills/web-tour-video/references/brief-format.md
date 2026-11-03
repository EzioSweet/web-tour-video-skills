# Brief 格式

用户给 Markdown 即可，不要求 JSON。最小内容：

```md
# 目标
- 产品：Acme 后台
- 地址：https://app.example.com
- 登录态：auth.json
- 语言：中文
- 分辨率：1920x1080

# 演示流程
1. 打开首页，停留 2 秒
2. 点击右上角「新建任务」
3. 在弹窗输入「季度复盘」
4. 选择高优先级，点击创建
5. 向下滚动，展示任务列表和完成度

# 旁白要求
- 口语化，不要太营销
- 不要提“业界第一”
- 必须强调“数据会自动保存”

# 验收
- 不要出现真实客户姓名
- 不要展示价格为 0 的测试商品
```

## 解析规则

- `地址` 可以是绝对 URL；自测时也可以是相对 run 目录的本地路径（如 `../../fixtures/sample-app.html`）。
- `登录态` 默认 `auth.json`，相对 `runs/<slug>/`。缺失时按无登录处理；需要登录就停下来让用户生成。
- `分辨率` 默认 1920x1080；必须是偶数。
- 流程步骤要保留顺序；用户写得模糊时，先回显你理解的步骤，再继续。
- `旁白要求` 里的“必须强调/不要提”要写进对应步骤的 narration 或验收清单。
- 验收项写进 `work/brief.json` 的 `acceptance`，QA 时逐条检查。

## 生成 work/brief.json

```json
{
  "url": "https://app.example.com",
  "storageState": "auth.json",
  "language": "中文",
  "video": { "width": 1920, "height": 1080 },
  "goal": "展示新建任务流程",
  "flow": ["打开首页", "点击新建任务", "输入名称", "创建", "滚动展示"],
  "narration": { "tone": "口语化", "mustSay": ["数据会自动保存"], "avoid": ["业界第一"] },
  "acceptance": ["不出现真实客户姓名"]
}
```
