#!/usr/bin/env node
/**
 * web-tour-video-audio/scripts/tts.mjs
 *
 *   node .../tts.mjs --run runs/sample
 *   node .../tts.mjs --run runs/sample --pron-test
 *   node .../tts.mjs --text "测试" --out /tmp/test.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir,
  loadStoryboard,
  parseArgs,
  probeDuration,
  readJson,
  resolveRunDir,
  sleep,
  writeJson,
} from '../../web-tour-video/lib/common.mjs';
import { buildTtsConfig } from '../../web-tour-video/lib/tts-config.mjs';
import {
  resolveTtsText,
  validateTtsText,
} from '../../web-tour-video/lib/pronunciation.mjs';
import { writePronReport } from '../../web-tour-video/lib/report.mjs';

const args = parseArgs();
const runArg = typeof args.flags.run === 'string' ? args.flags.run : args._[0];
const runDir = runArg ? resolveRunDir(runArg) : null;

/* ------------------------------------------------------------------ */
/* 单段合成                                                            */
/* ------------------------------------------------------------------ */

export async function synthesize({ text, outFile, config, label = '旁白' }) {
  if (!text || !text.trim()) throw new Error(`${label} 的朗读文本为空`);
  if (!config?.baseUrl) throw new Error('TTS baseUrl 未配置');

  const endpoint = `${config.baseUrl}/v1/audio/speech`;
  const body = {
    model: config.model ?? '',
    input: text,
    voice: config.voice ?? '',
    response_format: config.responseFormat || 'mp3',
  };
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  ensureDir(path.dirname(outFile));
  const tmp = `${outFile}.part`;
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 500);
        throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 800) throw new Error(`返回音频过小（${buf.length} 字节）`);
      fs.writeFileSync(tmp, buf);
      const duration = probeDuration(tmp);
      fs.renameSync(tmp, outFile);
      return { duration, bytes: buf.length, attempts: attempt, elapsedMs: Date.now() - started, endpoint };
    } catch (err) {
      lastError = err;
      fs.rmSync(tmp, { force: true });
      if (attempt < 3) {
        const waitMs = 800 * attempt;
        console.warn(`  ! ${label} TTS 第 ${attempt} 次失败：${err.message}；${waitMs}ms 后重试`);
        await sleep(waitMs);
      }
    }
  }

  throw new Error(`${label} 的 TTS 调用失败（已重试 2 次）：${lastError?.message || lastError}`);
}

/* ------------------------------------------------------------------ */
/* 发音实测                                                            */
/* ------------------------------------------------------------------ */

