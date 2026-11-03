import fs from 'node:fs';
import path from 'node:path';
import {
  fmtClock,
  readJson,
  writeJson,
} from './common.mjs';
import {
  resolveTtsText,
  scanNarrationRisks,
} from './pronunciation.mjs';

function findTiming(timings, index) {
  return timings?.steps?.find((s) => s.index === index) || null;
}

function findDuration(durations, index) {
  return durations?.segments?.find((s) => s.step === index) || null;
}

function findEncoder(runDir) {
  const file = path.join(runDir, 'work', 'encode.json');
  return fs.existsSync(file) ? readJson(file) : null;
}

function findVideoInfo(runDir) {
  const file = path.join(runDir, 'work', 'encode.json');
  if (!fs.existsSync(file)) return null;
  const data = readJson(file);
  return data.video || null;
}

/** 写 runs/<slug>/narration.md 和 work/pron_plan.md，供人工审旁白。 */
export function writeNarrationReview(runDir, storyboard) {
  const prepared = storyboard.steps.map((step) => {
    const resolved = resolveTtsText(step, storyboard.lexicon);
    const risks = scanNarrationRisks(step.narration, {
      hits: resolved.hits,
      hasTtsText: resolved.source === 'tts_text',
    });
    return { step, resolved, risks };
  });

  const lines = [];
  lines.push('# 旁白审阅');
  lines.push('');
  lines.push(`- 运行目录：\`${path.relative(process.cwd(), runDir) || runDir}\``);
  lines.push(`- 目标：${storyboard.url}`);
  lines.push(`- 步骤数：${prepared.length}`);
  lines.push('');
  lines.push('> 请逐段看“字幕”和“朗读”两行。确认后回复“旁白确认”或“继续”；要改就指出步骤号。');
  lines.push('> 在确认前，音频/录屏/编码不会开始。');
  lines.push('> 这是生成物，不要直接编辑；改 `storyboard.json` 后重新运行 validate。');
  lines.push('');

  for (const { step, resolved, risks } of prepared) {
    lines.push(`## 步骤 ${step.index}`);
    lines.push('');
    lines.push('**动作**');
    if (step.actions.length === 0) lines.push('- （无动作，只等待）');
    for (const action of step.actions) {
      const bits = [`- ${action.type}`];
      if (action.selector) bits.push(`\`${action.selector}\``);
      if (action.url) bits.push(action.url);
      if (action.text !== undefined) bits.push(`text=${JSON.stringify(action.text)}`);
      if (action.x !== undefined) bits.push(`x=${action.x}`);
      if (action.y !== undefined) bits.push(`y=${action.y}`);
      if (action.ms !== undefined) bits.push(`${action.ms}ms`);
      lines.push(bits.join(' '));
    }
    lines.push('');
    lines.push(`**字幕（narration）**：${step.narration}`);
    lines.push('');
    lines.push(`**朗读（TTS）**：${resolved.text}`);
    lines.push('');
    lines.push(`- 朗读来源：${resolved.source}`);
    if (resolved.hits.length) {
      lines.push(`- lexicon：${resolved.hits.map((h) => `“${h.match}” → “${h.tts}”`).join('；')}`);
    }
    if (risks.length) {
      lines.push('- 风险点：');
      for (const r of risks) {
        lines.push(`  - ${r.kind}“${r.text}”：${r.handling}；建议 ${r.suggestion}`);
      }
    }
    lines.push('');
  }

  lines.push('## 确认清单');
  lines.push('');
  lines.push('- [ ] 旁白语气和长度合适');
  lines.push('- [ ] 没有把不该出现的信息读出来');
  lines.push('- [ ] 多音字/品牌名/英文缩写处理可接受');
  lines.push('- [ ] 动作顺序和页面状态一致');
  lines.push('');

  const file = path.join(runDir, 'narration.md');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  // 发音风险计划
  const pron = [];
  pron.push('# 发音处理计划');
  pron.push('');
  for (const { step, resolved, risks } of prepared) {
    pron.push(`## 步骤 ${step.index}`);
    pron.push('');
    pron.push(`- 字幕：${step.narration}`);
    pron.push(`- 朗读：${resolved.text}`);
    if (resolved.hits.length) {
      for (const h of resolved.hits) {
        pron.push(`- 注音：\`${h.match}\` → \`${h.tts}\`（原位置 ${h.at}）`);
      }
    }
    if (!risks.length) {
      pron.push('- 风险：未发现');
    } else {
      for (const r of risks) {
        pron.push(`- 风险：${r.kind}“${r.text}” — ${r.handling}；建议 ${r.suggestion}`);
      }
    }
    pron.push('');
  }
  pron.push('> 脚本不做听觉判断；ü/轻声/未知品牌名请人工确认后再用。');
  pron.push('');
  writeJson(path.join(runDir, 'work', 'pron_plan.json'), { steps: prepared.map(({ step, resolved, risks }) => ({ step: step.index, narration: step.narration, ttsText: resolved.text, source: resolved.source, hits: resolved.hits, risks })) });
  fs.writeFileSync(path.join(runDir, 'work', 'pron_plan.md'), `${pron.join('\n')}\n`);

  return { file, prepared };
}

