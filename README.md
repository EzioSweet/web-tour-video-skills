# web-tour-video skills

Agent Skills for producing narrated, subtitled 1920×1080 product tour videos from a Markdown brief.

One orchestrator skill plus six phase skills:

| Skill | Phase |
|---|---|
| `web-tour-video` | INTAKE, orchestration, narration approval, final acceptance |
| `web-tour-video-recon` | Playwright recon, login state, selectors |
| `web-tour-video-storyboard` | Storyboard, narration, pronunciation plan |
| `web-tour-video-audio` | TTS, durations, pronunciation report |
| `web-tour-video-record` | Playwright recording, fake cursor, timings |
| `web-tour-video-render` | Subtitles, browser chrome, audio mix, HEVC |
| `web-tour-video-qa` | Frame extraction, visual review, repair loop |

## Install

Requires the Skills CLI (Node.js 22.20+):

```bash
npx skills add <owner>/web-tour-video-skills --all
```

Or from a local checkout:

```bash
npx skills add ./web-tour-video-skills --all
```

Install **all** skills together. Sub-skills import shared code from
`web-tour-video/lib`, `schemas`, and `templates`; installing only one phase
skill leaves it without its dependency.

To pick an agent explicitly:

```bash
npx skills add <owner>/web-tour-video-skills --all -a claude-code
```

## Runtime requirements

The skills are instructions + Node scripts. The host project provides:

- Node.js 18+ (Skills CLI itself needs 22.20+)
- Playwright + Chromium: `npm install playwright && npx playwright install chromium`
- `ffmpeg` / `ffprobe`; HEVC encoding via VAAPI by default, or libx265 with `ENCODER=cpu`
- An OpenAI-compatible TTS endpoint (default `http://localhost:8735`, override with `TTS_BASE_URL`)
- `Noto Sans CJK SC` for burned-in subtitles

Project-level files created at runtime (`runs/<slug>/`, `auth.json`,
`work/secrets.json`) are not part of this repository.

## Use

```text
/skill:web-tour-video brief 在 runs/<slug>/brief.md
```

The workflow stops after STORYBOARD for narration approval, then continues with
AUDIO → RECORD → RENDER → QA. See `skills/web-tour-video/SKILL.md`.

## Layout

```text
skills/
├─ web-tour-video/
│  ├─ SKILL.md
│  ├─ scripts/        pipeline.mjs  doctor.mjs  headless-login.mjs
│  ├─ lib/            common  pronunciation  report  tts-config  browser_chrome
│  ├─ schemas/        storyboard.schema.json
│  ├─ templates/      brief.md  selectors.json
│  └─ references/     workflow  brief-format  acceptance
├─ web-tour-video-recon/
├─ web-tour-video-storyboard/
├─ web-tour-video-audio/
├─ web-tour-video-record/
├─ web-tour-video-render/
└─ web-tour-video-qa/
```

## License

BSD 3-Clause — see [LICENSE](LICENSE).
