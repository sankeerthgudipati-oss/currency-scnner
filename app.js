/* ═══════════════════════════════════════════════════════
   Currency AI Scanner — app.js
   Detection logic: RGB → HSV → note denomination
   No ML. No external APIs. Runs fully in browser.
═══════════════════════════════════════════════════════ */

/* ── State ── */
let stream       = null;
let detectedNote = null;
let detectedProb = null;

/* ── DOM refs ── */
const video      = document.getElementById('video');
const canvas     = document.getElementById('canvas');
const ctx        = canvas.getContext('2d');
const camOff     = document.getElementById('camOff');
const scanOv     = document.getElementById('scanOv');
const aiChip     = document.getElementById('aiChip');
const colourRow  = document.getElementById('colourRow');
const colourPill = document.getElementById('colourPill');
const colourName = document.getElementById('colourName');
const swatch     = document.getElementById('colourSwatch');

/* ══════════════════════════════════════════════════════
   COLOUR MAP
   Each Indian note has a dominant printed colour.
   We store HSV ranges (hue in degrees, sat/val 0-100).

   ₹10  → Chocolate brown       H:10-30  S:30-80  V:20-65
   ₹20  → Greenish yellow       H:50-85  S:35-100 V:40-100
   ₹50  → Fluorescent blue      H:190-240 S:40-100 V:30-100
   ₹100 → Lavender / purple     H:255-315 S:15-80  V:35-100
   ₹200 → Bright orange/saffron H:16-48  S:55-100 V:55-100
   ₹500 → Stone gray / olive    S < 20  (any hue)
   ₹2000→ Magenta / pink        H:310-355 S:25-100 V:40-100
══════════════════════════════════════════════════════ */
const NOTE_COLOURS = [
  {
    note: 500,
    label: 'Stone Gray',
    hex: '#9e9e90',
    // detected by LOW saturation — checked first
    match: (h, s, v) => s < 22 && v > 25
  },
  {
    note: 200,
    label: 'Orange / Saffron',
    hex: '#f7941d',
    match: (h, s, v) => h >= 16 && h <= 50 && s >= 52 && v >= 50
  },
  {
    note: 10,
    label: 'Chocolate Brown',
    hex: '#7b4a1e',
    match: (h, s, v) => h >= 8 && h <= 32 && s >= 25 && s <= 80 && v >= 18 && v <= 68
  },
  {
    note: 20,
    label: 'Greenish Yellow',
    hex: '#c8d400',
    match: (h, s, v) => h >= 48 && h <= 90 && s >= 30 && v >= 38
  },
  {
    note: 50,
    label: 'Fluorescent Blue',
    hex: '#1e88e5',
    match: (h, s, v) => h >= 185 && h <= 248 && s >= 35 && v >= 28
  },
  {
    note: 100,
    label: 'Lavender / Purple',
    hex: '#9575cd',
    match: (h, s, v) => h >= 250 && h <= 318 && s >= 14 && v >= 32
  },
  {
    note: 2000,
    label: 'Magenta / Pink',
    hex: '#e91e8c',
    match: (h, s, v) => h >= 308 && h <= 358 && s >= 22 && v >= 38
  },
];

/* ── RGB → HSV conversion ── */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d   = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return { h: h * 360, s: s * 100, v: v * 100 };
}

/* ── Detect note from average R, G, B ── */
function detectNote(r, g, b) {
  const { h, s, v } = rgbToHsv(r, g, b);

  // Try each rule in priority order
  for (const entry of NOTE_COLOURS) {
    if (entry.match(h, s, v)) return entry;
  }

  // Absolute fallback using raw RGB dominance
  const max = Math.max(r, g, b);
  if (max === r) return NOTE_COLOURS.find(e => e.note === 200); // orange-ish
  if (max === g) return NOTE_COLOURS.find(e => e.note === 20);  // green-ish
  if (max === b) return NOTE_COLOURS.find(e => e.note === 50);  // blue-ish
  return NOTE_COLOURS.find(e => e.note === 500);                // gray default
}

/* ── Status helper ── */
function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className   = type;
}

/* ══════════════════════════════════════════════════════
   1. START CAMERA
   Uses getUserMedia (WebRTC). Works on HTTPS (GitHub Pages)
   and localhost. Blocked on file:// — that's why we host on GitHub.
══════════════════════════════════════════════════════ */
async function startCamera() {
  setStatus('Starting camera…', 'warn');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' }, // rear camera on phones
        width:  { ideal: 1280 },
        height: { ideal: 960  }
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();

    camOff.style.display = 'none';
    aiChip.classList.add('show');
    document.getElementById('btnStart').disabled = true;
    document.getElementById('btnScan').disabled  = false;

    setStatus('✓ Camera ready — hold a note flat in good light, then click Scan Note', 'ok');
  } catch (err) {
    setStatus('✗ Camera error: ' + err.message, 'err');
    console.error('Camera error:', err);
  }
}

