# AI Hook Generator

Fully offline, single-folder web app for writing viral opening hooks and
styling animated text overlays for 9:16 short-form video.

## Running it

Unzip everything into one folder and keep the structure intact:

```
AI-Hook-Generator/
├── index.html
├── style.css
├── app.js
├── hooks-data.js
└── vendor/
    └── ffmpeg-assets.js   (bundled MP4 encoder, loads on first export)
```

Double-click `index.html` to open it directly in your browser — no server,
no install, no account. Chrome or Edge is recommended (best support for
canvas audio+video capture); Firefox works for editing but MP4 export
support can vary by version.

## What it does

1. **Upload** an MP4, MOV, WEBM, or image.
2. **AI signal read** — samples the first few seconds on your device and
   scores motion, brightness, color warmth, a skin-tone-based "subject
   presence" proxy, and audio energy/dynamics. This is heuristic signal
   processing, not a hosted facial-expression model — nothing ever leaves
   your browser.
3. Those scores weight a **20-hook selection** pulled from a 160-line bank
   across Curiosity, Emotional, Music Promotion, Storytelling, Funny,
   Suspense, Challenge, and Motivation. Edit any line inline, or hit
   "Regenerate hook selection" for a fresh pull.
4. **Apply a hook** to add it as a text layer, then style it: 8 animations
   (Pop, Zoom, Shake, Typewriter, Bounce, Slide, Fade, Glitch), font, size,
   weight, color, outline, shadow, position, start time, and duration —
   all live in the 9:16 monitor.
5. **Export MP4** renders the canvas and original audio in real time, then
   muxes it to H.264/AAC MP4 at 1080×1920 using an embedded copy of
   ffmpeg.wasm (first export only, ~30MB, then cached for the session).

## Notes

- Everything runs client-side. Uploaded media is never sent anywhere.
- `vendor/ffmpeg-assets.js` bundles `@ffmpeg/ffmpeg` and `@ffmpeg/core`
  (MIT licensed) as base64 so export works from a plain `file://` page
  with no network access.
- Export plays your clip through once in real time to capture it — a
  30-second hook takes about 30 seconds to render, plus a short MP4 encode
  pass afterward.
