#!/usr/bin/env node
/**
 * web-tour-video-qa/scripts/qa.mjs
 *
 *   node .../qa.mjs --run runs/sample
 *
 * 机械自检 + 抽帧 + 生成 qa_report.md 骨架。
 * 视觉判断由 agent 逐张看图后补写到 qa_report.md。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  FFMPEG,
  ensureDir,
  ffprobeJson,
  fmtClock,
  loadStoryboard,
  parseArgs,
  readJson,
  resolveRunDir,
  runCapture,
  writeJson,
} from '../../web-tour-video/lib/common.mjs';
import { validateTtsText } from '../../web-tour-video/lib/pronunciation.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args.flags.run || args._[0]);
const OUT_DIR = path.join(runDir, 'out');
const FRAMES_DIR = path.join(OUT_DIR, 'frames');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function fail(message) {
  throw new Error(message);
}

function subtitleFilter() {
  const size = Number(process.env.SUB_FONT_SIZE || 12);
  const margin = Number(process.env.SUB_MARGIN_V || 26);
  const style = [
    'FontName=Noto Sans CJK SC',
    `FontSize=${size}`,
    'PrimaryColour=&H00FFFFFF',
    'OutlineColour=&H00000000',
    'BackColour=&H64000000',
    'BorderStyle=1',
    'Outline=1.5',
    'Shadow=0',
    `MarginV=${margin}`,
    'MarginL=80',
    'MarginR=80',
    'Alignment=2',
    'WrapStyle=0',
  ].join(',');
  return `subtitles=filename=subs.srt:force_style='${style}'`;
}

function extractFrames() {
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  ensureDir(FRAMES_DIR);

  let method = 'ffmpeg-final';
  try {
    runCapture(FFMPEG, ['-hide_banner', '-loglevel', 'warning', '-i', 'final.mp4', '-vf', 'fps=1/3', '-q:v', '2', 'frames/frame_%03d.jpg'], {
      cwd: OUT_DIR,
      timeout: 10 * 60_000,
    });
    log('✓ 已用 ffmpeg 从 final.mp4 抽帧');
  } catch (err) {
    const first = (err.message.split('\n').find((l) => l.trim()) || err.message).slice(0, 220);
    log(`  ! ffmpeg 无法从 final.mp4 抽帧：${first}`);

    let ok = false;
    const gst = spawnSync('gst-launch-1.0', ['--version'], { encoding: 'utf8' });
    if (!gst.error && gst.status === 0) {
      try {
        runCapture(
          'gst-launch-1.0',
          [
            '-e',
            'filesrc', 'location=final.mp4', '!',
            'qtdemux', '!', 'h265parse', '!', 'vah265dec', '!',
            'videoconvert', '!', 'videorate', '!',
            'video/x-raw,framerate=1/3', '!',
            'jpegenc', '!', 'multifilesink', 'location=frames/frame_%03d.jpg',
          ],
          { cwd: OUT_DIR, timeout: 3 * 60_000 },
        );
        const count = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.jpg')).length;
        if (count > 0) {
          method = 'gstreamer-vaapi';
          ok = true;
          log('✓ 已用 GStreamer VAAPI 从 final.mp4 抽帧（系统 ffmpeg 缺 HEVC 解码器）');
        }
      } catch (err2) {
        log(`  ! GStreamer 抽帧失败：${(err2.message.split('\n')[0] || err2.message).slice(0, 220)}`);
      }
    }

    if (!ok) {
      runCapture(FFMPEG, ['-hide_banner', '-loglevel', 'warning', '-i', 'video.webm', '-vf', `${subtitleFilter()},fps=1/3`, '-q:v', '2', 'frames/frame_%03d.jpg'], {
        cwd: OUT_DIR,
        timeout: 10 * 60_000,
      });
      method = 'ffmpeg-webm-with-subs';
      log('✓ 已用 ffmpeg 从 video.webm + 字幕滤镜抽帧');
    }
  }

  const frames = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.jpg')).sort();
  if (!frames.length) fail('抽帧失败：out/frames/ 为空');
  log(`✓ 已抽帧 ${frames.length} 张（${method}）`);
  return { method, frames };
}

function checkText(storyboard, durations) {
  const issues = [];
  const checks = [];
  const srtFile = path.join(OUT_DIR, 'subs.srt');
  const srt = fs.existsSync(srtFile) ? fs.readFileSync(srtFile, 'utf8') : '';
  if (!srt) issues.push('缺少 out/subs.srt');
  else {
    const hasCmu = /\[[A-Z0-9 ]+\]/.test(srt);
    const hasPinyin = /(?<=[\u3400-\u9fff])[A-Z]+[1-4]/.test(srt);
    checks.push({ name: 'SRT 无 CMU 音素', ok: !hasCmu });
    checks.push({ name: 'SRT 无拼音注音', ok: !hasPinyin });
    if (hasCmu) issues.push('subs.srt 中出现了 CMU 音素方括号');
    if (hasPinyin) issues.push('subs.srt 中出现了拼音注音');
  }

  const compactSrt = srt.replace(/\s+/g, '');
  for (const step of storyboard.steps) {
    const needle = step.narration.replace(/\s+/g, '');
    const ok = compactSrt.includes(needle);
    checks.push({ name: `步骤 ${step.index} 字幕存在`, ok });
    if (!ok) issues.push(`第 ${step.index} 步 narration 没有完整出现在 subs.srt 中`);
    if (/\[[A-Z0-9 ]+\]/.test(step.narration) || /(?<=[\u3400-\u9fff])[A-Z]+[1-4]/.test(step.narration)) {
      issues.push(`第 ${step.index} 步 narration 含拼音/音素标记`);
    }
  }

  if (!durations?.segments?.length) {
    issues.push('out/durations.json 缺少 segments');
  } else {
    checks.push({ name: '配音段数 = 分镜段数', ok: durations.segments.length === storyboard.steps.length });
    for (const seg of durations.segments) {
      const v = validateTtsText(seg.ttsText || '');
      if (!v.ok) issues.push(`第 ${seg.step} 步 ttsText 校验失败：${v.errors.join('；')}`);
    }
    const bad = durations.segments.filter((s) => validateTtsText(s.ttsText || '').errors.length);
    checks.push({ name: '朗读文本无阿拉伯数字', ok: bad.length === 0 });
  }

  const pron = path.join(OUT_DIR, 'pron_report.md');
  checks.push({ name: '发音报告存在', ok: fs.existsSync(pron) });
  if (!fs.existsSync(pron)) issues.push('缺少 out/pron_report.md');

  return { issues, checks };
}

function checkMedia(storyboard) {
  const issues = [];
  const checks = [];
  const file = path.join(OUT_DIR, 'final.mp4');
  if (!fs.existsSync(file)) {
    return { issues: ['缺少 out/final.mp4'], checks: [{ name: 'final.mp4 存在', ok: false }] };
  }
  const info = ffprobeJson(file);
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
  const duration = Number(info.format?.duration ?? video?.duration);

  checks.push({ name: '视频流存在', ok: Boolean(video) });
  checks.push({ name: '音频流存在', ok: Boolean(audio) });
  checks.push({ name: '视频编码 hevc', ok: video?.codec_name === 'hevc' });
  checks.push({ name: '音频编码 aac', ok: audio?.codec_name === 'aac' });
  checks.push({ name: `分辨率 ${storyboard.width}x${storyboard.height}`, ok: Number(video?.width) === storyboard.width && Number(video?.height) === storyboard.height });
  if (!video) issues.push('没有视频流');
  if (!audio) issues.push('没有音频流');
  if (video && video.codec_name !== 'hevc') issues.push(`视频编码是 ${video.codec_name}，不是 hevc`);
  if (audio && audio.codec_name !== 'aac') issues.push(`音频编码是 ${audio.codec_name}，不是 aac`);
  if (video && (Number(video.width) !== storyboard.width || Number(video.height) !== storyboard.height)) {
    issues.push(`分辨率是 ${video.width}x${video.height}，期望 ${storyboard.width}x${storyboard.height}`);
  }

  return { issues, checks, info: { duration, video, audio } };
}

function writeReport({ storyboard, timings, frames, textCheck, mediaCheck, encode, method }) {
  const lines = [];
  lines.push('# QA 报告');
  lines.push('');
  lines.push(`- 运行目录：\`${path.relative(process.cwd(), runDir) || runDir}\``);
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 视频：\`out/final.mp4\`  ${mediaCheck.info ? `${mediaCheck.info.video?.codec_name} ${mediaCheck.info.video?.width}x${mediaCheck.info.video?.height} / ${mediaCheck.info.audio?.codec_name} / ${Number(mediaCheck.info.duration).toFixed(3)}s` : '缺失'}`);
  lines.push(`- 编码：${encode ? `${encode.mode}${encode.fallbackReason ? `（${encode.fallbackReason}）` : ''}` : '未记录'}`);
  lines.push(`- 抽帧方式：${method}`);
  lines.push('');

  lines.push('## 时间轴');
  lines.push('');
  lines.push('| 步骤 | 起止 | 旁白时长 |');
  lines.push('|---:|---|---:|');
  for (const step of storyboard.steps) {
    const t = timings?.steps?.find((s) => s.index === step.index);
    const line = t ? `${fmtClock(t.startMs)} – ${fmtClock(t.endMs)}` : '—';
    const d = timings?.steps?.find((s) => s.index === step.index);
    lines.push(`| ${step.index} | ${line} | ${d ? `${Number(d.audioDurationSeconds).toFixed(2)}s` : '—'} |`);
  }
  lines.push('');

  lines.push('## 机械检查');
  lines.push('');
  lines.push('| 检查 | 结果 |');
  lines.push('|---|---|');
  for (const c of [...textCheck.checks, ...mediaCheck.checks]) {
    lines.push(`| ${c.name} | ${c.ok ? '✅' : '❌'} |`);
  }
  lines.push('');

  lines.push('## 抽帧');
  lines.push('');
  for (const f of frames) lines.push(`- \`out/frames/${f}\``);
  lines.push('');
  lines.push('> Agent 必须逐张查看上面的图，不要只看日志。');
  lines.push('');

  lines.push('## 视觉检查（待 agent 填写）');
  lines.push('');
  lines.push('- [ ] 无页面报错 / 404 / 控制台错误');
  lines.push('- [ ] 无空白页 / 加载中 / 骨架屏');
  lines.push('- [ ] 弹窗没有遮住关键内容（除非演示本身要展示弹窗）');
  lines.push('- [ ] 假光标在每一帧都存在，位置合理');
  lines.push('- [ ] 点击落点正确，按钮/输入框有响应');
  lines.push('- [ ] 中文没有方块字');
  lines.push('- [ ] 字幕没有拼音/音素标记，没有被裁切');
  lines.push('- [ ] 滚动/悬停/输入过程自然');
  lines.push('');
  lines.push('### 观察记录');
  lines.push('');
  lines.push('（待填写）');
  lines.push('');

  lines.push('## 机械问题');
  lines.push('');
  if (textCheck.issues.length || mediaCheck.issues.length) {
    for (const issue of [...textCheck.issues, ...mediaCheck.issues]) lines.push(`- ${issue}`);
  } else {
    lines.push('无。');
  }
  lines.push('');

  lines.push('## 结论');
  lines.push('');
  lines.push(textCheck.issues.length || mediaCheck.issues.length ? '❌ 机械检查未通过，先修复再继续。' : '⏳ 机械检查通过，等待视觉复核。');
  lines.push('');

  fs.writeFileSync(path.join(OUT_DIR, 'qa_report.md'), `${lines.join('\n')}\n`);
}

async function main() {
  const storyboard = loadStoryboard(runDir);
  const durationsFile = path.join(OUT_DIR, 'durations.json');
  const timingsFile = path.join(runDir, 'work', 'timings.json');
  const durations = fs.existsSync(durationsFile) ? readJson(durationsFile) : null;
  const timings = fs.existsSync(timingsFile) ? readJson(timingsFile) : null;
  const encodeFile = path.join(runDir, 'work', 'encode.json');
  const encode = fs.existsSync(encodeFile) ? readJson(encodeFile) : null;

  const { method, frames } = extractFrames();
  const textCheck = checkText(storyboard, durations);
  const mediaCheck = checkMedia(storyboard);

  const ok = textCheck.issues.length === 0 && mediaCheck.issues.length === 0;
  writeJson(path.join(runDir, 'work', 'qa.json'), {
    generatedAt: new Date().toISOString(),
    ok,
    visualOk: false,
    visualNotes: '',
    frameMethod: method,
    frames: frames.map((f) => `out/frames/${f}`),
    textIssues: textCheck.issues,
    mediaIssues: mediaCheck.issues,
    checks: [...textCheck.checks, ...mediaCheck.checks],
  });
  writeReport({ storyboard, timings, frames, textCheck, mediaCheck, encode, method });

  log(`\n${ok ? '✓ 机械检查通过' : '✗ 机械检查有问题'}：${textCheck.issues.length + mediaCheck.issues.length} 条`);
  if (!ok) {
    for (const issue of [...textCheck.issues, ...mediaCheck.issues]) warn(`  - ${issue}`);
  }
  log('FRAMES:');
  for (const f of frames) log(`  ${path.join(OUT_DIR, 'frames', f)}`);
  log(`  → out/qa_report.md`);
  log(`  → work/qa.json`);
  log('  下一步：逐张查看 frames/，把观察写进 out/qa_report.md；有问题回到对应阶段修。');
}

main().catch((err) => {
  console.error(`\n✗ QA 失败：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
