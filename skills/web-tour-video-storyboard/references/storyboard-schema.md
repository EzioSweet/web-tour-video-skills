# Storyboard Schema

顶层：

```json
{
  "url": "https://app.example.com",
  "storageState": "auth.json",
  "video": { "width": 1920, "height": 1080 },
  "chrome": { "height": 76, "title": "Example App", "url": "app.example.com" },
  "tts": { "model": "", "voice": "" },
  "lexicon": [],
  "steps": []
}
```

步骤：

```json
{
  "narration": "干净字幕原文",
  "tts_text": "可选，手写朗读文本，优先级最高",
  "chromeUrl": "可选；从这一步起地址栏显示这个 URL",
  "actions": []
}
```

浏览器外框（可选）：

- 写 `chrome` 后，录制视口变成 `video.height - chrome.height`（例：1080-76=1004），成片仍为 `video.height`。
- `chrome.height` 建议 72–80；页面高度必须是偶数。
- `chrome.url` 是初始地址；某一步需要地址变化时写该步的 `chromeUrl`，RENDER 会按该步起点切换地址栏。
- 外框是后期合成的，不含任何账号信息；不要用它伪造真实不存在的页面。

支持的 actions：

| type | 字段 | 说明 |
|---|---|---|
| `goto` | `url` | 跳转 |
| `click` | `selector` | 点击 |
| `type` | `selector`, `text`, `delay?`, `clear?` | 逐字输入 |
| `scroll` | `x?`, `y?` | 分步滚动 |
| `hover` | `selector`, `ms?` | 悬停 |
| `wait` | `ms` | 等待 |

约束：

- `narration` 必填、不能为空、不能含拼音/CMU 标记。
- `tts_text` 可选；一旦使用，不再应用 lexicon。
- `actions` 数组可以为空（只停留），但通常至少一个。
- 选择器必须来自 recon，不要猜。
- 视频宽高必须偶数。
