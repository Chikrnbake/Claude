/* ═══════════════════════════════════════════════════════════════════
   script.js  —  Ocean Horizon
   ───────────────────────────────────────────────────────────────────
   Responsibilities
     1. Boot WebGL on the #ocean <canvas>
     2. Compile the Simplex-noise / domain-warp fragment shader
     3. Drive a 60 fps render loop  (u_time, u_resolution, u_speed)
     4. Map window.scrollY → canvas translateY  ("rising ocean")
     5. Pass scroll velocity as u_speed so ripples quicken mid-scroll
     6. Mouse-move parallax across all [data-speed] layers
═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── 1.  WebGL bootstrap ───────────────────────────────────────── */

const canvas = document.getElementById('ocean');
const gl = canvas.getContext('webgl') ||
           canvas.getContext('experimental-webgl');

if (!gl) {
  console.warn('WebGL unavailable – ocean will not render.');
}

/* Read shader sources from the inert <script> tags in the HTML */
const vertSrc = document.getElementById('vert-shader').textContent.trim();
const fragSrc = document.getElementById('frag-shader').textContent.trim();

/* ── 2.  Compile & link ────────────────────────────────────────── */

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

const program = gl.createProgram();
gl.attachShader(program, compileShader(gl.VERTEX_SHADER,   vertSrc));
gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragSrc));
gl.linkProgram(program);

if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  console.error('Program link error:', gl.getProgramInfoLog(program));
}

gl.useProgram(program);

/* ── 3.  Geometry  (full-screen triangle pair) ─────────────────── */

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
  -1, -1,   1, -1,   -1, 1,
  -1,  1,   1, -1,    1, 1,
]), gl.STATIC_DRAW);

const aPosLoc = gl.getAttribLocation(program, 'a_pos');
gl.enableVertexAttribArray(aPosLoc);
gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

/* ── 4.  Uniform locations ─────────────────────────────────────── */

const uTime       = gl.getUniformLocation(program, 'u_time');
const uResolution = gl.getUniformLocation(program, 'u_resolution');
const uSpeed      = gl.getUniformLocation(program, 'u_speed');

/* ── 5.  Resize  ───────────────────────────────────────────────── */

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener('resize', resize, { passive: true });
resize();

/* ── 6.  Scroll state  ─────────────────────────────────────────── */

/*
   RISE_OFFSET  –  how many percent of canvas height is initially
                   hidden below the viewport (canvas starts low).
   RISE_RANGE   –  how many scroll pixels it takes for the ocean
                   to fully rise (translateY reaches 0).
*/
const RISE_OFFSET = 42;   /* % */
const RISE_RANGE  = () => window.innerHeight * 1.1;

let scrollY      = window.scrollY;
let lastScrollY  = scrollY;
let rawSpeed     = 0;   /* px/frame delta                           */
let smoothSpeed  = 0;   /* lerped, passed as u_speed (0–1)         */

window.addEventListener('scroll', () => {
  scrollY = window.scrollY;
}, { passive: true });

/* ── 7.  Mouse-move parallax (depth layers via data-speed) ─────── */

/*
   Any element with  data-speed="0.xx"  shifts on mouse-move.
   Higher speed = closer to camera = more movement.
   (The #ocean canvas is handled separately via GL shader.)
*/
const parallaxLayers = [...document.querySelectorAll('[data-speed]')];

const MOUSE_AMP  = 24;     /* max px displacement (full tilt)      */
const LERP_MX    = 0.055;  /* lower = smoother / more lag           */

let mx = 0, my = 0;
let smx = 0, smy = 0;

window.addEventListener('mousemove', e => {
  mx = (e.clientX / window.innerWidth  - 0.5) * 2;
  my = (e.clientY / window.innerHeight - 0.5) * 2;
}, { passive: true });

/* Gyroscope fallback for mobile */
window.addEventListener('deviceorientation', e => {
  if (e.gamma == null) return;
  mx = Math.max(-1, Math.min(1, e.gamma / 25));
  my = Math.max(-1, Math.min(1, (e.beta - 30) / 30));
}, { passive: true });

/* ── 8.  Render loop ───────────────────────────────────────────── */

const startTime = performance.now();
let rafId;

function tick() {
  /* ── a) Time ── */
  const now     = performance.now();
  const elapsed = (now - startTime) / 1000;

  /* ── b) Scroll velocity ── */
  rawSpeed    = Math.abs(scrollY - lastScrollY);
  lastScrollY = scrollY;
  /* Exponential smoothing so speed decays gracefully after scrolling stops */
  smoothSpeed += (Math.min(rawSpeed / 12, 1.0) - smoothSpeed) * 0.08;

  /* ── c) Ocean canvas rise ── */
  const ty = Math.max(
    0,
    RISE_OFFSET * (1 - Math.min(scrollY, RISE_RANGE()) / RISE_RANGE())
  );
  canvas.style.transform = `translateY(${ty.toFixed(3)}%)`;

  /* ── d) Mouse parallax on data-speed layers ── */
  smx += (mx - smx) * LERP_MX;
  smy += (my - smy) * LERP_MX;

  parallaxLayers.forEach(el => {
    const sp = parseFloat(el.dataset.speed);
    const dx = smx * MOUSE_AMP * sp;
    const dy = scrollY * sp + smy * MOUSE_AMP * sp * 0.5;
    el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
  });

  /* ── e) Draw WebGL frame ── */
  if (gl) {
    gl.uniform1f(uTime,       elapsed);
    gl.uniform2f(uResolution, canvas.width, canvas.height);
    gl.uniform1f(uSpeed,      smoothSpeed);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  rafId = requestAnimationFrame(tick);
}

/* Pause when tab is hidden */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else {
    lastScrollY = scrollY; /* reset delta to avoid speed spike on resume */
    rafId = requestAnimationFrame(tick);
  }
});

tick();
