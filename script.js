/* ═══════════════════════════════════════════════════════════════════
   script.js  —  Ocean Horizon
   ───────────────────────────────────────────────────────────────────
   Responsibilities
     1.  Boot WebGL2 (fallback to WebGL1) on the #ocean <canvas>
     2.  Compile main render shader (Gerstner + noise + contours)
     3.  Compile shallow-water sim shader
     4.  Each frame: sim step on ping-pong FBO → main render to canvas
     5.  Inject disturbances from scroll velocity and mouse position
     6.  Map window.scrollY → canvas translateY  ("rising ocean")
     7.  Pass scroll velocity as u_speed so shader reacts to scrolling
     8.  Mouse-move parallax across all [data-speed] layers
═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ── 1.  WebGL context  (prefer WebGL2 for float FBO support) ──── */

const canvas = document.getElementById('ocean');
let gl = canvas.getContext('webgl2');
const isGL2 = !!gl;
if (!gl) gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
if (!gl) console.warn('WebGL unavailable – ocean will not render.');

/*
   Choose texture format for the ping-pong simulation buffers.
   WebGL2  → RGBA32F (sized internal format) + EXT_color_buffer_float
   WebGL1  → RGBA  + OES_texture_float + WEBGL_color_buffer_float
   Fallback → RGBA UNSIGNED_BYTE (8-bit; less precision but works)
*/
let simIntFmt, simType;
if (gl) {
  if (isGL2) {
    gl.getExtension('EXT_color_buffer_float');
    simIntFmt = gl.RGBA32F;
    simType   = gl.FLOAT;
  } else {
    const extF   = gl.getExtension('OES_texture_float');
    const extFBO = gl.getExtension('WEBGL_color_buffer_float');
    simIntFmt = gl.RGBA;
    simType   = (extF && extFBO) ? gl.FLOAT : gl.UNSIGNED_BYTE;
  }
}

/* ── 2.  Shader sources from inert <script> tags ───────────────── */

const vertSrc = document.getElementById('vert-shader').textContent.trim();
const fragSrc = document.getElementById('frag-shader').textContent.trim();
const simSrc  = document.getElementById('sim-shader').textContent.trim();

/* ── 3.  Compile & link helpers ────────────────────────────────── */

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

function linkProg(vSrc, fSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl.VERTEX_SHADER,   vSrc));
  gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    console.error('Program link error:', gl.getProgramInfoLog(p));
  return p;
}

const program    = gl && linkProg(vertSrc, fragSrc);  /* main render  */
const simProgram = gl && linkProg(vertSrc, simSrc);   /* simulation   */

/* ── 4.  Shared full-screen quad geometry ──────────────────────── */

const quadBuf = gl && (() => {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,   1, -1,   -1,  1,
    -1,  1,   1, -1,    1,  1,
  ]), gl.STATIC_DRAW);
  return b;
})();

/* Cache attribute locations — they don't change after linking */
const mainAPos = gl && gl.getAttribLocation(program,    'a_pos');
const simAPos  = gl && gl.getAttribLocation(simProgram, 'a_pos');

/* Bind the quad buffer and draw — called once per program per frame */
function drawQuad(aLoc) {
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/* ── 5.  Uniform locations — main render program ───────────────── */

const uTime       = gl && gl.getUniformLocation(program, 'u_time');
const uResolution = gl && gl.getUniformLocation(program, 'u_resolution');
const uSpeed      = gl && gl.getUniformLocation(program, 'u_speed');
const uSimTex     = gl && gl.getUniformLocation(program, 'u_simTex');

/* ── 6.  Uniform locations — simulation program ─────────────────── */

const uSimRes      = gl && gl.getUniformLocation(simProgram, 'u_simResolution');
const uDisturbance = gl && gl.getUniformLocation(simProgram, 'u_disturbance');
const uDisturbStr  = gl && gl.getUniformLocation(simProgram, 'u_disturbStrength');
const uSimTexIn    = gl && gl.getUniformLocation(simProgram, 'u_simTex');

/* ── 7.  Ping-pong FBOs ────────────────────────────────────────── */

/*
   Two framebuffers (ping / pong) backed by float (or byte) textures
   at full canvas resolution.  Each frame:
     read from current  → write into other → swap
   The freshly-written texture is then passed as u_simTex to the
   main render program.
*/

let pingFBO, pingTex, pongFBO, pongTex;
let pingPong = false;   /* false → read ping / write pong */

function makeFBO(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);

  /* Initialise every pixel to 0.5 = equilibrium height & zero velocity */
  const data = (simType === gl.FLOAT)
    ? new Float32Array(w * h * 4).fill(0.5)
    : new Uint8Array(w * h * 4).fill(128);   /* 128/255 ≈ 0.502 */

  gl.texImage2D(gl.TEXTURE_2D, 0, simIntFmt, w, h, 0, gl.RGBA, simType, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                           gl.TEXTURE_2D, tex, 0);

  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    console.warn('Sim FBO incomplete – simulation may not function');

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { fbo, tex };
}

function initFBOs(w, h) {
  /* Destroy previous pair if resizing */
  if (pingFBO) { gl.deleteFramebuffer(pingFBO); gl.deleteTexture(pingTex); }
  if (pongFBO) { gl.deleteFramebuffer(pongFBO); gl.deleteTexture(pongTex); }
  const a = makeFBO(w, h);  pingFBO = a.fbo;  pingTex = a.tex;
  const b = makeFBO(w, h);  pongFBO = b.fbo;  pongTex = b.tex;
  pingPong = false;
}

