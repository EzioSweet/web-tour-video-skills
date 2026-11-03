# OmniVoice / OpenAI-compatible TTS

端点：

```http
POST http://localhost:8735/v1/audio/speech
Content-Type: application/json
```

body：

```json
{
  "model": "",
  "input": "朗读文本",
  "voice": "",
  "response_format": "mp3"
}
```

- 不需要 API Key；`TTS_API_KEY` 存在时带 `Authorization: Bearer`。
- `model` / `voice` 留空表示服务端默认。
- 服务没有 `/v1/models` 或 `/v1/audio/voices` 时不要编造值。
- 每段生成后用 ffprobe 读真实时长。
- 失败重试 2 次，仍失败报段号。
- 实际发送文本逐段写 `out/tts_texts.json`。

发音控制：

- 拼音：`打ZHE2`、`SHE2本`、`ZHE1腾`
- CMU：`[B EY1 S]`
- 非语言标签：`[laughter]` 等（演示不用）
