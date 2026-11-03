# QA Checklist

## 机械

- [ ] `final.mp4` 存在
- [ ] 视频 hevc / 音频 aac
- [ ] 1920x1080
- [ ] 时长与录屏一致
- [ ] `subs.srt` 无拼音/音素
- [ ] `tts_texts.json` 无阿拉伯数字
- [ ] 每段 narration 都出现在 SRT
- [ ] `pron_report.md` 存在

## 视觉

- [ ] 无页面报错/404
- [ ] 无空白页/加载中/骨架屏
- [ ] 弹窗没有意外遮挡
- [ ] 假光标每帧都在
- [ ] 点击落点正确
- [ ] 中文无方块字
- [ ] 字幕无拼音/音素/裁切
- [ ] 滚动/悬停/输入自然
- [ ] 没有点到错误元素
- [ ] 没有敏感数据

## 返工

- 旁白/字幕：storyboard → validate → 重新审 → audio
- 选择器/点击：storyboard actions → record
- 字幕样式/编码：render
- 抽帧/报告：qa

最多 3 轮。第 3 轮仍有问题，列未解决项，不要谎报通过。