export async function runPronunciationTest(config, outDir) {
  ensureDir(outDir);
  const cases = [
    { id: 'a', file: 'a.mp3', text: '这批货物打折出售后他严重亏本了，再也经不起折腾了。', desc: '不注音' },
    { id: 'b', file: 'b.mp3', text: '这批货物打ZHE2出售后他严重SHE2本了，再也经不起ZHE1腾了。', desc: '注音' },
    { id: 'c', file: 'c.mp3', text: 'He plays the [B EY1 S] guitar while catching a [B AE1 S] fish.', desc: 'CMU 音素' },
    { id: 'c_plain', file: 'c_plain.mp3', text: 'He plays the bass guitar while catching a bass fish.', desc: '英文对照' },
  ];

  const results = [];
  for (const c of cases) {
    const outFile = path.join(outDir, c.file);
    console.log(`  · 生成 ${c.file}（${c.desc}）...`);
    const r = await synthesize({ text: c.text, outFile, config, label: `发音实测 ${c.id}` });
    results.push({ ...c, duration: r.duration, bytes: r.bytes });
    console.log(`    ${c.file}: ${r.duration.toFixed(3)}s, ${r.bytes} 字节`);
  }

  const a = results.find((r) => r.id === 'a');
  const b = results.find((r) => r.id === 'b');
  const c = results.find((r) => r.id === 'c');
  const cPlain = results.find((r) => r.id === 'c_plain');
  const delta = b.duration - a.duration;
  const ratio = delta / a.duration;
  const suspicious = delta > 1.2 || ratio > 0.35;
  const borderline = !suspicious && (delta > 0.35 || ratio > 0.1);

  const summary = {
    createdAt: new Date().toISOString(),
    tts: { baseUrl: config.baseUrl, model: config.model, voice: config.voice },
    durations: Object.fromEntries(results.map((r) => [r.id, r.duration])),
    bMinusA: Number(delta.toFixed(3)),
    bVsARatio: Number(ratio.toFixed(3)),
    cMinusPlain: Number((c.duration - cPlain.duration).toFixed(3)),
    interpretation: suspicious
      ? 'b 明显比 a 长：服务很可能把 ZHE2 当字母读，暂时不要继续正式录制。'
      : borderline
        ? `b 比 a 长 ${delta.toFixed(3)}s（${(ratio * 100).toFixed(1)}%）：未达到“明显更长”的阈值，但也不是完全一致。请人耳确认 b 里是不是“打折 / 亏本 / 折腾”，而不是“zhe er / she er”。`
        : 'a/b 时长几乎一致：标记大概率被正确解析（但仍需人耳确认多音字是否读对）。',
    files: results.map((r) => ({ id: r.id, file: path.join(outDir, r.file), seconds: r.duration })),
  };
  writeJson(path.join(outDir, 'report.json'), summary);
  return summary;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function prepareAudioOut(runDir) {
  const out = path.join(runDir, 'out');
  ensureDir(out);
  // 配音变化会让录屏/编码/QA 全部失效，清掉下游产物。
  for (const name of ['subs.srt', 'final.mp4', 'video.webm', 'raw_video', 'frames', 'qa_report.md', 'durations.json', 'tts_texts.json', 'pron_report.md']) {
    fs.rmSync(path.join(out, name), { recursive: true, force: true });
  }
  for (const f of fs.readdirSync(out)) {
    if (/^a\d+\.mp3$/.test(f)) fs.rmSync(path.join(out, f), { force: true });
  }
  for (const name of ['timings.json', 'encode.json', 'qa.json']) {
    fs.rmSync(path.join(runDir, 'work', name), { force: true });
  }
}

async function main() {
  if (args.flags.text) {
    const outFile = path.resolve(String(args.flags.out || '/tmp/tts_test.mp3'));
    const config = buildTtsConfig({});
    const r = await synthesize({ text: String(args.flags.text), outFile, config, label: '单段测试' });
    console.log(`✓ ${outFile}  ${r.duration.toFixed(3)}s  ${r.bytes} 字节`);
    return;
  }

  const activeRun = runDir || resolveRunDir('runs/sample');
  const storyboard = loadStoryboard(activeRun);
  const config = buildTtsConfig(storyboard.tts);
  const outDir = path.join(activeRun, 'out');

  if (args.flags['pron-test']) {
    console.log('\n▶ 发音实测：生成 a / b / c');
    const summary = await runPronunciationTest(config, path.join(outDir, 'pron_test'));
    console.log('\n✓ 发音实测完成');
    console.log(`  a.mp3：${summary.durations.a.toFixed(3)}s`);
    console.log(`  b.mp3：${summary.durations.b.toFixed(3)}s`);
    console.log(`  c.mp3：${summary.durations.c.toFixed(3)}s`);
    console.log(`  b - a：${summary.bMinusA.toFixed(3)}s（${(summary.bVsARatio * 100).toFixed(1)}%）`);
    console.log(`  判断：${summary.interpretation}`);
    console.log(`  文件：${path.join(outDir, 'pron_test')}/a.mp3, b.mp3, c.mp3`);
    return;
  }

  console.log(`\n▶ 配音：${storyboard.steps.length} 段`);
  console.log(`  TTS: ${config.baseUrl}  model=${config.model || '(服务端默认)'}  voice=${config.voice || '(服务端默认)'}`);

  // 先全部校验，避免生成到一半才发现数字/拼音问题。
  const resolvedSteps = storyboard.steps.map((step) => {
    const resolved = resolveTtsText(step, storyboard.lexicon);
    const validation = validateTtsText(resolved.text);
    if (!validation.ok) {
      throw new Error(
        `第 ${step.index} 步朗读文本校验失败：\n- ${validation.errors.join('\n- ')}\n` +
          `  narration: ${step.narration}\n` +
          '  请在该步加 tts_text，把数字写成汉字读法；英文用 [CMU 音素]；多音字用合法拼音+声调。',
      );
    }
    for (const w of validation.warnings) console.warn(`  ! 第 ${step.index} 步：${w}`);
    return { step, resolved, validation };
  });

  prepareAudioOut(activeRun);
  const segments = [];

  for (const { step, resolved, validation } of resolvedSteps) {
    const audioRel = `a${String(step.index).padStart(2, '0')}.mp3`;
    const audioFile = path.join(outDir, audioRel);
    console.log(`  [${step.index}/${storyboard.steps.length}] ${resolved.text}（${resolved.source}）`);
    const result = await synthesize({ text: resolved.text, outFile: audioFile, config, label: `第 ${step.index} 步` });
    console.log(`    → ${audioRel}  ${result.duration.toFixed(3)}s，尝试 ${result.attempts} 次`);

    segments.push({
      step: step.index,
      narration: step.narration,
      ttsText: resolved.text,
      source: resolved.source,
      lexiconHits: resolved.hits,
      markers: validation.markers,
      warnings: validation.warnings,
      audio: audioRel,
      durationSeconds: Number(result.duration.toFixed(3)),
      attempts: result.attempts,
    });

    const data = {
      generatedAt: new Date().toISOString(),
      tts: { baseUrl: config.baseUrl, model: config.model, voice: config.voice, responseFormat: config.responseFormat },
      lexicon: storyboard.lexicon,
      segments,
    };
    writeJson(path.join(outDir, 'tts_texts.json'), data);
    writeJson(path.join(outDir, 'durations.json'), data);
  }

  const total = segments.reduce((a, s) => a + s.durationSeconds, 0);
  console.log(`✓ ${segments.length} 段完成，总时长 ${total.toFixed(2)}s`);
  writePronReport(activeRun, storyboard, { tts: { baseUrl: config.baseUrl, model: config.model, voice: config.voice }, segments }, null);
  console.log(`  → out/tts_texts.json`);
  console.log(`  → out/durations.json`);
  console.log(`  → out/pron_report.md（时间轴待录屏后补）`);
}

main().catch((err) => {
  console.error(`\n✗ 配音失败：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
