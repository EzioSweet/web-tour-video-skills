# 选择器 Playbook

优先级：

1. `[data-testid="..."]`
2. role + accessible name
3. `[name="..."]` / `#id`
4. `[aria-label="..."]`
5. 稳定文本
6. CSS class（最后）

检查：

- 是否唯一匹配？`page.locator(sel).count()` 应为 1。
- 是否在目标状态可见？先点击打开弹窗再查。
- 是否在滚动后仍可见？`scrollIntoViewIfNeeded`。
- 是否被遮挡？`elementFromPoint` 检查中心点。

不要用：

- 绝对 XPath
- 带随机 hash 的 class
- 依赖位置的 `nth-child`
- 会随文案变化的 text（除非文案稳定）
