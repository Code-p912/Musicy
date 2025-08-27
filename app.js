/**
 * app.js — musicy
 * Single-file application logic (vanilla JS + three.js optional)
 *
 * Features:
 * - WebGL triangle hero with pulse + proximity halo (three.js used)
 * - WebAudio synthesised tones; scheduler with lookahead
 * - Tap to place events; looped sequencer; drag to change pitch/volume
 * - Delay & simple convolution-style reverb toggles (lightweight)
 * - Canvas2D fallback if WebGL unavailable
 * - Export JSON pattern
 */

/* ========= CONFIG ========= */
const CONFIG = {
  LOOKAHEAD: 0.1, // seconds to schedule ahead
  SCHEDULE_INTERVAL: 25, // ms timer to schedule
  DEFAULT_TEMPO: 110,
  LOOP_BEATS: 4,
  SUBDIV: 4, // subdivisions per beat -> 16 steps default
  TRIANGLE_COLOR: 0x8b5cf6,
  PALETTE: ['#8b5cf6','#06b6d4','#fb7185','#22c55e']
};

/* ========= DOM ========= */
const canvas = document.getElementById('stage');
const cta = document.getElementById('cta');
const controls = document.getElementById('controls');
const tempoInput = document.getElementById('tempo');
const tempoVal = document.getElementById('tempoVal');
const toggleDelayBtn = document.getElementById('toggleDelay');
const toggleReverbBtn = document.getElementById('toggleReverb');
const exportBtn = document.getElementById('exportJSON');
const srPlay = document.getElementById('srPlay');

let isWebGL = (typeof THREE !== 'undefined') && (() => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    return !!gl;
  } catch(e){ return false; }
})();

/* ========= AUDIO ========== */
let audioCtx = null;
let master = null;
let globalDelay = null;
let globalReverb = null;
let convolverBuffer = null;
let analyser = null;

/* Oscillator / event defaults */
const synthDefaults = {
  type: 'sine',
  baseFreq: 220, // Hz
  duration: 0.18
};

/* sequencer state */
let tempo = CONFIG.DEFAULT_TEMPO;
let beatLength = 60 / tempo; // seconds per beat
let steps = CONFIG.LOOP_BEATS * CONFIG.SUBDIV; // e.g., 4 * 4 = 16
let loopStartTime = 0; // audioContext time where loop starts
let currentStep = 0;
let events = []; // array of placed events: {step, freq, gain, color, id}

/* scheduler */
let schedulerTimer = null;

/* visuals state */
let renderer, scene, camera, triMesh, particleGroup;
let fallback2D = false;
let pointer = {x:0,y:0,down:false, lastTouchDist:null};
let lastPlacedEventId = null;
let draggingEvent = null;

/* init */
function init(){
  tempoInput.value = tempo;
  tempoVal.textContent = tempo;
  // attach UI events
  cta.addEventListener('click', onStartGesture);
  srPlay.addEventListener('click', onStartGesture);
  tempoInput.addEventListener('input', (e)=>{
    tempo = parseInt(e.target.value,10);
    tempoVal.textContent = tempo;
    beatLength = 60/tempo;
  });
  toggleDelayBtn.addEventListener('click', toggleDelay);
  toggleReverbBtn.addEventListener('click', toggleReverb);
  exportBtn.addEventListener('click', exportPattern);

  // pointer handlers
  canvas.addEventListener('pointerdown', onPointerDown, {passive:false});
  canvas.addEventListener('pointermove', onPointerMove, {passive:false});
  window.addEventListener('pointerup', onPointerUp, {passive:false});
  // basic pinch detection (touch)
  canvas.addEventListener('touchmove', onTouchMove, {passive:false});
  canvas.addEventListener('touchend', onTouchEnd, {passive:false});

  // setup visuals
  if(isWebGL){
    setupThree();
    animate();
  } else {
    setup2D();
    fallback2D = true;
    requestAnimationFrame(draw2D);
  }

  // CTA breathing
  setInterval(()=> cta.classList.toggle('pulse'), 2000);
}