/** 写 out/pron_report.md。timings 可为空（配音阶段）。 */
export function writePronReport(runDir, storyboard, durations, timings = null) {
  const encoder = findEncoder(runDir);
  const videoInfo = findVideoInfo(runDir);
  const offset = Number(process.env.OFFSET_MS ?? 0);
  const lines = [];

  lines.push('# 发音与时间轴报告');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  if (videoInfo) {
    lines.push(`- 视频：${videoInfo.width}x${videoInfo.height} / ${videoInfo.videoCodec} / ${Number(videoInfo.duration).toFixed(3)}s`);
  } else {
    lines.push('- 视频：尚未渲染');
  }
  if (encoder) {
    lines.push(`- 编码模式：${encoder.mode}${encoder.fallbackReason ? `（回退原因：${encoder.fallbackReason}）` : ''}`);
  } else {
    lines.push('- 编码模式：尚未编码');
  }
  lines.push(`- OFFSET：${offset} ms`);
  lines.push(`- TTS：${durations?.tts?.baseUrl || '(未记录)'}  model=${durations?.tts?.model || '(服务端默认)'}  voice=${durations?.tts?.voice || '(服务端默认)'}`);
  lines.push('');

  lines.push('## 每段旁白与时间轴');
  lines.push('');
  lines.push('| 步骤 | 画面起点 | 画面终点 | 旁白时长 | 朗读文本来源 | lexicon 命中 |');
  lines.push('|---:|---|---|---:|---|---|');
  for (const step of storyboard.steps) {
    const t = findTiming(timings, step.index);
    const d = findDuration(durations, step.index);
    const hits = d?.lexiconHits?.length ? d.lexiconHits.map((h) => `${h.match}→${h.tts}`).join('；') : '—';
    lines.push(
      `| ${step.index} | ${t ? fmtClock(t.startMs) : '—'} | ${t ? fmtClock(t.endMs) : '—'} | ${d ? `${Number(d.durationSeconds).toFixed(2)}s` : '—'} | ${d?.source || '—'} | ${hits} |`,
    );
  }
  lines.push('');

  for (const step of storyboard.steps) {
    const t = findTiming(timings, step.index);
    const d = findDuration(durations, step.index);
    lines.push(`### 步骤 ${step.index}  ${t ? `${fmtClock(t.startMs)} – ${fmtClock(t.endMs)}` : '时间待录屏'}`);
    lines.push('');
    lines.push(`- 字幕（narration）：${step.narration}`);
    lines.push(`- 实际朗读文本（tts）：${d?.ttsText || '未生成'}`);
    if (d) lines.push(`- 音频：out/${d.audio}（${Number(d.durationSeconds).toFixed(3)}s）`);
    if (d?.lexiconHits?.length) {
      lines.push(`- lexicon：${d.lexiconHits.map((h) => `“${h.match}” → “${h.tts}”`).join('；')}`);
    }
    if (d?.warnings?.length) lines.push(`- 朗读文本警告：${d.warnings.join('；')}`);
    lines.push('');
  }

  lines.push('## 注音 / 音素清单（只听这些位置）');
  lines.push('');
  const rows = [];
  for (const step of storyboard.steps) {
    const t = findTiming(timings, step.index);
    const d = findDuration(durations, step.index);
    for (const m of d?.markers || []) {
      rows.push(
        `| ${step.index} | ${t ? `${fmtClock(t.startMs)} – ${fmtClock(t.endMs)}` : '—'} | ${m.type} | \`${m.text}\` | ${step.narration.slice(0, 30)}… |`,
      );
    }
  }
  if (rows.length) {
    lines.push('| 步骤 | 步骤起止 | 类型 | 标记 | 旁白片段 |');
    lines.push('|---:|---|---|---|---|');
    lines.push(...rows);
  } else {
    lines.push('本次没有使用任何拼音或 CMU 音素标记。');
  }
  lines.push('');

  lines.push('## 风险点扫描与处理方案');
  lines.push('');
  const riskRows = [];
  for (const step of storyboard.steps) {
    const d = findDuration(durations, step.index);
    const resolved = d ? { hits: d.lexiconHits || [], text: d.ttsText, source: d.source } : resolveTtsText(step, storyboard.lexicon);
    const risks = scanNarrationRisks(step.narration, {
      hits: resolved.hits || [],
      hasTtsText: resolved.source === 'tts_text',
    });
    for (const r of risks) {
      riskRows.push(`| ${step.index} | ${r.kind} | ${r.text} | …${r.context}… | ${r.handling} | ${r.suggestion} |`);
    }
  }
  if (riskRows.length) {
    lines.push('| 步骤 | 类型 | 风险点 | 上下文 | 处理 | 建议 |');
    lines.push('|---:|---|---|---|---|---|');
    lines.push(...riskRows);
  } else {
    lines.push('未发现风险点。');
  }
  lines.push('');

  lines.push('## 发音实测 a / b / c');
  lines.push('');
  const pronReport = path.join(runDir, 'out', 'pron_test', 'report.json');
  if (fs.existsSync(pronReport)) {
    const r = readJson(pronReport);
    lines.push(`- a.mp3：${Number(r.durations.a).toFixed(3)}s`);
    lines.push(`- b.mp3：${Number(r.durations.b).toFixed(3)}s`);
    lines.push(`- c.mp3：${Number(r.durations.c).toFixed(3)}s`);
    if (r.durations.c_plain !== undefined) {
      lines.push(`- c_plain.mp3（英文不注音对照）：${Number(r.durations.c_plain).toFixed(3)}s`);
      lines.push(`- c - c_plain = ${Number(r.cMinusPlain).toFixed(3)}s`);
    }
    lines.push(`- b - a = ${Number(r.bMinusA).toFixed(3)}s（${(Number(r.bVsARatio) * 100).toFixed(1)}%）`);
    lines.push(`- 判断：${r.interpretation}`);
    lines.push('');
    lines.push('请人工试听：`out/pron_test/a.mp3`、`b.mp3`、`c.mp3`。');
  } else {
    lines.push('本次运行未找到 out/pron_test/report.json。需要时运行 `--pron-test`。');
  }
  lines.push('');

  lines.push('## 仍未验证 / 需要你确认');
  lines.push('');
  lines.push('- 脚本不做听觉判断；多音字是否读对只能人耳确认。');
  lines.push('- 本机没有 whisper / faster-whisper 等 ASR；即使有，ASR 也检测不出多音字错误。');
  lines.push('- ü（lv / nv）与轻声标记官方示例未覆盖；未实测通过前不要用于正式旁白。');
  lines.push('- TTS 若没有暴露 /v1/models 或 /v1/audio/voices，model/voice 留空表示使用服务端默认。');
  lines.push('');

  fs.writeFileSync(path.join(runDir, 'out', 'pron_report.md'), `${lines.join('\n')}\n`);
}
