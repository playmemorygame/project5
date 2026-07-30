/* ==========================================================================
   AI Hook Generator — Application Logic
   Everything below runs fully client-side. Analysis is heuristic (frame
   sampling + on-device signal processing), not a hosted ML model — this is
   stated plainly in the UI copy so nothing overclaims what's happening.
   ========================================================================== */

(() => {
  "use strict";

  /* --------------------------------------------------------------- consts */

  const IMAGE_DURATION = 6;          // seconds — synthetic "clip length" for a still image
  const CANVAS_W = 1080, CANVAS_H = 1920;
  const SAMPLE_COUNT = 6;            // frames sampled across the analysis window
  const ANALYSIS_WINDOW = 3;         // seconds of source read for the AI signal pass

  /* ----------------------------------------------------------------- dom */

  const $ = (id) => document.getElementById(id);

  const dropzone        = $("dropzone");
  const fileInput       = $("fileInput");
  const sourcePreview    = $("sourcePreview");
  const sourceThumbVideo = $("sourceThumbVideo");
  const sourceThumbImage = $("sourceThumbImage");
  const sourceFileName   = $("sourceFileName");
  const btnReplaceSource = $("btnReplaceSource");

  const analysisIdle      = $("analysisIdle");
  const analysisProgress  = $("analysisProgress");
  const analysisProgressFill  = $("analysisProgressFill");
  const analysisProgressLabel = $("analysisProgressLabel");
  const analysisResults   = $("analysisResults");
  const signalGrid        = $("signalGrid");
  const paletteRow        = $("paletteRow");
  const categoryWeightsEl = $("categoryWeights");
  const btnRegenerateHooks = $("btnRegenerateHooks");

  const hookCountEl   = $("hookCount");
  const categoryFiltersEl = $("categoryFilters");
  const hookListEl    = $("hookList");
  const hookListEmpty = $("hookListEmpty");

  const clipStatus = $("clipStatus");
  const clipStatusText = $("clipStatusText");
  const btnExport = $("btnExport");
  const btnNewProject = $("btnNewProject");

  const monitor = $("monitor");
  const monitorPlaceholder = $("monitorPlaceholder");
  const stageCanvas = $("stageCanvas");
  const ctx = stageCanvas.getContext("2d");

  const transport = $("transport");
  const btnPlayPause = $("btnPlayPause");
  const scrubber = $("scrubber");
  const timeCurrent = $("timeCurrent");
  const timeTotal = $("timeTotal");

  const layerBar = $("layerBar");
  const layerListEl = $("layerList");
  const btnAddLayer = $("btnAddLayer");

  const styleSection = $("styleSection");
  const styleText = $("styleText");
  const styleAnimation = $("styleAnimation");
  const styleFont = $("styleFont");
  const styleFontSize = $("styleFontSize");
  const styleColor = $("styleColor");
  const styleWeight = $("styleWeight");
  const styleAlign = $("styleAlign");
  const styleOutlineColor = $("styleOutlineColor");
  const styleOutlineWidth = $("styleOutlineWidth");
  const styleShadowColor = $("styleShadowColor");
  const styleShadowBlur = $("styleShadowBlur");
  const styleShadowX = $("styleShadowX");
  const styleShadowY = $("styleShadowY");
  const positionGrid = $("positionGrid");
  const stylePosX = $("stylePosX");
  const stylePosY = $("stylePosY");
  const styleStart = $("styleStart");
  const styleDuration = $("styleDuration");
  const btnDeleteLayer = $("btnDeleteLayer");

  const exportModal = $("exportModal");
  const exportStage = $("exportStage");
  const exportProgressFill = $("exportProgressFill");
  const btnCancelExport = $("btnCancelExport");
  const btnDownloadResult = $("btnDownloadResult");

  const toastEl = $("toast");

  /* ---------------------------------------------------------------- state */

  const state = {
    sourceType: null,        // 'video' | 'image'
    sourceURL: null,
    sourceFileName: null,
    sourceImage: null,       // HTMLImageElement, for image sources
    duration: 0,
    metrics: null,
    categoryWeights: null,
    hooks: [],               // { id, category, text, applied }
    activeFilter: "all",
    layers: [],              // see createLayer()
    selectedLayerId: null,
    isPlaying: false,
    virtualTime: 0,          // used for image sources
    lastFrameStamp: 0,
    exportCancelled: false,
    ffmpeg: null,
  };

  let layerIdSeq = 1;
  let hookIdSeq = 1;

  /* --------------------------------------------------------------- utils */

  function showToast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Small deterministic PRNG so re-renders (preview vs export) stay in sync
  // for effects like glitch/shake that need pseudo-randomness driven by time.
  function hash01(x) {
    const s = Math.sin(x * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function getCategoryMeta(id) {
    return HOOK_CATEGORIES.find((c) => c.id === id) || HOOK_CATEGORIES[0];
  }

  /* ============================================================
     1. SOURCE UPLOAD
     ============================================================ */

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-dragover"); })
  );
  dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  btnReplaceSource.addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });

  function handleFile(file) {
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) {
      showToast("Please choose a video (MP4/MOV/WEBM) or an image.");
      return;
    }

    resetProject({ keepSource: false });

    const url = URL.createObjectURL(file);
    state.sourceURL = url;
    state.sourceFileName = file.name;
    state.sourceType = isVideo ? "video" : "image";

    sourceFileName.textContent = file.name;
    sourcePreview.hidden = false;

    if (isVideo) {
      sourceThumbImage.hidden = true;
      sourceThumbVideo.hidden = false;
      sourceThumbVideo.src = url;
      sourceThumbVideo.loop = true;
      sourceThumbVideo.muted = true;
      sourceThumbVideo.playsInline = true;

      sourceThumbVideo.addEventListener("loadedmetadata", function onMeta() {
        sourceThumbVideo.removeEventListener("loadedmetadata", onMeta);
        state.duration = sourceThumbVideo.duration || 0;
        monitorPlaceholder.hidden = true;
        transport.hidden = false;
        scrubber.value = 0;
        timeTotal.textContent = fmtTime(state.duration);
        setClipStatus(true, `${file.name}`);
        runAnalysis();
      }, { once: true });
    } else {
      sourceThumbVideo.hidden = true;
      sourceThumbImage.hidden = false;
      sourceThumbImage.src = url;

      const img = new Image();
      img.onload = () => {
        state.sourceImage = img;
        state.duration = IMAGE_DURATION;
        monitorPlaceholder.hidden = true;
        transport.hidden = false;
        scrubber.value = 0;
        timeTotal.textContent = fmtTime(state.duration);
        setClipStatus(true, `${file.name}`);
        runAnalysis();
      };
      img.src = url;
    }
  }

  function setClipStatus(ready, label) {
    clipStatus.classList.toggle("is-ready", !!ready);
    clipStatusText.textContent = ready ? label : "No clip loaded";
  }

  btnNewProject.addEventListener("click", () => resetProject({ keepSource: false }));

  function resetProject({ keepSource }) {
    state.layers = [];
    state.selectedLayerId = null;
    state.hooks = [];
    state.metrics = null;
    state.categoryWeights = null;
    state.isPlaying = false;
    state.virtualTime = 0;

    layerBar.hidden = true;
    layerListEl.innerHTML = "";
    styleSection.hidden = true;
    hookListEl.querySelectorAll(".hook-card").forEach((n) => n.remove());
    hookListEmpty.hidden = false;
    hookCountEl.textContent = "0";
    categoryFiltersEl.innerHTML = "";
    analysisResults.hidden = true;
    analysisIdle.hidden = false;
    btnExport.disabled = true;

    if (!keepSource) {
      sourcePreview.hidden = true;
      monitorPlaceholder.hidden = false;
      transport.hidden = true;
      sourceThumbVideo.removeAttribute("src");
      sourceThumbImage.removeAttribute("src");
      state.sourceType = null;
      state.sourceURL = null;
      state.sourceImage = null;
      state.duration = 0;
      setClipStatus(false);
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    }
  }

  /* ============================================================
     2. AI SIGNAL READ (heuristic on-device analysis)
     ============================================================ */

  async function runAnalysis() {
    analysisIdle.hidden = true;
    analysisResults.hidden = true;
    analysisProgress.hidden = false;
    setAnalysisProgress(4, "Sampling frames…");

    try {
      const metrics = state.sourceType === "video"
        ? await analyzeVideo()
        : analyzeImage();

      setAnalysisProgress(80, "Reading audio energy…");
      if (state.sourceType === "video") {
        metrics.audio = await analyzeAudio(state.sourceURL, state.duration);
      } else {
        metrics.audio = { energy: 0, variance: 0, ok: false };
      }

      setAnalysisProgress(96, "Scoring hook categories…");
      state.metrics = metrics;
      state.categoryWeights = scoreCategories(metrics);

      renderAnalysisResults(metrics, state.categoryWeights);
      generateHookSelection();

      setAnalysisProgress(100, "Done");
      setTimeout(() => { analysisProgress.hidden = true; analysisResults.hidden = false; }, 250);

      btnExport.disabled = false;
    } catch (err) {
      console.error(err);
      analysisProgress.hidden = true;
      analysisIdle.hidden = false;
      analysisIdle.textContent = "Couldn't read this file. Try a different clip or format.";
      showToast("Analysis failed — try another file.");
    }
  }

  function setAnalysisProgress(pct, label) {
    analysisProgressFill.style.width = pct + "%";
    analysisProgressLabel.textContent = label;
  }

  // Sample frames from the first ANALYSIS_WINDOW seconds and derive motion,
  // brightness, saturation/warmth, and a skin-tone-ratio proxy for "subject
  // presence" (a stand-in for real facial-expression detection, which this
  // offline build does not perform).
  async function analyzeVideo() {
    const win = Math.min(ANALYSIS_WINDOW, state.duration || ANALYSIS_WINDOW);
    const times = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) times.push((win / (SAMPLE_COUNT - 1)) * i);

    const off = document.createElement("canvas");
    off.width = 160; off.height = 284; // small + fast, ~9:16 sample frame
    const octx = off.getContext("2d", { willReadFrequently: true });

    const wasPaused = sourceThumbVideo.paused;
    sourceThumbVideo.pause();

    let prevData = null;
    let motionTotal = 0, motionSamples = 0;
    let brightnessTotal = 0, satTotal = 0, warmthTotal = 0, skinTotal = 0;
    const swatches = [];

    for (let i = 0; i < times.length; i++) {
      await seekVideo(sourceThumbVideo, times[i]);
      octx.drawImage(sourceThumbVideo, 0, 0, off.width, off.height);
      const frame = octx.getImageData(0, 0, off.width, off.height);
      const m = analyzePixels(frame.data);
      brightnessTotal += m.brightness;
      satTotal += m.saturation;
      warmthTotal += m.warmth;
      skinTotal += m.skinRatio;
      if (i === 0 || i === Math.floor(times.length / 2) || i === times.length - 1) {
        swatches.push(m.dominant);
      }
      if (prevData) motionTotal += frameDiff(prevData, frame.data), motionSamples++;
      prevData = frame.data;
      setAnalysisProgress(8 + Math.round((i + 1) / times.length * 65), "Sampling frames…");
    }

    if (!wasPaused) sourceThumbVideo.play().catch(() => {});
    sourceThumbVideo.currentTime = 0;

    const n = times.length;
    return {
      motion: clamp((motionSamples ? motionTotal / motionSamples : 0) / 40, 0, 1),
      brightness: brightnessTotal / n / 255,
      saturation: satTotal / n,
      warmth: warmthTotal / n,
      skin: clamp(skinTotal / n, 0, 1),
      palette: swatches,
    };
  }

  function analyzeImage() {
    const off = document.createElement("canvas");
    off.width = 160; off.height = 284;
    const octx = off.getContext("2d", { willReadFrequently: true });
    const img = state.sourceImage;
    // cover-fit draw so the sampled region matches what the export will show
    const scale = Math.max(off.width / img.width, off.height / img.height);
    const dw = img.width * scale, dh = img.height * scale;
    octx.drawImage(img, (off.width - dw) / 2, (off.height - dh) / 2, dw, dh);
    const frame = octx.getImageData(0, 0, off.width, off.height);
    const m = analyzePixels(frame.data);
    return {
      motion: 0,
      brightness: m.brightness / 255,
      saturation: m.saturation,
      warmth: m.warmth,
      skin: m.skinRatio,
      palette: [m.dominant],
    };
  }

  function analyzePixels(data) {
    let rT = 0, gT = 0, bT = 0, lumT = 0, skinPx = 0, satT = 0;
    const buckets = {};
    const total = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      rT += r; gT += g; bT += b;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumT += lum;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      satT += sat;
      // simple skin-tone heuristic (Kovac et al. style bounds) — a proxy for
      // "a person is likely on camera", not a face or emotion detector.
      if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
          (max - min) > 15 && Math.abs(r - g) > 15) skinPx++;
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      buckets[key] = (buckets[key] || 0) + 1;
    }
    let dominantKey = null, dominantCount = -1;
    for (const k in buckets) if (buckets[k] > dominantCount) { dominantCount = buckets[k]; dominantKey = k; }
    const [dr, dg, db] = dominantKey.split(",").map((v) => Math.min(255, Number(v) * 32 + 16));

    return {
      brightness: lumT / total,
      saturation: satT / total,
      warmth: ((rT / total) - (bT / total)) / 255, // >0 warm, <0 cool
      skinRatio: skinPx / total,
      dominant: `rgb(${dr | 0},${dg | 0},${db | 0})`,
    };
  }

  function frameDiff(a, b) {
    let diff = 0;
    const step = 4 * 3; // sample every 3rd pixel for speed
    for (let i = 0; i < a.length; i += step) {
      diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    }
    return diff / (a.length / step) / 3;
  }

  function seekVideo(video, t) {
    return new Promise((resolve) => {
      const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
      video.addEventListener("seeked", onSeeked);
      try { video.currentTime = t; } catch { resolve(); }
    });
  }

  // Decode the source's audio track (Web Audio API) and measure RMS energy
  // plus short-window variance as a proxy for "musical dynamic energy".
  async function analyzeAudio(url, duration) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return { energy: 0, variance: 0, ok: false };
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const ac = new AC();
      const audioBuf = await ac.decodeAudioData(buf.slice(0));
      const ch = audioBuf.getChannelData(0);
      const win = Math.min(ANALYSIS_WINDOW, duration || ANALYSIS_WINDOW, audioBuf.duration);
      const sampleCount = Math.floor(win * audioBuf.sampleRate);
      const chunks = 24;
      const chunkSize = Math.max(1, Math.floor(sampleCount / chunks));
      const chunkRms = [];
      let sumSq = 0, n = 0;
      for (let c = 0; c < chunks; c++) {
        let cSum = 0, cN = 0;
        const startI = c * chunkSize;
        for (let i = startI; i < Math.min(startI + chunkSize, sampleCount); i++) {
          const v = ch[i] || 0;
          cSum += v * v; cN++;
          sumSq += v * v; n++;
        }
        chunkRms.push(cN ? Math.sqrt(cSum / cN) : 0);
      }
      const rms = n ? Math.sqrt(sumSq / n) : 0;
      const meanChunk = chunkRms.reduce((a, b) => a + b, 0) / chunkRms.length;
      const variance = chunkRms.reduce((a, b) => a + Math.abs(b - meanChunk), 0) / chunkRms.length;
      ac.close();
      return {
        energy: clamp(rms * 6, 0, 1),
        variance: clamp(variance * 14, 0, 1),
        ok: true,
      };
    } catch {
      return { energy: 0, variance: 0, ok: false };
    }
  }

  function scoreCategories(m) {
    const audio = m.audio || { energy: 0, variance: 0 };
    const w = {
      curiosity:   0.9 + (1 - audio.energy) * 0.35 + m.saturation * 0.25,
      emotional:   0.6 + m.skin * 1.5 + Math.max(m.warmth, 0) * 0.7 - m.motion * 0.35,
      music:       0.5 + audio.energy * 2.0 + audio.variance * 0.8,
      storytelling:0.8 + m.skin * 0.9 + (1 - m.motion) * 0.5,
      funny:       0.6 + m.brightness * 0.9 + m.saturation * 0.9 + m.motion * 0.35,
      suspense:    0.5 + m.motion * 1.7 + audio.variance * 0.9 - m.brightness * 0.3,
      challenge:   0.6 + m.motion * 1.4 + audio.energy * 0.5,
      motivation:  0.6 + (1 - m.motion) * 0.6 + m.brightness * 0.5 - audio.energy * 0.15,
    };
    let sum = 0;
    for (const k in w) { w[k] = Math.max(0.05, w[k]); sum += w[k]; }
    for (const k in w) w[k] = w[k] / sum;
    return w;
  }

  function renderAnalysisResults(m, weights) {
    const audio = m.audio || { energy: 0, variance: 0, ok: false };
    const chips = [
      { label: "Motion", value: Math.round(m.motion * 100) + "%" },
      { label: "Brightness", value: Math.round(m.brightness * 100) + "%" },
      { label: "Color mood", value: m.warmth > 0.03 ? "Warm" : (m.warmth < -0.03 ? "Cool" : "Neutral") },
      { label: "Subject presence", value: Math.round(m.skin * 400) + "%", small: "heuristic" },
      { label: "Audio energy", value: audio.ok ? Math.round(audio.energy * 100) + "%" : "n/a" },
      { label: "Audio dynamics", value: audio.ok ? Math.round(audio.variance * 100) + "%" : "n/a" },
    ];
    signalGrid.innerHTML = chips.map((c) => `
      <div class="signal-chip">
        <span class="signal-chip__label">${c.label}</span>
        <span class="signal-chip__value">${c.value}${c.small ? ` <small>${c.small}</small>` : ""}</span>
      </div>`).join("");

    paletteRow.innerHTML = (m.palette || []).map((c) =>
      `<span class="palette-swatch" style="background:${c}" title="${c}"></span>`).join("");

    const ranked = Object.entries(weights).sort((a, b) => b[1] - a[1]);
    categoryWeightsEl.innerHTML = ranked.map(([id, val]) => {
      const meta = getCategoryMeta(id);
      return `<div class="category-weight-row">
        <span class="category-weight-row__label">${meta.label}</span>
        <span class="category-weight-row__track"><span class="category-weight-row__fill" style="width:${Math.round(val * 100)}%;background:${meta.color}"></span></span>
        <span class="category-weight-row__pct">${Math.round(val * 100)}%</span>
      </div>`;
    }).join("");
  }

  btnRegenerateHooks.addEventListener("click", generateHookSelection);

  /* ============================================================
     3. HOOK SELECTION + LIBRARY UI
     ============================================================ */

  function generateHookSelection() {
    const weights = state.categoryWeights || Object.fromEntries(HOOK_CATEGORIES.map((c) => [c.id, 1 / HOOK_CATEGORIES.length]));
    const ids = HOOK_CATEGORIES.map((c) => c.id);
    const total = 20;

    // largest-remainder allocation so every category is represented
    const raw = ids.map((id) => weights[id] * total);
    const base = raw.map(Math.floor);
    let allocated = base.reduce((a, b) => a + b, 0);
    const remainders = raw.map((v, i) => ({ i, r: v - base[i] })).sort((a, b) => b.r - a.r);
    let idx = 0;
    while (allocated < total) {
      base[remainders[idx % remainders.length].i]++;
      allocated++; idx++;
    }
    ids.forEach((id, i) => { if (base[i] < 1) base[i] = 1; });
    // trim back down to exactly `total` if the min-1 rule pushed us over
    while (base.reduce((a, b) => a + b, 0) > total) {
      const maxI = base.indexOf(Math.max(...base));
      if (base[maxI] > 1) base[maxI]--; else break;
    }

    const rand = mulberry32(Date.now() % 2147483647);
    const hooks = [];
    ids.forEach((id, i) => {
      const pool = [...HOOK_BANK[id]];
      // shuffle
      for (let j = pool.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [pool[j], pool[k]] = [pool[k], pool[j]];
      }
      pool.slice(0, base[i]).forEach((text) => {
        hooks.push({ id: hookIdSeq++, category: id, text });
      });
    });

    state.hooks = hooks;
    renderCategoryFilters();
    renderHookList();
  }

  function renderCategoryFilters() {
    const counts = {};
    state.hooks.forEach((h) => { counts[h.category] = (counts[h.category] || 0) + 1; });
    const allChip = `<button class="chip ${state.activeFilter === "all" ? "is-active" : ""}" data-filter="all">All (${state.hooks.length})</button>`;
    const chips = HOOK_CATEGORIES.filter((c) => counts[c.id]).map((c) =>
      `<button class="chip ${state.activeFilter === c.id ? "is-active" : ""}" data-filter="${c.id}" style="${state.activeFilter === c.id ? `background:${c.color};border-color:${c.color};color:#0E0F12` : ""}">${c.label} (${counts[c.id]})</button>`
    ).join("");
    categoryFiltersEl.innerHTML = allChip + chips;
    categoryFiltersEl.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeFilter = btn.dataset.filter;
        renderCategoryFilters();
        renderHookList();
      });
    });
  }

  function renderHookList() {
    hookCountEl.textContent = String(state.hooks.length);
    const list = state.activeFilter === "all" ? state.hooks : state.hooks.filter((h) => h.category === state.activeFilter);
    hookListEl.querySelectorAll(".hook-card").forEach((n) => n.remove());
    hookListEmpty.hidden = list.length > 0;

    list.forEach((hook) => {
      const meta = getCategoryMeta(hook.category);
      const card = document.createElement("div");
      card.className = "hook-card";
      card.innerHTML = `
        <span class="hook-card__tag" style="background:${meta.color}">${meta.label}</span>
        <textarea rows="3" data-id="${hook.id}">${hook.text}</textarea>
        <div class="hook-card__actions">
          <button class="btn btn--tiny btn--accent" data-use="${hook.id}">Use this hook</button>
        </div>`;
      const ta = card.querySelector("textarea");
      ta.addEventListener("input", () => { hook.text = ta.value; });
      card.querySelector("[data-use]").addEventListener("click", () => {
        applyHookAsLayer(hook);
        card.classList.add("is-applied");
      });
      hookListEl.appendChild(card);
    });
  }

  function applyHookAsLayer(hook) {
    const layer = createLayer(hook.text);
    state.layers.push(layer);
    selectLayer(layer.id);
    renderLayerBar();
    layerBar.hidden = false;
    styleSection.hidden = false;
    showToast("Hook applied — style it on the right, or drag it into place.");
  }

  /* ============================================================
     4. LAYERS + STYLE PANEL
     ============================================================ */

  function createLayer(text) {
    return {
      id: layerIdSeq++,
      text: text || "Your hook here",
      animation: "pop",
      font: "'Arial Black', Arial, sans-serif",
      fontSize: 72,
      color: "#ffffff",
      weight: "800",
      align: "center",
      outlineColor: "#000000",
      outlineWidth: 6,
      shadowColor: "#000000",
      shadowBlur: 14,
      shadowX: 4,
      shadowY: 4,
      posX: 0.5,
      posY: 0.82,
      start: 0,
      duration: Math.min(3, state.duration || 3),
    };
  }

  btnAddLayer.addEventListener("click", () => {
    const layer = createLayer("New text layer");
    state.layers.push(layer);
    selectLayer(layer.id);
    renderLayerBar();
    layerBar.hidden = false;
    styleSection.hidden = false;
  });

  function selectLayer(id) {
    state.selectedLayerId = id;
    renderLayerBar();
    const layer = state.layers.find((l) => l.id === id);
    if (layer) loadLayerIntoForm(layer);
  }

  function renderLayerBar() {
    layerListEl.innerHTML = "";
    state.layers.forEach((l, i) => {
      const chip = document.createElement("button");
      chip.className = "layer-chip" + (l.id === state.selectedLayerId ? " is-selected" : "");
      chip.textContent = `${i + 1}. ${l.text.slice(0, 18)}${l.text.length > 18 ? "…" : ""}`;
      chip.addEventListener("click", () => selectLayer(l.id));
      layerListEl.appendChild(chip);
    });
    layerBar.hidden = state.layers.length === 0;
  }

  function loadLayerIntoForm(layer) {
    styleText.value = layer.text;
    styleAnimation.value = layer.animation;
    styleFont.value = layer.font;
    styleFontSize.value = layer.fontSize;
    styleColor.value = layer.color;
    styleWeight.value = layer.weight;
    styleAlign.value = layer.align;
    styleOutlineColor.value = layer.outlineColor;
    styleOutlineWidth.value = layer.outlineWidth;
    styleShadowColor.value = layer.shadowColor;
    styleShadowBlur.value = layer.shadowBlur;
    styleShadowX.value = layer.shadowX;
    styleShadowY.value = layer.shadowY;
    stylePosX.value = layer.posX;
    stylePosY.value = layer.posY;
    styleStart.value = layer.start;
    styleDuration.value = layer.duration;

    positionGrid.querySelectorAll("button").forEach((b) => {
      const [px, py] = b.dataset.pos.split(",").map(Number);
      b.classList.toggle("is-active", Math.abs(px - layer.posX) < 0.01 && Math.abs(py - layer.posY) < 0.01);
    });
    styleSection.hidden = false;
  }

  function currentLayer() { return state.layers.find((l) => l.id === state.selectedLayerId); }

  function bindField(el, prop, transform) {
    el.addEventListener("input", () => {
      const l = currentLayer();
      if (!l) return;
      l[prop] = transform ? transform(el.value) : el.value;
      if (prop === "text") renderLayerBar();
    });
  }
  bindField(styleText, "text");
  bindField(styleAnimation, "animation");
  bindField(styleFont, "font");
  bindField(styleFontSize, "fontSize", Number);
  bindField(styleColor, "color");
  bindField(styleWeight, "weight");
  bindField(styleAlign, "align");
  bindField(styleOutlineColor, "outlineColor");
  bindField(styleOutlineWidth, "outlineWidth", Number);
  bindField(styleShadowColor, "shadowColor");
  bindField(styleShadowBlur, "shadowBlur", Number);
  bindField(styleShadowX, "shadowX", Number);
  bindField(styleShadowY, "shadowY", Number);
  bindField(styleStart, "start", Number);
  bindField(styleDuration, "duration", Number);

  stylePosX.addEventListener("input", () => {
    const l = currentLayer(); if (!l) return;
    l.posX = Number(stylePosX.value);
    positionGrid.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
  });
  stylePosY.addEventListener("input", () => {
    const l = currentLayer(); if (!l) return;
    l.posY = Number(stylePosY.value);
    positionGrid.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
  });

  positionGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const l = currentLayer(); if (!l) return;
    const [px, py] = btn.dataset.pos.split(",").map(Number);
    l.posX = px; l.posY = py;
    stylePosX.value = px; stylePosY.value = py;
    positionGrid.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
  });

  btnDeleteLayer.addEventListener("click", () => {
    const l = currentLayer(); if (!l) return;
    state.layers = state.layers.filter((x) => x.id !== l.id);
    state.selectedLayerId = state.layers.length ? state.layers[0].id : null;
    renderLayerBar();
    if (state.selectedLayerId) loadLayerIntoForm(currentLayer());
    else styleSection.hidden = true;
  });

  /* ============================================================
     5. RENDER / ANIMATION ENGINE
     ============================================================ */

  function wrapLines(text, font, maxWidth) {
    ctx.font = font;
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    words.forEach((w) => {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    });
    if (line) lines.push(line);
    return lines;
  }

  function drawSource(t) {
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    let media = null, mw = 0, mh = 0;
    if (state.sourceType === "video" && sourceThumbVideo.readyState >= 2) {
      media = sourceThumbVideo; mw = sourceThumbVideo.videoWidth; mh = sourceThumbVideo.videoHeight;
    } else if (state.sourceType === "image" && state.sourceImage) {
      media = state.sourceImage; mw = state.sourceImage.width; mh = state.sourceImage.height;
    }
    if (!media || !mw || !mh) return;

    const scale = Math.max(CANVAS_W / mw, CANVAS_H / mh);
    const dw = mw * scale, dh = mh * scale;
    ctx.drawImage(media, (CANVAS_W - dw) / 2, (CANVAS_H - dh) / 2, dw, dh);
  }

  function drawLayer(layer, t) {
    const rel = t - layer.start;
    if (rel < -0.001 || rel > layer.duration + 0.001) return;

    const dur = Math.max(0.05, layer.duration);
    const introDur = Math.min(0.45, dur * 0.4);
    const outroDur = Math.min(0.3, dur * 0.25);
    const enter = clamp(rel / introDur, 0, 1);
    const exit = clamp((dur - rel) / outroDur, 0, 1);
    const seed = layer.id * 91.7;

    const anchorX = layer.posX * CANVAS_W;
    const anchorY = layer.posY * CANVAS_H;
    const fontSize = layer.fontSize;
    const fontSpec = `${layer.weight} ${fontSize}px ${layer.font}`;
    const maxWidth = CANVAS_W * 0.86;
    const lines = wrapLines(layer.text, fontSpec, maxWidth);
    const lineHeight = fontSize * 1.18;
    const blockHeight = lineHeight * lines.length;

    let alpha = 1, offsetX = 0, offsetY = 0, scale = 1, rotate = 0;
    let revealChars = null;
    let glitchOffsets = null;

    switch (layer.animation) {
      case "pop": {
        const e = enter < 1 ? easeOutBack(enter) : 1;
        scale = lerp(0.3, 1, e);
        alpha = Math.min(clamp(rel / (introDur * 0.6), 0, 1), exit);
        break;
      }
      case "zoom": {
        const e = easeOutCubic(enter);
        scale = lerp(2.4, 1, e);
        alpha = Math.min(clamp(rel / (introDur * 0.5), 0, 1), exit);
        break;
      }
      case "shake": {
        alpha = Math.min(clamp(rel / 0.15, 0, 1), exit);
        const f = t * 18;
        offsetX = (hash01(seed + f) - 0.5) * fontSize * 0.16;
        offsetY = (hash01(seed + f + 50) - 0.5) * fontSize * 0.1;
        break;
      }
      case "typewriter": {
        alpha = exit;
        const revealWindow = Math.max(0.3, dur * 0.7);
        const frac = clamp(rel / revealWindow, 0, 1);
        const totalChars = layer.text.length;
        revealChars = Math.round(totalChars * frac);
        break;
      }
      case "bounce": {
        const e = easeOutBounce(enter);
        offsetY = lerp(-fontSize * 1.6, 0, e);
        alpha = Math.min(clamp(rel / (introDur * 0.5), 0, 1), exit);
        break;
      }
      case "slide": {
        const e = easeOutCubic(enter);
        offsetX = lerp(-CANVAS_W * 0.6, 0, e);
        alpha = Math.min(clamp(rel / (introDur * 0.6), 0, 1), exit);
        break;
      }
      case "fade": {
        alpha = Math.min(clamp(rel / introDur, 0, 1), exit);
        break;
      }
      case "glitch": {
        alpha = Math.min(clamp(rel / 0.1, 0, 1), exit);
        const active = hash01(seed + Math.floor(t * 10)) > 0.72;
        glitchOffsets = active
          ? { r: (hash01(seed + t * 30) - 0.5) * 14, g: (hash01(seed + t * 30 + 7) - 0.5) * 14, b: (hash01(seed + t * 30 + 13) - 0.5) * 14 }
          : { r: 0, g: 0, b: 0 };
        break;
      }
    }

    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(anchorX + offsetX, anchorY + offsetY);
    ctx.rotate(rotate);
    ctx.scale(scale, scale);
    ctx.font = fontSpec;
    ctx.textAlign = layer.align;
    ctx.textBaseline = "middle";

    const startY = -blockHeight / 2 + lineHeight / 2;

    lines.forEach((lineText, li) => {
      let renderText = lineText;
      if (revealChars !== null) {
        const before = lines.slice(0, li).join(" ").length + li;
        const localReveal = clamp(revealChars - before, 0, lineText.length);
        renderText = lineText.slice(0, localReveal);
      }
      const y = startY + li * lineHeight;
      const x = layer.align === "center" ? 0 : (layer.align === "left" ? -maxWidth / 2 : maxWidth / 2);

      if (layer.shadowBlur > 0 || layer.shadowX || layer.shadowY) {
        ctx.shadowColor = layer.shadowColor;
        ctx.shadowBlur = layer.shadowBlur;
        ctx.shadowOffsetX = layer.shadowX;
        ctx.shadowOffsetY = layer.shadowY;
      } else {
        ctx.shadowColor = "transparent";
      }

      if (glitchOffsets) {
        ctx.globalCompositeOperation = "lighter";
        drawTextPass(renderText, x + glitchOffsets.r, y, layer, "rgba(255,40,40,0.85)");
        drawTextPass(renderText, x + glitchOffsets.g, y, layer, "rgba(40,255,120,0.85)");
        drawTextPass(renderText, x + glitchOffsets.b, y, layer, "rgba(60,140,255,0.85)");
        ctx.globalCompositeOperation = "source-over";
        ctx.shadowColor = "transparent";
        drawTextPass(renderText, x, y, layer, layer.color);
      } else {
        drawTextPass(renderText, x, y, layer, layer.color);
      }
    });

    ctx.restore();
  }

  function drawTextPass(text, x, y, layer, fillColor) {
    if (layer.outlineWidth > 0) {
      ctx.lineWidth = layer.outlineWidth;
      ctx.strokeStyle = layer.outlineColor;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeText(text, x, y);
    }
    ctx.fillStyle = fillColor;
    ctx.fillText(text, x, y);
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  function easeOutBack(t) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }
  function easeOutBounce(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  }

  function renderFrame(t) {
    drawSource(t);
    state.layers.forEach((l) => drawLayer(l, t));
  }

  /* ------------------------------------------------------ playback clock */

  function getTime() {
    return state.sourceType === "video" ? sourceThumbVideo.currentTime : state.virtualTime;
  }
  function getDuration() {
    return state.sourceType === "video" ? (sourceThumbVideo.duration || 0) : IMAGE_DURATION;
  }

  btnPlayPause.addEventListener("click", () => {
    if (!state.sourceType) return;
    state.isPlaying = !state.isPlaying;
    btnPlayPause.textContent = state.isPlaying ? "⏸" : "▶";
    if (state.sourceType === "video") {
      if (state.isPlaying) sourceThumbVideo.play().catch(() => {});
      else sourceThumbVideo.pause();
    }
  });

  sourceThumbVideo.addEventListener("play", () => { state.isPlaying = true; btnPlayPause.textContent = "⏸"; });
  sourceThumbVideo.addEventListener("pause", () => { state.isPlaying = false; btnPlayPause.textContent = "▶"; });

  scrubber.addEventListener("input", () => {
    const frac = Number(scrubber.value) / 1000;
    const d = getDuration();
    if (state.sourceType === "video") {
      sourceThumbVideo.currentTime = frac * d;
    } else {
      state.virtualTime = frac * d;
    }
  });

  let lastLoopStamp = performance.now();
  function loop(now) {
    const dt = (now - lastLoopStamp) / 1000;
    lastLoopStamp = now;

    if (state.sourceType === "image" && state.isPlaying) {
      state.virtualTime += dt;
      if (state.virtualTime >= IMAGE_DURATION) {
        state.virtualTime = IMAGE_DURATION;
        state.isPlaying = false;
        btnPlayPause.textContent = "▶";
      }
    }

    if (state.sourceType) {
      const t = getTime();
      const d = getDuration();
      renderFrame(t);
      timeCurrent.textContent = fmtTime(t);
      timeTotal.textContent = fmtTime(d);
      if (d > 0 && !scrubber.matches(":active")) scrubber.value = String(Math.round((t / d) * 1000));
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /* ============================================================
     6. EXPORT — record canvas+audio, then mux to MP4 via ffmpeg.wasm
     ============================================================ */

  btnExport.addEventListener("click", startExport);
  btnCancelExport.addEventListener("click", () => {
    state.exportCancelled = true;
    exportModal.hidden = true;
  });

  function setExportStage(label, pct) {
    exportStage.textContent = label;
    if (pct !== undefined) exportProgressFill.style.width = pct + "%";
  }

  async function loadFfmpegAssetsScript() {
    if (window.__FFMPEG_ASSETS__) return;
    setExportStage("Loading offline render engine (first time only)…", 5);
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/ffmpeg-assets.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load vendor/ffmpeg-assets.js. Keep this file next to index.html."));
      document.head.appendChild(s);
    });
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function ensureFfmpegLoaded() {
    if (state.ffmpeg && state.ffmpeg.loaded) return state.ffmpeg;

    await loadFfmpegAssetsScript();
    const A = window.__FFMPEG_ASSETS__;

    setExportStage("Preparing render engine…", 12);

    const ffmpegJsText = new TextDecoder().decode(b64ToBytes(A.ffmpegJs));
    const workerJsText = new TextDecoder().decode(b64ToBytes(A.workerChunkJs));
    const coreJsText = new TextDecoder().decode(b64ToBytes(A.coreJs));

    const workerBlobUrl = URL.createObjectURL(new Blob([workerJsText], { type: "text/javascript" }));
    window.__FFMPEG_WORKER_URL__ = workerBlobUrl;

    if (!window.FFmpegWASM) {
      const ffmpegBlobUrl = URL.createObjectURL(new Blob([ffmpegJsText], { type: "text/javascript" }));
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = ffmpegBlobUrl;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Failed to initialize render engine."));
        document.head.appendChild(s);
      });
    }

    setExportStage("Loading codec core (~30MB, one-time)…", 22);
    const coreJsBlobUrl = URL.createObjectURL(new Blob([coreJsText], { type: "text/javascript" }));
    const coreWasmBytes = b64ToBytes(A.coreWasm);
    const coreWasmBlobUrl = URL.createObjectURL(new Blob([coreWasmBytes], { type: "application/wasm" }));

    const ffmpeg = new window.FFmpegWASM.FFmpeg();
    ffmpeg.on("progress", ({ progress }) => {
      if (typeof progress === "number" && progress >= 0) {
        setExportStage("Encoding to MP4…", 55 + Math.round(clamp(progress, 0, 1) * 40));
      }
    });
    await ffmpeg.load({ coreURL: coreJsBlobUrl, wasmURL: coreWasmBlobUrl });

    state.ffmpeg = ffmpeg;
    return ffmpeg;
  }

  async function startExport() {
    if (!state.sourceType) return;
    state.exportCancelled = false;
    exportModal.hidden = false;
    btnDownloadResult.hidden = true;
    setExportStage("Preparing…", 2);

    const wasVideoLoop = sourceThumbVideo.loop;
    const wasVideoMuted = sourceThumbVideo.muted;

    try {
      const ffmpeg = await ensureFfmpegLoaded();
      if (state.exportCancelled) return;

      setExportStage("Rendering frames & audio in real time…", 45);
      const webmBlob = await recordComposite();
      if (state.exportCancelled) return;

      setExportStage("Preparing MP4 encode…", 52);
      const inputBytes = new Uint8Array(await webmBlob.arrayBuffer());
      await ffmpeg.writeFile("in.webm", inputBytes);

      setExportStage("Encoding to MP4…", 56);
      await ffmpeg.exec([
        "-i", "in.webm",
        "-vf", `scale=${CANVAS_W}:${CANVAS_H}`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        "out.mp4",
      ]);
      if (state.exportCancelled) return;

      const data = await ffmpeg.readFile("out.mp4");
      const mp4Blob = new Blob([data.buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(mp4Blob);

      setExportStage("Done — your 9:16 MP4 is ready.", 100);
      btnDownloadResult.href = url;
      btnDownloadResult.hidden = false;
      const safeName = (state.sourceFileName || "hook-export").replace(/\.[^.]+$/, "");
      btnDownloadResult.download = `${safeName}-hook.mp4`;
    } catch (err) {
      console.error(err);
      setExportStage("Export failed: " + (err.message || "unknown error"), 0);
      showToast("Export failed — see the export window for details.");
    } finally {
      sourceThumbVideo.loop = wasVideoLoop;
      sourceThumbVideo.muted = wasVideoMuted;
    }
  }

  function pickMimeType() {
    const options = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    return options.find((o) => window.MediaRecorder && MediaRecorder.isTypeSupported(o)) || "video/webm";
  }

  function recordComposite() {
    return new Promise((resolve, reject) => {
      const canvasStream = stageCanvas.captureStream(30);

      const captureFn = sourceThumbVideo.captureStream || sourceThumbVideo.mozCaptureStream;
      if (state.sourceType === "video" && typeof captureFn === "function") {
        try {
          const mediaStream = captureFn.call(sourceThumbVideo);
          mediaStream.getAudioTracks().forEach((t) => canvasStream.addTrack(t));
        } catch { /* no audio track available — export continues silently */ }
      }

      const recorder = new MediaRecorder(canvasStream, { mimeType: pickMimeType(), videoBitsPerSecond: 8_000_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onerror = (e) => reject(e.error || new Error("Recording failed"));
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));

      const finishRecording = () => {
        cleanup();
        if (recorder.state !== "inactive") recorder.stop();
      };

      let cleanup = () => {};

      if (state.sourceType === "video") {
        sourceThumbVideo.loop = false;
        sourceThumbVideo.muted = true; // silent on-screen; captureStream still carries real audio
        sourceThumbVideo.currentTime = 0;
        const onEnded = () => finishRecording();
        sourceThumbVideo.addEventListener("ended", onEnded, { once: true });
        cleanup = () => sourceThumbVideo.removeEventListener("ended", onEnded);
        recorder.start();
        sourceThumbVideo.play().catch((e) => reject(e));
      } else {
        state.virtualTime = 0;
        state.isPlaying = true;
        recorder.start();
        const check = setInterval(() => {
          if (state.virtualTime >= IMAGE_DURATION || state.exportCancelled) {
            clearInterval(check);
            state.isPlaying = false;
            finishRecording();
          }
        }, 100);
        cleanup = () => clearInterval(check);
      }
    });
  }

})();