/* ========= AUDIO SETUP ========= */
function ensureAudio(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  master = audioCtx.createGain();
  master.gain.value = 0.9;
  master.connect(audioCtx.destination);

  // delay node (off by default)
  globalDelay = audioCtx.createDelay();
  globalDelay.delayTime.value = 0.18; // base delay
  const delayGain = audioCtx.createGain(); delayGain.gain.value = 0.22;
  globalDelay.connect(delayGain);
  delayGain.connect(master);

  // reverb (convolver) simple impulse
  convolverBuffer = createImpulseResponse(audioCtx, 1.5, 2.0);
  globalReverb = audioCtx.createConvolver();
  globalReverb.buffer = convolverBuffer;
  const reverbGain = audioCtx.createGain(); reverbGain.gain.value = 0.15;
  globalReverb.connect(reverbGain);
  reverbGain.connect(master);

  // analyser for possible visual sync
  analyser = audioCtx.createAnalyser();
  master.connect(analyser);

  // by default we route no effect: sounds connect to master, and optionally to delay/reverb when toggled
}

/* small impulse response generator for convolution reverb */
function createImpulseResponse(context, duration=1.5, decay=2.0){
  const rate = context.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = context.createBuffer(2, length, rate);
  for(let i=0;i<2;i++){
    const channel = impulse.getChannelData(i);
    for(let j=0;j<length;j++){
      channel[j] = (Math.random()*2-1) * Math.pow(1 - j/length, decay);
    }
  }
  return impulse;
}