/* ── 8.  Resize  ───────────────────────────────────────────────── */

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    initFBOs(canvas.width, canvas.height);  /* sim state resets on resize */
  }
}
window.addEventListener('resize', resize, { passive: true });
resize();

/* ── 9.  Scroll state  ─────────────────────────────────────────── */

/*
   RISE_OFFSET  – how many % of canvas height is initially hidden
                  below the viewport  (ocean starts low, then rises).
   RISE_RANGE   – scroll pixels needed for the ocean to fully rise.
*/
const RISE_OFFSET = 55;   /* % */
const RISE_RANGE  = () => window.innerHeight * 1.1;

let scrollY     = window.scrollY;
let lastScrollY = scrollY;
let rawSpeed    = 0;   /* px/frame delta                             */
let smoothSpeed = 0;   /* exponentially smoothed, sent as u_speed   */

window.addEventListener('scroll', () => { scrollY = window.scrollY; },
                        { passive: true });

/* ── 10. Disturbance state ─────────────────────────────────────── */

/*
   Scroll disturbance: when the user scrolls fast, inject an impulse
   at a fixed UV position near the cliff base.

   Mouse disturbance: when the mouse moves over the canvas, inject
   at the cursor's normalised UV position for 3 frames.

   UV convention: (0,0) = bottom-left of canvas  (WebGL origin).
*/

let distUV    = [-1, -1];   /* active disturbance UV  (-1,-1 = none) */
let distStr   = 0;
let mouseDUV  = [-1, -1];   /* last mouse UV over canvas              */
let mouseDCnt = 0;          /* frames remaining for mouse disturbance */

canvas.addEventListener('mousemove', e => {
  const r   = canvas.getBoundingClientRect();
  mouseDUV  = [
    (e.clientX - r.left) / canvas.width,
    1.0 - (e.clientY - r.top) / canvas.height,   /* flip Y for WebGL  */
  ];
  mouseDCnt = 3;
}, { passive: true });

/* ── 11. Mouse-move parallax (depth layers via data-speed) ─────── */

/*
   Any element with data-speed="0.xx" shifts on mouse-move.
   Higher speed = closer to camera = more movement.
   The #ocean canvas is driven by the GL shader separately.
*/
const parallaxLayers = [...document.querySelectorAll('[data-speed]')];

const MOUSE_AMP = 24;     /* max px displacement at full tilt        */
const LERP_MX   = 0.055;  /* lerp coefficient — lower = more lag    */

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

/* ── 12. Render loop ───────────────────────────────────────────── */

const startTime = performance.now();
let rafId;

function tick() {

  /* ── a) Time ── */
  const elapsed = (performance.now() - startTime) / 1000;

  /* ── b) Scroll velocity ── */
  rawSpeed    = Math.abs(scrollY - lastScrollY);
  lastScrollY = scrollY;
  /* Exponential smoothing — speed decays gracefully after stop */
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
    el.style.transform = `translate(${(smx * MOUSE_AMP * sp).toFixed(2)}px,`
                       + `${(scrollY * sp + smy * MOUSE_AMP * sp * 0.5).toFixed(2)}px)`;
  });

  if (!gl) { rafId = requestAnimationFrame(tick); return; }

  /* ── e) Resolve disturbance for this frame ── */
  if (rawSpeed > 2) {
    /* Scroll disturbance: inject near cliff base */
    distUV  = [0.18, 0.22];
    distStr = Math.min(rawSpeed / 20.0, 0.6);
  } else if (mouseDCnt > 0) {
    /* Mouse disturbance: track cursor for 3 frames */
    distUV  = mouseDUV;
    distStr = 0.18;
    mouseDCnt--;
  } else {
    /* No disturbance this frame */
    distUV  = [-1.0, -1.0];
    distStr = 0.0;
  }

  /* ── f) Simulation step ── */
  /*
     Read from the last-written buffer, write into the other one,
     then swap.  After the swap, pingPong points to the just-written
     buffer which is passed to the main render as u_simTex.
  */
  const readTex  = pingPong ? pongTex : pingTex;
  const writeFBO = pingPong ? pingFBO : pongFBO;

  gl.useProgram(simProgram);
  gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
  gl.viewport(0, 0, canvas.width, canvas.height);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, readTex);
  gl.uniform1i(uSimTexIn,    0);
  gl.uniform2f(uSimRes,      canvas.width, canvas.height);
  gl.uniform2f(uDisturbance, distUV[0], distUV[1]);
  gl.uniform1f(uDisturbStr,  distStr);
  drawQuad(simAPos);

  pingPong = !pingPong;   /* swap — next read comes from what we just wrote */

  /* ── g) Main render to canvas ── */
  const simTexture = pingPong ? pongTex : pingTex;   /* just-written result */

  gl.useProgram(program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);           /* render to canvas   */
  gl.viewport(0, 0, canvas.width, canvas.height);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, simTexture);
  gl.uniform1i(uSimTex,      0);
  gl.uniform1f(uTime,        elapsed);
  gl.uniform2f(uResolution,  canvas.width, canvas.height);
  gl.uniform1f(uSpeed,       smoothSpeed);
  drawQuad(mainAPos);

  rafId = requestAnimationFrame(tick);
}

/* Pause when tab is hidden to save GPU cycles */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
  } else {
    lastScrollY = scrollY;   /* reset delta to avoid spike on resume  */
    rafId = requestAnimationFrame(tick);
  }
});

tick();
