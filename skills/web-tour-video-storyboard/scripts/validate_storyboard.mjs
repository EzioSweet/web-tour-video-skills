#!/usr/bin/env node
/**
 * web-tour-video-storyboard/scripts/validate_storyboard.mjs
 *
 *   node .../validate_storyboard.mjs --run runs/sample
 *
 * 校验 storyboard.json，生成 narration.md（给用户审）和 work/pron_plan.md。
 * 这是 STORYBOARD 阶段的 gate；通过后必须停下来等用户确认旁白。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  fileHash,
  loadStoryboard,
  parseArgs,
  resolveRunDir,
  writeJson,
} from '../../web-tour-video/lib/common.mjs';
import {
  resolveTtsText,
  scanNarrationRisks,
  validateTtsText,
} from '../../web-tour-video/lib/pronunciation.mjs';
import { writeNarrationReview } from '../../web-tour-video/lib/report.mjs';

const args = parseArgs();
const runDir = resolveRunDir(args.flags.run || args._[0]);

const ALLOWED = new Set(['goto', 'click', 'type', 'scroll', 'hover', 'wait']);

function main() {
  const storyboard = loadStoryboard(runDir);
  const errors = [];
  const warnings = [];

  if (storyboard.steps.length > 60) errors.push(`步骤数 ${storyboard.steps.length} 过多，建议拆分`);
  else if (storyboard.steps.length > 30) warnings.push(`步骤数 ${storyboard.steps.length} 偏多，视频可能超过 5 分钟`);

  if (storyboard.width % 2 || storyboard.height % 2) errors.push('视频宽高必须是偶数');
  if (storyboard.steps.length === 0) errors.push('没有 steps');

  for (const step of storyboard.steps) {
    if (step.narration.length > 120) errors.push(`第 ${step.index} 步 narration 超过 120 字，建议拆成多步`);
    else if (step.narration.length > 60) warnings.push(`第 ${step.index} 步 narration ${step.narration.length} 字，可能超过 6 秒`);

    if (/\[[A-Z0-9 ]+\]/.test(step.narration) || /(?<=[\u3400-\u9fff])[A-Z]+[1-4]/.test(step.narration)) {
      errors.push(`第 ${step.index} 步 narration 含拼音/音素标记，字幕必须用干净原文`);
    }

    const resolved = resolveTtsText(step, storyboard.lexicon);
    const v = validateTtsText(resolved.text);
    for (const e of v.errors) errors.push(`第 ${step.index} 步朗读文本：${e}`);
    for (const w of v.warnings) warnings.push(`第 ${step.index} 步朗读文本：${w}`);

    if (!Array.isArray(step.actions) || step.actions.length === 0) {
      warnings.push(`第 ${step.index} 步没有 actions，画面会静止等待旁白`);
    }
    for (const [ai, action] of step.actions.entries()) {
      const where = `第 ${step.index} 步 action ${ai + 1}`;
      if (!action || typeof action !== 'object') {
        errors.push(`${where} 不是对象`);
        continue;
      }
      if (!ALLOWED.has(action.type)) {
        errors.push(`${where} 不支持的类型：${action.type}`);
        continue;
      }
      if (['click', 'type', 'hover'].includes(action.type) && !action.selector) {
        errors.push(`${where} (${action.type}) 缺少 selector`);
      }
      if (action.type === 'goto' && !action.url) errors.push(`${where} (goto) 缺少 url`);
      if (action.type === 'type' && typeof action.text !== 'string') errors.push(`${where} (type) 缺少 text`);
      if (action.type === 'scroll' && action.y === undefined && action.x === undefined) {
        errors.push(`${where} (scroll) 至少需要 x 或 y`);
      }
    }

    const risks = scanNarrationRisks(step.narration, {
      hits: resolved.hits,
      hasTtsText: resolved.source === 'tts_text',
    });
    for (const r of risks.filter((x) => x.handled === 'none')) {
      if (r.kind === '阿拉伯数字') {
        errors.push(`第 ${step.index} 步有未处理的阿拉伯数字“${r.text}”，请加 tts_text 写成汉字读法`);
      } else if (r.kind === '英文/缩写' || r.kind === '生僻字') {
        warnings.push(`第 ${step.index} 步风险未处理：${r.kind}“${r.text}” — ${r.suggestion}`);
      }
    }
  }

  const review = writeNarrationReview(runDir, storyboard);

  const result = {
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    approvalRequired: true,
    errors,
    warnings,
    steps: storyboard.steps.length,
    storyboardHash: fileHash(storyboard.file),
    narration: path.relative(process.cwd(), review.file),
    pronPlan: path.relative(process.cwd(), path.join(runDir, 'work', 'pron_plan.md')),
  };
  writeJson(path.join(runDir, 'work', 'validate.json'), result);

  console.log(`\n${errors.length ? '✗' : '✓'} storyboard 校验：${errors.length} 个错误，${warnings.length} 个警告`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  for (const w of warnings) console.warn(`  ! ${w}`);
  console.log(`\n→ ${result.narration}`);
  console.log(`→ ${result.pronPlan}`);
  console.log('\nWAITING_FOR_NARRATION_APPROVAL');
  console.log('请把 narration.md 的内容给用户审；用户确认后运行 pipeline.mjs approve --run <dir>，再进入 AUDIO。');

  if (errors.length) process.exit(2);
}

try {
  main();
} catch (err) {
  console.error(`\n✗ 校验失败：${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