/* play a single synth event precisely at time t */
function playEventAt(ev, t){
  if(!audioCtx) return;
  // oscillator synth
  const osc = audioCtx.createOscillator();
  osc.type = ev.type || synthDefaults.type;
  osc.frequency.value = ev.freq;
  const env = audioCtx.createGain();
  env.gain.value = 0.0001;

  // filter for character
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 800 + (ev.freq * 0.6);

  // connect chain: osc -> filter -> env -> master
  osc.connect(filter);
  filter.connect(env);

  // optionally route to delay/reverb when enabled
  env.connect(master);
  if(isDelayOn) env.connect(globalDelay);
  if(isReverbOn) env.connect(globalReverb);

  // simple envelope
  const start = t;
  const dur = ev.duration || synthDefaults.duration;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(ev.gain || 0.8, start + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, start + dur);

  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/* ========= SCHEDULER ========= */
let nextStepTime = 0;
function startScheduler(){
  if(schedulerTimer) return;
  if(!audioCtx) ensureAudio();
  // define loopStartTime slightly in future so user hears scheduled events cleanly
  loopStartTime = audioCtx.currentTime + 0.1;
  nextStepTime = loopStartTime;
  currentStep = 0;
  schedulerTimer = setInterval(schedulerLoop, CONFIG.SCHEDULE_INTERVAL);
}

function stopScheduler(){
  if(schedulerTimer){ clearInterval(schedulerTimer); schedulerTimer=null; }
}

function schedulerLoop(){
  const now = audioCtx.currentTime;
  // schedule ahead
  while(nextStepTime < now + CONFIG.LOOKAHEAD){
    // schedule all events on currentStep
    const stepEvents = events.filter(e => e.step === currentStep);
    for(const ev of stepEvents){
      playEventAt(ev, nextStepTime);
      // trigger visual sync
      triggerVisualEvent(ev, nextStepTime - now);
    }
    // increment
    nextStepTime += (60/tempo)/CONFIG.SUBDIV;
    currentStep = (currentStep + 1) % steps;
    // detect loop boundary to keep loopStartTime updated
    if(currentStep === 0) {
      loopStartTime = nextStepTime;
    }
  }
}

/* ========= INTERACTION ========= */
async function onStartGesture(e){
  // unlock audio and go fullscreen if possible
  try{
    ensureAudio();
    await audioCtx.resume();
  }catch(err){ console.warn('audio unlock error',err); }

  // fullscreen attempt
  try{
    if(document.fullscreenEnabled && document.documentElement.requestFullscreen){
      await document.documentElement.requestFullscreen();
    }
  }catch(err){ /* ignore */ }

  // hide CTA and show controls
  cta.classList.add('hidden');
  controls.classList.remove('hidden');

  // start scheduler if not already
  startScheduler();
}

/* pointer interactions: place / drag events */
function onPointerDown(e){
  e.preventDefault();
  pointer.down = true;
  // record pointer pos relative to canvas
  const rect = canvas.getBoundingClientRect();
  pointer.x = (e.clientX - rect.left) / rect.width;
  pointer.y = (e.clientY - rect.top) / rect.height;

  // if pointer near triangle hero, interpret as start gesture click if still visible
  if(!controls.classList.contains('hidden')) {
    // workspace already active — place event
    placeEventAt(pointer.x, pointer.y);
  } else {
    // If CTA visible, trigger start behavior
    onStartGesture();
  }

  // detect if we hit an existing event for dragging (search by proximity)
  const hit = pickEventNear(pointer.x, pointer.y);
  if(hit) {
    draggingEvent = hit;
    lastPlacedEventId = hit.id;
  } else {
    draggingEvent = null;
  }
}

function onPointerMove(e){
  const rect = canvas.getBoundingClientRect();
  pointer.x = (e.clientX - rect.left) / rect.width;
  pointer.y = (e.clientY - rect.top) / rect.height;

  // if dragging an event, map vertical to gain and horizontal to pitch
  if(draggingEvent && pointer.down){
    const ev = events.find(x=>x.id===draggingEvent.id);
    if(ev){
      // map vertical: top -> louder
      const vol = 1 - Math.min(Math.max(pointer.y,0),1);
      ev.gain = 0.2 + vol * 0.8;
      // horizontal: left->lower, right->higher up to one octave
      const pan = Math.min(Math.max(pointer.x,0),1);
      ev.freq = ev.baseFreq * Math.pow(2, (pan-0.5)*2); // +/- 1 octave
    }
  }
}

function onPointerUp(e){
  pointer.down = false;
  draggingEvent = null;
}

/* touch pinch handlers (two-finger pinch to toggle delay as quick example) */
let lastTouchDist = null;
function onTouchMove(e){
  if(e.touches && e.touches.length === 2){
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx,dy);
    if(lastTouchDist !== null){
      const diff = dist - lastTouchDist;
      if(Math.abs(diff) > 15){
        // pinch out -> toggle delay on; pinch in -> toggle delay off
        if(diff > 0) { setDelay(true); }
        else { setDelay(false); }
      }
    }
    lastTouchDist = dist;
  }
}
function onTouchEnd(e){
  lastTouchDist = null;
}

/* place an event on canvas normalized coords -> create event at nearest step */
function placeEventAt(nx, ny){
  if(!audioCtx) ensureAudio();
  // quantize to step based on current time location in loop
  const now = audioCtx.currentTime;
  const loopPos = (now - loopStartTime) % (steps * (60/tempo)/CONFIG.SUBDIV);
  // compute step index from pointer x or from instant time (we choose nearest step from now)
  // easier: use pointer.x to spread pitch and pointer.y for gain, and place at next step
  const stepIndex = (currentStep + 1) % steps;

  const baseFreq = midiToFreq(48 + Math.round((1 - ny) * 24)); // map y to musical range
  const ev = {
    id: 'e'+Math.random().toString(36).slice(2,9),
    step: stepIndex,
    freq: baseFreq,
    baseFreq: baseFreq,
    gain: 0.6,
    duration: 0.18,
    color: CONFIG.PALETTE[Math.floor(Math.random()*CONFIG.PALETTE.length)],
    type: 'sine'
  };
  events.push(ev);
  lastPlacedEventId = ev.id;

  // immediate feedback: play now and visual
  playEventAt({...ev, gain: ev.gain}, audioCtx.currentTime + 0.005);
  triggerVisualEvent(ev, 0);
}

