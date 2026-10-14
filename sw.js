// Offline support: keep every file of the app in a cache. Bump VERSION
// whenever any file changes, so phones fetch the new version.
const VERSION = "3285c8dd02";
const FILES = [
  "./", "index.html", "style.css", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
  "js/app.js", "js/score.js", "js/follower.js", "js/engine.js", "js/micfront.js", "js/sampler.js",
  "js/mic-worklet.js", "js/audiofollower.js", "js/voice.js", "data/score.json", "samples/index.json",
  "samples/flute.mp3", "samples/oboe.mp3", "samples/clarinet.mp3", "samples/bassoon.mp3", "samples/trumpet.mp3",
  "samples/horn.mp3", "samples/trombone.mp3", "samples/timpani.mp3",
  "samples/tremolo.mp3", "samples/piano.mp3", "samples/drums.mp3", "samples/violins1.mp3",
  "samples/violins2.mp3", "samples/violas.mp3", "samples/celli.mp3", "samples/basses.mp3",
  "samples/violins1_pizz.mp3", "samples/violins2_pizz.mp3", "samples/violas_pizz.mp3", "samples/celli_pizz.mp3",
  "samples/basses_pizz.mp3",
];

self.addEventListener("install", e => {
  // fresh copies (not the browser's HTTP cache), all from this version
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// The page, code and data: the network first (so an update is never half
// applied), this version's copy when offline. The sounds: this version's copy.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.pathname.endsWith(".mp3")) {
    e.respondWith(caches.open(VERSION).then(c => c.match(e.request, { ignoreSearch: true })
      .then(hit => hit || fetch(e.request))));
    return;
  }
  e.respondWith(fetch(e.request, { cache: "no-cache" })
    .then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return r;
    })
    .catch(() => caches.open(VERSION).then(c => c.match(e.request, { ignoreSearch: true }))));
});
