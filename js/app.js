// The app: wires the score, follower engine, orchestra sound and inputs
// (microphone or MIDI) to the page.
import { Score, BAR } from "./score.js";
import { Engine } from "./engine.js";
import { AudioFrontEnd } from "./micfront.js";
import { Sampler } from "./sampler.js";

const AHEAD = 0.04;  // s; orchestra notes are scheduled this far ahead
const TICK_MS = 8;
const $ = id => document.getElementById(id);

// ------------------------------------------------------------ settings
const store = {
  get(k, d) {
    try { const v = localStorage.getItem("concerto:" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
  },
  set(k, v) { try { localStorage.setItem("concerto:" + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};
const hasMidi = typeof navigator.requestMIDIAccess === "function";
const settings = {
  startBar: store.get("startBar", 1),
  mode: store.get("mode", hasMidi ? "midi" : "mic"),
  echo: store.get("echo", false),
  aec: store.get("aec", false),
  volume: store.get("volume", 0.9),
  latencyMs: store.get("latencyMs", 0),
  phrasing: store.get("phrasing", true),
  muted: new Set(store.get("muted", [])),
  tempos: store.get("tempos", {}),     // "sectionStart@rowBeat" -> bpm (score tempos)
  modes: store.get("modes", {}),       // section start beat -> "recording" | "score" | "keep"
  speed: store.get("speed", {}),       // section start beat -> % of the recording's tempo
};
for (const a of store.get("keep", [])) settings.modes[a] ??= "keep"; // older setting
const save = () => {
  store.set("startBar", settings.startBar); store.set("mode", settings.mode); store.set("echo", settings.echo); store.set("aec", settings.aec);
  store.set("volume", settings.volume); store.set("latencyMs", settings.latencyMs); store.set("phrasing", settings.phrasing);
  store.set("muted", [...settings.muted]); store.set("tempos", settings.tempos); store.set("modes", settings.modes); store.set("speed", settings.speed);
};

// ------------------------------------------------------------ state
let data, ref;            // score data; a Score for queries (sections, tempo)
let ctx, sampler;
let engine = null, front = null, timer = null, wakeLock = null;
let orchestraFirst = false, endAt = null;
let mic = null, midi = null;
const echoVoices = new Map();
// for tests and troubleshooting (browser console)
const debug = { played: 0, heard: [] };
window.concerto = { debug, get engine() { return engine; }, get ctx() { return ctx; }, midi: e => onMidi(e) };

const barOf = beat => Math.floor(beat / BAR + 1e-9) + 1;
const fmtBars = (a, b) => { const x = barOf(a), y = barOf(b - 1e-6); return x === y ? `Bar ${x}` : `Bars ${x}–${y}`; };

function status(text, warn = false) {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("warn", warn);
}

// ------------------------------------------------------------ tempo settings
// Each orchestra-only section plays either like the recording (its tempo
// curve, with the slowing and pressing on, at a speed the player can scale),
// at the score's tempos (each changeable), or at the player's last tempo.
function sectionRows(a, b) {
  const rows = [[a, ref.nominalBpm(a)]];
  for (const [beat, bpm] of data.tempo) if (beat > a && beat < b) rows.push([beat, bpm]);
  return rows;
}

const recTempo = a => (data.recTempo || []).find(r => Math.abs(r.start - a) < 1e-6);
const sectionMode = a => settings.modes[a] ?? (recTempo(a) ? "recording" : "score");

function effectiveTempoMap() {
  const sections = ref.orchestraSections();
  const points = new Set(data.tempo.map(r => r[0]));
  for (const [a, b] of sections) {
    points.add(a); points.add(b);
    const rt = recTempo(a);
    if (sectionMode(a) === "recording" && rt) for (const [beat] of rt.bpm) if (beat >= a && beat < b) points.add(beat);
  }
  const at = beat => {
    for (const [a, b] of sections) {
      if (a <= beat && beat < b) {
        const rt = recTempo(a);
        if (sectionMode(a) === "recording" && rt) {
          let v = rt.bpm[0][1];
          for (const [rb, bpm] of rt.bpm) if (rb <= beat) v = bpm;
          return Math.round(v * (settings.speed[a] ?? 100) / 100 * 10) / 10;
        }
        let bpm = null;
        for (const [rb, base] of sectionRows(a, b)) if (rb <= beat) bpm = settings.tempos[`${a}@${rb}`] ?? base;
        return bpm;
      }
    }
    return ref.nominalBpm(beat);
  };
  const map = [];
  for (const p of [...points].sort((x, y) => x - y)) {
    const bpm = at(p);
    if (!map.length || map[map.length - 1][1] !== bpm) map.push([p, bpm]);
  }
  if (map[0][0] > 0) map.unshift([0, map[0][1]]);
  return map;
}

function numberInput(value, min, max, onset) {
  const input = document.createElement("input");
  input.type = "number"; input.inputMode = "numeric"; input.min = min; input.max = max;
  input.value = value;
  input.onchange = () => {
    const v = Math.round(+input.value);
    if (!(v >= min && v <= max)) { input.value = value; return; }
    value = v;
    onset(v, input);
  };
  return input;
}

function renderSections() {
  const box = $("sections");
  box.innerHTML = "";
  for (const [a, b] of ref.orchestraSections()) {
    const rt = recTempo(a);
    const div = document.createElement("div");
    div.className = "section";
    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = `<b>${fmtBars(a, b)}</b>`;
    const sel = document.createElement("select");
    sel.innerHTML = (rt ? `<option value="recording">Like the recording</option>` : "")
      + `<option value="score">Steady, score tempos</option>`
      + (a > 0 ? `<option value="keep">Keep my last tempo</option>` : ""); // the opening has no tempo of yours
    sel.value = sectionMode(a);
    sel.onchange = () => { settings.modes[a] = sel.value; save(); fill(); };
    const go = document.createElement("button");
    go.className = "small";
    go.textContent = "Start here";
    go.style.marginTop = "0";
    go.onclick = () => { setStartBar(barOf(a)); window.scrollTo({ top: 0, behavior: "smooth" }); };
    head.append(sel, go);
    div.append(head);
    const tempi = document.createElement("div");
    tempi.className = "tempi";
    div.append(tempi);
    const fill = () => {
      tempi.innerHTML = "";
      const mode = sectionMode(a);
      div.classList.toggle("keep", mode === "keep");
      if (mode === "recording") {
        const vals = rt.bpm.map(r => r[1]);
        const row = document.createElement("label");
        row.className = "tempo";
        const span = document.createElement("span");
        span.textContent = `Speed (the recording goes ♩≈${Math.round(Math.min(...vals))}–${Math.round(Math.max(...vals))})`;
        const input = numberInput(settings.speed[a] ?? 100, 50, 150, (v, el) => {
          if (v === 100) delete settings.speed[a]; else settings.speed[a] = v;
          el.classList.toggle("changed", v !== 100);
          save();
        });
        input.classList.toggle("changed", (settings.speed[a] ?? 100) !== 100);
        const unit = document.createElement("small");
        unit.textContent = "%";
        unit.style.color = "var(--dim)";
        row.append(span, input, unit);
        tempi.append(row);
        return;
      }
      for (const [rb, base] of sectionRows(a, b)) {
        const key = `${a}@${rb}`;
        const row = document.createElement("label");
        row.className = "tempo";
        const span = document.createElement("span");
        span.textContent = rb === a ? (a === 0 ? "From the start" : `From bar ${barOf(a)}`) : `From bar ${barOf(rb)}`;
        const input = numberInput(settings.tempos[key] ?? base, 20, 260, (v, el) => {
          if (v === base) delete settings.tempos[key]; else settings.tempos[key] = v;
          el.classList.toggle("changed", v !== base);
          save();
        });
        input.classList.toggle("changed", (settings.tempos[key] ?? base) !== base);
        const unit = document.createElement("small");
        unit.textContent = `score ${base}`;
        unit.style.color = "var(--dim)";
        row.append(span, input, unit);
        tempi.append(row);
      }
    };
    fill();
    box.append(div);
  }
}

// ------------------------------------------------------------ other settings UI
function setStartBar(m) {
  settings.startBar = Math.max(1, Math.min(data.measures, Math.round(m) || 1));
  $("startBar").value = settings.startBar;
  save();
  const beat = ref.beatOfMeasure(settings.startBar);
  const eng = new Engine(ref, beat);
  $("startHint").textContent = eng.soloistActive(beat + 0.5)
    ? "You start here: press Play, then play. The orchestra comes in with you."
    : "The orchestra starts here when you press Play" + (settings.mode === "midi" ? " (or press the sustain pedal)." : ".");
}

function renderInputMode() {
  for (const b of $("inputMode").querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === settings.mode);
  $("echoRow").hidden = settings.mode !== "midi";
  $("aecRow").hidden = settings.mode !== "mic";
  let hint;
  if (settings.mode === "midi") {
    hint = hasMidi
      ? "Connect your digital piano by USB adapter or Bluetooth MIDI, then press Play."
      : "This browser can't receive MIDI (Safari on iPhone and iPad can't). Use the microphone, or open this page "
        + "in a browser app that supports MIDI, such as \u201cWeb MIDI Browser\u201d from the App Store.";
  } else {
    hint = "Put the phone near the piano. Use headphones if you can, so the app hears you and not the orchestra.";
  }
  $("inputHint").textContent = hint;
  setStartBar(settings.startBar);
}

function renderParts() {
  const box = $("parts");
  box.innerHTML = "";
  for (const p of data.parts) {
    const l = document.createElement("label");
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = !settings.muted.has(p.id);
    c.onchange = () => { if (c.checked) settings.muted.delete(p.id); else settings.muted.add(p.id); save(); };
    l.append(c, p.name);
    box.append(l);
  }
}

// ------------------------------------------------------------ inputs
function audioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (e) { /* not supported */ }
}

async function startMic() {
  if (mic) return;
  audioSession("play-and-record");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: settings.aec, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  await ctx.audioWorklet.addModule("js/mic-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "mic-tap", { numberOfInputs: 2 });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node, 0, 0);
  sampler.output.connect(node, 0, 1); // what goes to the speaker (to tell it from the player)
  node.connect(sink).connect(ctx.destination);
  node.port.onmessage = ({ data: { data: block, ref, t } }) => {
    let e = 0;
    for (let i = 0; i < block.length; i++) e += block[i] * block[i];
    const db = 10 * Math.log10(e / block.length + 1e-12);
    $("level").style.width = `${Math.max(0, Math.min(100, (db + 70) * 1.6))}%`;
    if (debug.record) debug.record.push([t, block]);
    if (front && engine) for (const o of front.process(block, t, ref)) onset(o);
  };
  mic = { stream, src, node };
}

function stopMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach(tr => tr.stop());
  mic.src.disconnect(); mic.node.disconnect();
  mic = null;
  $("level").style.width = "0";
  audioSession("playback");
}

async function startMidi() {
  if (midi || !hasMidi) return;
  midi = await navigator.requestMIDIAccess();
  const attach = () => {
    const names = [];
    for (const input of midi.inputs.values()) { input.onmidimessage = onMidi; names.push(input.name); }
    $("inputHint").textContent = names.length ? `Listening to: ${names.join(", ")}` : "No MIDI device found yet. Connect your piano.";
  };
  midi.onstatechange = attach;
  attach();
}

function onMidi(e) {
  const [st, d1, d2] = e.data;
  const t = ctx.currentTime + (e.timeStamp - performance.now()) / 1000;
  const kind = st & 0xf0;
  if (kind === 0x90 && d2 > 0) {
    noteOn(d1, d2, t);
    if (settings.echo && sampler.loaded) {
      sampler.release(echoVoices.get(d1), 0.1);
      echoVoices.set(d1, sampler.play("piano", d1, d2, ctx.currentTime, 30));
    }
  } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
    sampler.release(echoVoices.get(d1));
    echoVoices.delete(d1);
  } else if (kind === 0xb0 && d1 === 64 && d2 >= 64 && engine && !engine.started && orchestraFirst) {
    engine.start(ctx.currentTime);
  }
}

let heardTimer = null;
function flash() {
  const h = $("heard");
  h.classList.add("on");
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => h.classList.remove("on"), 120);
}

function noteOn(pitch, vel, t) {
  flash();
  if (!engine || settings.mode !== "midi") return;
  debug.heard.push([pitch, t]);
  if (orchestraFirst && !engine.started) return; // the orchestra plays first: wait for Play / the pedal
  engine.onNote(pitch, t);
}

// a microphone onset (AudioFrontEnd): o.sal(p) = share of the new sound at pitch p
function onset(o) {
  flash();
  if (!engine) return;
  debug.heard.push(o.t);
  if (orchestraFirst && !engine.started) return;
  engine.onAudio(o.sal, o.t);
}

// ------------------------------------------------------------ playing
const BOWED = ["violins1", "violins2", "violas", "celli", "basses"];
// which sample set plays a note: plucked or tremolo strings have their own
function soundFor(part, note) {
  if (BOWED.includes(part.set)) {
    if (note.pizz && sampler.sets[part.set + "_pizz"]) return part.set + "_pizz";
    if (note.tremolo >= 3) return "tremolo";
  }
  return part.set;
}

// how much louder or softer than written the orchestra plays here, from the
// recording (a gain per beat; tools/expression.py)
function phrasing(beat) {
  const g = data.gain;
  if (!g || !settings.phrasing) return 1;
  const i = Math.max(0, Math.min(g.length - 1, Math.floor(beat))), j = Math.min(g.length - 1, i + 1), f = beat - Math.floor(beat);
  return 10 ** (((1 - f) * g[i] + f * g[j]) / 20);
}

function latency() {
  return (ctx.outputLatency || ctx.baseLatency || 0) + settings.latencyMs / 1000;
}

function tick() {
  const now = ctx.currentTime;
  const lat = latency();
  const rate = Math.max(engine.clock.rate, 1e-3);
  for (const { note, time } of engine.tick(now, AHEAD + lat)) {
    if (settings.muted.has(note.part)) continue;
    const part = data.parts[note.partIdx];
    const set = soundFor(part, note);
    const vel = Math.max(20, Math.min(127, note.velocity + part.vel - 75));
    sampler.play(set, part.drum ?? note.pitch, vel, time - lat, note.dur / rate * 0.95, phrasing(note.beat));
    debug.played++;
  }
  if (!engine.started) return;
  const b = engine.clock.beat;
  $("bar").textContent = barOf(b);
  $("beat").textContent = (Math.floor((b % BAR) * 10) / 10 + 1).toFixed(1);
  $("tempo").textContent = Math.round(engine.clock.rate * 60);
  const f = engine.follower;
  if (engine.soloistActive(b) && f.lastTime !== null) status("Following you");
  else {
    const s = engine.sectionAt(b);
    status(s >= 0 ? `Orchestra alone · ${fmtBars(...engine.sections[s])}` : "Orchestra");
  }
  if (b >= data.measures * BAR) {
    endAt ??= now + 3;
    if (now > endAt) stop("The end. Bravo!");
  }
}

async function play() {
  await ctx.resume();
  if (settings.mode === "mic") {
    try { await startMic(); } catch (e) {
      status("The app needs the microphone to hear you. Allow it in Settings › Safari › Microphone.", true);
      return;
    }
  } else {
    stopMic();
    audioSession("playback");
    // MIDI permission and devices can come later: don't hold up the orchestra
    startMidi().catch(e => { $("inputHint").textContent = `Couldn't open MIDI: ${e.message}`; });
  }
  const score = new Score(data, effectiveTempoMap());
  const startBeat = score.beatOfMeasure(settings.startBar);
  engine = new Engine(score, startBeat, 1.0, settings.mode === "mic");
  engine.keepTempo = new Set(engine.sections.map(([a], i) => (sectionMode(a) === "keep" ? i : -1)).filter(i => i >= 0));
  front = settings.mode === "mic" ? new AudioFrontEnd(ctx.sampleRate) : null;
  orchestraFirst = !engine.soloistActive(startBeat + 0.5);
  endAt = null;
  if (orchestraFirst) engine.start(ctx.currentTime);
  status(orchestraFirst ? "Orchestra" : "Start playing. The orchestra comes in with you.");
  $("bar").textContent = settings.startBar; $("beat").textContent = "1.0";
  $("tempo").textContent = Math.round(score.nominalBpm(startBeat));
  $("play").hidden = true; $("stop").hidden = false;
  timer = setInterval(tick, TICK_MS);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (e) { /* not supported */ }
}

function stop(msg = "Stopped.") {
  clearInterval(timer);
  timer = null;
  engine = null; front = null;
  sampler.stopAll();
  for (const v of echoVoices.values()) sampler.release(v);
  echoVoices.clear();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $("play").hidden = false; $("stop").hidden = true;
  status(msg);
}

// ------------------------------------------------------------ start up
async function init() {
  data = await (await fetch("data/score.json")).json();
  ref = new Score(data);
  $("startBar").max = data.measures;
  renderSections();
  renderParts();
  renderInputMode();
  $("volume").value = settings.volume;
  $("latency").value = settings.latencyMs;
  $("latencyOut").textContent = `${settings.latencyMs} ms`;

  $("startBar").onchange = e => setStartBar(+e.target.value);
  for (const b of document.querySelectorAll(".stepper button")) b.onclick = () => setStartBar(settings.startBar + +b.dataset.step);
  for (const b of $("inputMode").querySelectorAll("button")) {
    b.onclick = () => { settings.mode = b.dataset.mode; save(); renderInputMode(); if (settings.mode !== "mic") stopMic(); };
  }
  $("phrasing").checked = settings.phrasing;
  $("phrasing").onchange = e => { settings.phrasing = e.target.checked; save(); };
  $("echo").checked = settings.echo;
  $("echo").onchange = e => { settings.echo = e.target.checked; save(); };
  $("aec").checked = settings.aec;
  $("aec").onchange = e => { settings.aec = e.target.checked; save(); stopMic(); };
  $("volume").oninput = e => { settings.volume = +e.target.value; sampler.setVolume(settings.volume); save(); };
  $("latency").oninput = e => {
    settings.latencyMs = +e.target.value; $("latencyOut").textContent = `${settings.latencyMs} ms`; save();
  };
  $("resetTempos").onclick = () => { settings.tempos = {}; settings.modes = {}; settings.speed = {}; save(); renderSections(); };
  $("play").onclick = play;
  $("stop").onclick = () => stop();
  document.addEventListener("visibilitychange", () => { if (document.hidden && timer) stop("Stopped (the app went to the background)."); });

  audioSession("playback");
  ctx = new AudioContext({ latencyHint: "interactive" });
  sampler = new Sampler(ctx);
  sampler.setVolume(settings.volume);
  await sampler.load("", p => status(`Loading the orchestra… ${Math.round(p * 100)}%`));
  $("play").disabled = false;
  status("Ready.");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
init().catch(e => { status(`Something went wrong loading the app: ${e.message}`, true); console.error(e); });
