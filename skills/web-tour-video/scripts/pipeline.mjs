#!/usr/bin/env node
/**
 * web-tour-video/scripts/pipeline.mjs — 主工作流调度器。
 *
 *   node .../pipeline.mjs doctor   --run runs/sample
 *   node .../pipeline.mjs validate --run runs/sample
 *   node .../pipeline.mjs approve  --run runs/sample
 *   node .../pipeline.mjs audio    --run runs/sample
 *   node .../pipeline.mjs record   --run runs/sample
 *   node .../pipeline.mjs render   --run runs/sample
 *   node .../pipeline.mjs qa       --run runs/sample
 *   node .../pipeline.mjs all      --run runs/sample
 *   node .../pipeline.mjs status   --run runs/sample
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PROJECT_ROOT,
  fileHash,
  parseArgs,
  readJson,
  resolveRunDir,
  writeJson,
} from '../lib/common.mjs';

const args = parseArgs();
const command = args._[0] || 'help';
const force = Boolean(args.flags.force);
const runArg = args.flags.run || args._[1];
const runDir = runArg ? resolveRunDir(runArg) : null;
const skillsDir = path.resolve(import.meta.dirname, '../..');

const scripts = {
  validate: path.join(skillsDir, 'web-tour-video-storyboard/scripts/validate_storyboard.mjs'),
  audio: path.join(skillsDir, 'web-tour-video-audio/scripts/tts.mjs'),
  record: path.join(skillsDir, 'web-tour-video-record/scripts/record.mjs'),
  render: path.join(skillsDir, 'web-tour-video-render/scripts/render.mjs'),
  qa: path.join(skillsDir, 'web-tour-video-qa/scripts/qa.mjs'),
  recon: path.join(skillsDir, 'web-tour-video-recon/scripts/recon.mjs'),
  doctor: path.join(import.meta.dirname, 'doctor.mjs'),
};

function updateState(phase, status = 'ok') {
  if (!runDir) return;
  const file = path.join(runDir, 'work', 'state.json');
  let prev = {};
  if (fs.existsSync(file)) {
    try { prev = readJson(file); } catch { prev = {}; }
  }
  writeJson(file, { ...prev, phase, status, updatedAt: new Date().toISOString() });
}

function requireRun() {
  if (!runDir) {
    console.error('缺少 --run：例如 --run runs/2026-01-01-app-demo');
    process.exit(1);
  }
}

function run(script, extra = [], phase = path.basename(script, '.mjs'), withRun = true) {
  const runArgs = withRun ? ['--run', runDir] : [];
  const r = spawnSync(process.execPath, [script, ...runArgs, ...extra], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.error) throw new Error(`无法执行 ${script}：${r.error.message}`);
  if (r.status !== 0) {
    updateState(phase, 'failed');
    process.exit(r.status ?? 1);
  }
  updateState(phase);
}

function storyboardHash() {
  const file = path.join(runDir, 'storyboard.json');
  if (!fs.existsSync(file)) throw new Error(`缺少 storyboard.json：${file}`);
  return fileHash(file);
}

function approved() {
  try {
    const file = path.join(runDir, 'work', 'approval.json');
    if (!fs.existsSync(file)) return { ok: false, reason: '没有 work/approval.json' };
    const data = readJson(file);
    if (!data.approved) return { ok: false, reason: 'approval.approved 不为 true' };
    const current = storyboardHash();
    if (data.storyboardHash !== current) return { ok: false, reason: 'storyboard.json 在确认后又被修改' };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function requireApproval() {
  const a = approved();
  if (a.ok) return;
  if (force) {
    console.warn(`! 跳过旁白确认（--force）：${a.reason}`);
    return;
  }
  console.error(`\n✗ 旁白尚未确认：${a.reason}`);
  console.error(`  1. 先看 ${path.join(runDir, 'narration.md')}`);
  console.error(`  2. 用户确认后运行：node .agents/skills/web-tour-video/scripts/pipeline.mjs approve --run ${path.relative(PROJECT_ROOT, runDir)}`);
  console.error('  3. 再运行 audio / all');
  process.exit(3);
}

function approve() {
  const validateFile = path.join(runDir, 'work', 'validate.json');
  if (!fs.existsSync(validateFile)) {
    console.error('✗ 还没有 work/validate.json，不能记录旁白确认。先运行 validate。');
    process.exit(4);
  }
  const v = readJson(validateFile);
  if (!v.ok) {
    console.error('✗ storyboard 校验未通过，不能记录旁白确认。先运行 validate 并修复错误。');
    process.exit(4);
  }
  const hash = storyboardHash();
  if (v.storyboardHash !== hash) {
    console.error('✗ validate.json 不是当前 storyboard 的校验结果。先重新运行 validate，再让用户审。');
    process.exit(4);
  }
  writeJson(path.join(runDir, 'work', 'approval.json'), {
    approved: true,
    storyboardHash: hash,
    approvedAt: new Date().toISOString(),
    approvedBy: 'user',
  });
  updateState('approved');
  console.log(`✓ 已记录旁白确认：${path.join(runDir, 'work', 'approval.json')}`);
  console.log(`  storyboard hash: ${hash.slice(0, 16)}…`);
}

function status() {
  const items = [
    ['brief', path.join(runDir, 'brief.md')],
    ['brief.json', path.join(runDir, 'work', 'brief.json')],
    ['state.json', path.join(runDir, 'work', 'state.json')],
    ['recon.md', path.join(runDir, 'work', 'recon', 'recon.md')],
    ['selectors.json', path.join(runDir, 'work', 'recon', 'selectors.json')],
    ['storyboard.json', path.join(runDir, 'storyboard.json')],
    ['narration.md', path.join(runDir, 'narration.md')],
    ['validate.json', path.join(runDir, 'work', 'validate.json')],
    ['approval.json', path.join(runDir, 'work', 'approval.json')],
    ['durations.json', path.join(runDir, 'out', 'durations.json')],
    ['video.webm', path.join(runDir, 'out', 'video.webm')],
    ['timings.json', path.join(runDir, 'work', 'timings.json')],
    ['subs.srt', path.join(runDir, 'out', 'subs.srt')],
    ['final.mp4', path.join(runDir, 'out', 'final.mp4')],
    ['encode.json', path.join(runDir, 'work', 'encode.json')],
    ['frames/', path.join(runDir, 'out', 'frames')],
    ['qa_report.md', path.join(runDir, 'out', 'qa_report.md')],
    ['pron_report.md', path.join(runDir, 'out', 'pron_report.md')],
  ];
  console.log(`\nrun: ${runDir}\n`);
  for (const [name, file] of items) {
    const exists = fs.existsSync(file);
    let extra = '';
    if (exists && fs.statSync(file).isFile()) extra = ` (${fs.statSync(file).size} B)`;
    console.log(`  ${exists ? '✓' : '·'} ${name}${extra}`);
  }
  const stateFile = path.join(runDir, 'work', 'state.json');
  if (fs.existsSync(stateFile)) {
    const st = readJson(stateFile);
    console.log(`\nstate：${st.phase || '?'} / ${st.status || '?'}${st.note ? ` — ${st.note}` : ''}`);
  }
  const a = approved();
  console.log(`旁白确认：${a.ok ? '✓ 已确认且 hash 匹配' : `✗ ${a.reason}`}`);
  const v = path.join(runDir, 'work', 'validate.json');
  if (fs.existsSync(v)) {
    const data = readJson(v);
    console.log(`storyboard 校验：${data.ok ? '✓ 通过' : `✗ ${data.errors?.length || 0} 个错误`}`);
  }
  const q = path.join(runDir, 'work', 'qa.json');
  if (fs.existsSync(q)) {
    const data = readJson(q);
    if (!data.ok) {
      console.log(`QA 机械检查：✗ ${(data.textIssues?.length || 0) + (data.mediaIssues?.length || 0)} 个问题`);
    } else if (data.visualOk) {
      console.log('QA：✓ 机械 + 视觉复核通过');
    } else {
      console.log('QA 机械检查：✓ 通过（视觉待复核：逐张看 frames 后把 work/qa.json 的 visualOk 设为 true）');
    }
  }
}

function help() {
  console.log(`web-tour-video pipeline

用法：
  node .agents/skills/web-tour-video/scripts/pipeline.mjs <command> --run runs/<slug>

命令：
  doctor    环境检查
  recon     侦察页面（可选，通常由 recon skill 直接跑）
  validate  校验 storyboard + 生成 narration.md
  approve   记录用户对旁白的确认
  audio     生成配音 + durations + pron_report
  record    录屏 + timings
  render    字幕 + 混音 + 编码
  qa        抽帧 + 机械检查 + qa_report
  all       audio → record → render → qa（需要先 approve）
  status    查看当前产物

选项：
  --force   跳过旁白确认（仅用于回归测试）
  --run     指定 run 目录（除 doctor 外必填）
`);
}

switch (command) {
  case 'doctor':
    run(scripts.doctor, [], 'doctor', false);
    break;
  case 'recon':
    requireRun();
    run(scripts.recon, [], 'recon');
    break;
  case 'validate':
    requireRun();
    run(scripts.validate, [], 'storyboard');
    break;
  case 'approve':
    requireRun();
    approve();
    break;
  case 'audio':
    requireRun();
    requireApproval();
    run(scripts.audio, [], 'audio');
    break;
  case 'record':
    requireRun();
    run(scripts.record, [], 'record');
    break;
  case 'render':
    requireRun();
    run(scripts.render, [], 'render');
    break;
  case 'qa':
    requireRun();
    run(scripts.qa, [], 'qa');
    break;
  case 'all':
    requireRun();
    run(scripts.validate, [], 'storyboard');
    requireApproval();
    run(scripts.audio, [], 'audio');
    run(scripts.record, [], 'record');
    run(scripts.render, [], 'render');
    run(scripts.qa, [], 'qa');
    break;
  case 'status':
    requireRun();
    status();
    break;
  case 'help':
  default:
    help();
    break;
}
