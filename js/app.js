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
  muted: new Set(store.get("muted", [])),
  tempos: store.get("tempos", {}),     // "sectionStart@rowBeat" -> bpm
  keep: new Set(store.get("keep", [])), // sections that keep the soloist's tempo (by start beat)
};
const save = () => {
  store.set("startBar", settings.startBar); store.set("mode", settings.mode); store.set("echo", settings.echo); store.set("aec", settings.aec);
  store.set("volume", settings.volume); store.set("latencyMs", settings.latencyMs);
  store.set("muted", [...settings.muted]); store.set("tempos", settings.tempos); store.set("keep", [...settings.keep]);
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
// Each orchestra-only section lists the score's tempos in it (the one in force
// where it starts, and any changes inside); the player can change each.
function sectionRows(a, b) {
  const rows = [[a, ref.nominalBpm(a)]];
  for (const [beat, bpm] of data.tempo) if (beat > a && beat < b) rows.push([beat, bpm]);
  return rows;
}

function effectiveTempoMap() {
  const sections = ref.orchestraSections();
  const points = new Set(data.tempo.map(r => r[0]));
  for (const [a, b] of sections) { points.add(a); points.add(b); }
  const at = beat => {
    for (const [a, b] of sections) {
      if (a <= beat && beat < b) {
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

function renderSections() {
  const box = $("sections");
  box.innerHTML = "";
  for (const [a, b] of ref.orchestraSections()) {
    const div = document.createElement("div");
    div.className = "section" + (settings.keep.has(a) ? " keep" : "");
    const head = document.createElement("div");
    head.className = "head";
    head.innerHTML = `<b>${fmtBars(a, b)}</b>`;
    if (a > 0) { // the opening has no tempo of yours to keep
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="own">Tempo below</option><option value="keep">Keep my last tempo</option>`;
      sel.value = settings.keep.has(a) ? "keep" : "own";
      sel.onchange = () => {
        if (sel.value === "keep") settings.keep.add(a); else settings.keep.delete(a);
        div.classList.toggle("keep", sel.value === "keep");
        save();
      };
      head.append(sel);
    }
    const go = document.createElement("button");
    go.className = "small";
    go.textContent = "Start here";
    go.style.marginTop = "0";
    go.onclick = () => { setStartBar(barOf(a)); window.scrollTo({ top: 0, behavior: "smooth" }); };
    head.append(go);
    div.append(head);
    const tempi = document.createElement("div");
    tempi.className = "tempi";
    for (const [rb, base] of sectionRows(a, b)) {
      const key = `${a}@${rb}`;
      const row = document.createElement("label");
      row.className = "tempo";
      const span = document.createElement("span");
      span.textContent = rb === a ? (a === 0 ? "From the start" : `From bar ${barOf(a)}`) : `From bar ${barOf(rb)}`;
      const input = document.createElement("input");
      input.type = "number"; input.inputMode = "numeric"; input.min = 20; input.max = 260;
      input.value = settings.tempos[key] ?? base;
      const mark = () => input.classList.toggle("changed", +input.value !== base);
      mark();
      input.onchange = () => {
        const v = Math.round(+input.value);
        if (!(v >= 20 && v <= 260)) { input.value = settings.tempos[key] ?? base; return; }
        if (v === base) delete settings.tempos[key]; else settings.tempos[key] = v;
        mark(); save();
      };
      const unit = document.createElement("small");
      unit.textContent = `score ${base}`;
      unit.style.color = "var(--dim)";
      row.append(span, input, unit);
      tempi.append(row);
    }
    div.append(tempi);
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
    const set = part.set === "strings" && note.tremolo >= 3 ? "tremolo" : part.set;
    const vel = Math.max(20, Math.min(127, note.velocity + part.vel - 75));
    sampler.play(set, part.drum ?? note.pitch, vel, time - lat, note.dur / rate * 0.95);
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
  engine.keepTempo = new Set(engine.sections.map(([a], i) => (settings.keep.has(a) ? i : -1)).filter(i => i >= 0));
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
  $("echo").checked = settings.echo;
  $("echo").onchange = e => { settings.echo = e.target.checked; save(); };
  $("aec").checked = settings.aec;
  $("aec").onchange = e => { settings.aec = e.target.checked; save(); stopMic(); };
  $("volume").oninput = e => { settings.volume = +e.target.value; sampler.setVolume(settings.volume); save(); };
  $("latency").oninput = e => {
    settings.latencyMs = +e.target.value; $("latencyOut").textContent = `${settings.latencyMs} ms`; save();
  };
  $("resetTempos").onclick = () => { settings.tempos = {}; settings.keep.clear(); save(); renderSections(); };
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