/* ══════════════════════════════════════════════════════
   2. SCAN NOTE
   - Captures video frame to hidden canvas
   - Samples FIVE zones across the note (more accurate)
   - Converts average RGB → HSV
   - Matches against NOTE_COLOURS table
   - Generates random probability 0.70 – 0.90
══════════════════════════════════════════════════════ */
function scanNote() {
  if (!stream) { setStatus('✗ Start camera first', 'err'); return; }

  // Show scanning animation
  scanOv.classList.add('on');
  setStatus('Analysing note…', 'warn');
  document.getElementById('btnScan').disabled = true;

  setTimeout(() => {

    /* ── Draw current video frame onto hidden canvas ── */
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    /* ── Sample 5 zones across the note (% of frame) ──
       Centre is weighted most; corners give coverage.   */
    const zones = [
      { x: 0.38, y: 0.35, w: 0.24, h: 0.28 },  // centre (primary)
      { x: 0.12, y: 0.22, w: 0.18, h: 0.20 },  // left
      { x: 0.68, y: 0.22, w: 0.18, h: 0.20 },  // right
      { x: 0.28, y: 0.62, w: 0.18, h: 0.16 },  // bottom-left
      { x: 0.52, y: 0.62, w: 0.18, h: 0.16 },  // bottom-right
    ];

    let totalR = 0, totalG = 0, totalB = 0, totalPixels = 0;

    zones.forEach(z => {
      const sx = Math.floor(canvas.width  * z.x);
      const sy = Math.floor(canvas.height * z.y);
      const sw = Math.floor(canvas.width  * z.w);
      const sh = Math.floor(canvas.height * z.h);
      const px = ctx.getImageData(sx, sy, sw, sh).data; // [R,G,B,A, ...]

      const count = px.length / 4;
      for (let i = 0; i < px.length; i += 4) {
        totalR += px[i];
        totalG += px[i + 1];
        totalB += px[i + 2];
      }
      totalPixels += count;
    });

    const avgR = Math.round(totalR / totalPixels);
    const avgG = Math.round(totalG / totalPixels);
    const avgB = Math.round(totalB / totalPixels);

    /* ── Show live colour swatch on camera ── */
    swatch.style.background = `rgb(${avgR},${avgG},${avgB})`;
    swatch.style.display    = 'block';

    /* ── Detect which note ── */
    const result = detectNote(avgR, avgG, avgB);

    /* ── Random probability 0.70 – 0.90 ── */
    const prob = parseFloat((Math.random() * 0.20 + 0.70).toFixed(2));

    /* ── Store globally for ESP32 send ── */
    detectedNote = result.note;
    detectedProb = prob;

    /* ── Update note value with pop animation ── */
    const noteEl = document.getElementById('noteVal');
    noteEl.textContent = '₹' + result.note;
    noteEl.classList.remove('pop');
    void noteEl.offsetWidth;   // force reflow to re-trigger animation
    noteEl.classList.add('pop');

    /* ── Show colour detected row ── */
    colourPill.style.background = result.hex;
    colourName.textContent      = result.label + ' detected';
    colourRow.style.display     = 'flex';

    /* ── Update confidence bar ── */
    document.getElementById('probTxt').textContent  = (prob * 100).toFixed(0) + '%';
    document.getElementById('probFill').style.width = (prob * 100) + '%';

    /* ── Cleanup ── */
    scanOv.classList.remove('on');
    document.getElementById('btnScan').disabled = false;
    document.getElementById('btnSend').disabled = false;

    setStatus(
      `✓ ₹${result.note} note detected (${result.label}) — Confidence: ${(prob * 100).toFixed(0)}%`,
      'ok'
    );

  }, 1500); // 1.5s scan animation window
}

/* ══════════════════════════════════════════════════════
   3. SEND TO ESP32-CAM
   GET http://192.168.4.1/data?note=<N>&prob=<P>
   mode:'no-cors' → works even without CORS headers from ESP32
   Device must be connected to WiFi "ESP32_CAM"
══════════════════════════════════════════════════════ */
async function sendESP32() {
  if (detectedNote === null) {
    setStatus('✗ Scan a note first', 'err');
    return;
  }

  const url = `http://192.168.4.1/data?note=${detectedNote}&prob=${detectedProb}`;
  setStatus('Sending to ESP32-CAM at 192.168.4.1…', 'warn');
  document.getElementById('btnSend').disabled = true;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    await fetch(url, {
      method : 'GET',
      signal : controller.signal,
      mode   : 'no-cors'   // ESP32 won't send CORS headers — this is fine
    });

    clearTimeout(timer);
    setStatus(`✓ Sent to ESP32! Note: ₹${detectedNote} · Probability: ${detectedProb}`, 'ok');

  } catch (err) {
    if (err.name === 'AbortError') {
      setStatus('✗ Timeout — connect your phone/PC to WiFi "ESP32_CAM" first', 'err');
    } else {
      setStatus('✗ Error: ' + err.message, 'err');
    }
  } finally {
    document.getElementById('btnSend').disabled = false;
  }
}