/* pick an event near normalized coords */
function pickEventNear(nx, ny){
  // map event step to x position for UI consistency
  if(events.length === 0) return null;
  let best=null; let bestDist=1;
  for(const ev of events){
    // position from step index around a circle: compute angle
    const angle = (ev.step / steps) * Math.PI * 2 - Math.PI/2;
    const ex = 0.5 + 0.28 * Math.cos(angle);
    const ey = 0.5 + 0.28 * Math.sin(angle);
    const d = Math.hypot(nx-ex, ny-ey);
    if(d < 0.08 && d < bestDist){
      best=ev; bestDist=d;
    }
  }
  return best;
}

/* MIDI helpers */
function midiToFreq(m){
  return 440 * Math.pow(2, (m-69)/12);
}

/* ========= VISUALS (three.js) ========= */
let threeWidth = 1, threeHeight=1;
function setupThree(){
  renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, window.innerWidth/window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 2.5);

  // central triangle geometry
  const triGeo = new THREE.BufferGeometry();
  const vertices = new Float32Array([
    0, 0.9, 0,
    -0.8, -0.6, 0,
    0.8, -0.6, 0
  ]);
  triGeo.setAttribute('position', new THREE.BufferAttribute(vertices,3));
  const triMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:{value:0},
      uColor:{value:new THREE.Color(CONFIG.TRIANGLE_COLOR)},
      uGlow:{value:1.0},
      uPointer:{value:new THREE.Vector2(0,0)}
    },
    vertexShader: `
      varying vec2 vUv;
      uniform float uTime;
      void main(){
        vUv = position.xy;
        vec3 pos = position;
        // breathing scale
        float s = 1.0 + 0.03 * sin(uTime * 2.0);
        pos.xy *= s;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos,1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform vec2 uPointer;
      uniform float uTime;
      void main(){
        // rim glow based on distance from triangle center
        float d = length(vUv);
        float glow = smoothstep(0.9, 0.2, d);
        // pointer proximity halo
        float pd = length(uPointer - vUv*0.5 - vec2(0.5));
        float halo = exp(-pd*6.0);
        vec3 col = mix(uColor, vec3(1.0), halo*0.6);
        col += vec3(0.02,0.01,0.03) * (1.0 - d);
        gl_FragColor = vec4(col * glow * 1.4, glow);
      }
    `,
    transparent:true,
    depthTest:false,
    depthWrite:false
  });

  triMesh = new THREE.Mesh(triGeo, triMat);
  scene.add(triMesh);

  // small particle group to display event pops
  particleGroup = new THREE.Group();
  scene.add(particleGroup);

  window.addEventListener('resize', onResize);
  onResize();
}

/* trigger visual event: schedule a particle/ripple shortly */
function triggerVisualEvent(ev, latency){
  // If using three.js: spawn a small sprite that expands and fades
  if(!isWebGL || fallback2D){
    // 2D handled elsewhere
    push2DRipple(ev);
    return;
  }
  const t = Date.now();
  const geom = new THREE.CircleGeometry(0.06, 16);
  const mat = new THREE.MeshBasicMaterial({color: new THREE.Color(ev.color), transparent:true, opacity:0.95});
  const mesh = new THREE.Mesh(geom, mat);
  // position around triangle in circular layout per step
  const angle = (ev.step / steps) * Math.PI * 2 - Math.PI/2;
  mesh.position.set(0.5 * Math.cos(angle), 0.5 * Math.sin(angle), 0);
  particleGroup.add(mesh);
  // animate: expand + fade over 450ms
  const start = performance.now() + (latency*1000);
  const dur = 420;
  const animateParticle = (now) => {
    const tnow = now - start;
    if(tnow < 0){
      requestAnimationFrame(animateParticle);
      return;
    }
    const p = Math.min(tnow / dur, 1);
    mesh.scale.setScalar(1 + p*2.5);
    mesh.material.opacity = 1 - p;
    if(p < 1) requestAnimationFrame(animateParticle);
    else particleGroup.remove(mesh);
  };
  requestAnimationFrame(animateParticle);
}

/* three animate loop */
function animate(t){
  requestAnimationFrame(animate);
  if(triMesh){
    triMesh.material.uniforms.uTime.value = (t || 0) * 0.001;
    // pointer uniform in triangle space
    triMesh.material.uniforms.uPointer.value.set((pointer.x - 0.5)*2, (0.5 - pointer.y)*2);
  }
  renderer.render(scene, camera);
}

/* resize handler */
function onResize(){
  if(!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w,h);
  camera.aspect = w/h;
  camera.updateProjectionMatrix();
}

/* ========= 2D FALLBACK ========= */
let ctx2d = null;
function setup2D(){
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx2d = canvas.getContext('2d');
  ctx2d.scale(devicePixelRatio, devicePixelRatio);
}

/* simple 2D ripple queue */
let rippleQueue = [];
function push2DRipple(ev){
  rippleQueue.push({
    x: window.innerWidth*(0.5 + 0.28 * Math.cos((ev.step/steps)*Math.PI*2 - Math.PI/2)),
    y: window.innerHeight*(0.5 + 0.28 * Math.sin((ev.step/steps)*Math.PI*2 - Math.PI/2)),
    color: ev.color,
    start: performance.now()
  });
}

function draw2D(){
  const w = window.innerWidth, h = window.innerHeight;
  ctx2d.clearRect(0,0,w,h);
  // background subtle gradient
  const g = ctx2d.createLinearGradient(0,0,w,h);
  g.addColorStop(0, '#020205');
  g.addColorStop(1, '#04040a');
  ctx2d.fillStyle = g;
  ctx2d.fillRect(0,0,w,h);

  // draw triangle
  ctx2d.save();
  ctx2d.translate(w/2, h/2 - 60);
  const s = 1 + 0.03 * Math.sin(performance.now() * 0.002);
  ctx2d.scale(s,s);
  ctx2d.beginPath();
  ctx2d.moveTo(0, -120);
  ctx2d.lineTo(-110, 80);
  ctx2d.lineTo(110, 80);
  ctx2d.closePath();
  // glow
  ctx2d.shadowBlur = 40;
  ctx2d.shadowColor = CONFIG.PALETTE[0];
  ctx2d.fillStyle = '#0b0620';
  ctx2d.fill();
  ctx2d.restore();

  // ripples
  const now = performance.now();
  for(let i=rippleQueue.length-1;i>=0;i--){
    const r = rippleQueue[i];
    const t = (now - r.start)/420;
    if(t>1) { rippleQueue.splice(i,1); continue; }
    ctx2d.beginPath();
    ctx2d.arc(r.x, r.y, 40 + t*120, 0, Math.PI*2);
    ctx2d.strokeStyle = r.color;
    ctx2d.globalAlpha = 1 - t;
    ctx2d.lineWidth = 6 * (1 - t);
    ctx2d.stroke();
    ctx2d.globalAlpha = 1;
  }

  requestAnimationFrame(draw2D);
}

/* ========= FX TOGGLING ========= */
let isDelayOn = false;
let isReverbOn = false;
function toggleDelay(){ setDelay(!isDelayOn); }
function setDelay(on){
  isDelayOn = on;
  toggleDelayBtn.textContent = `Delay: ${on ? 'on':'off'}`;
  // no further plumbing required — nodes exist and get connected when playing events
}
function toggleReverb(){ setReverb(!isReverbOn); }
function setReverb(on){
  isReverbOn = on;
  toggleReverbBtn.textContent = `Reverb: ${on ? 'on':'off'}`;
}

/* ========= EXPORT ========= */
function exportPattern(){
  const out = {
    tempo,
    steps,
    events: events.map(e=>({
      step: e.step, freq: e.freq, gain: e.gain, duration: e.duration, color: e.color, type: e.type
    }))
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.getElementById('downloadLink');
  a.href = url;
  a.download = 'musicy-pattern.json';
  a.click();
}

/* ========= UTIL ========= */
function rand(min,max){ return min + Math.random()*(max-min); }

/* initialize app */
init();

/* ======= Accessibility small feature: keyboard Play ====== */
window.addEventListener('keydown', (e)=>{
  if(e.code === 'Space'){
    e.preventDefault();
    onStartGesture();
  }
});
