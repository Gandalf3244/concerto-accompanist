// Offline support: keep every file of the app in a cache. Bump VERSION
// whenever any file changes, so phones fetch the new version.
const VERSION = "b559d49201";
const FILES = [
  "./", "index.html", "style.css", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png",
  "js/app.js", "js/score.js", "js/follower.js", "js/engine.js", "js/micfront.js", "js/sampler.js",
  "js/mic-worklet.js", "js/audiofollower.js", "data/score.json", "samples/index.json",
  "samples/flute.mp3", "samples/oboe.mp3", "samples/clarinet.mp3", "samples/bassoon.mp3", "samples/trumpet.mp3",
  "samples/horn.mp3", "samples/trombone.mp3", "samples/timpani.mp3", "samples/strings.mp3",
  "samples/tremolo.mp3", "samples/piano.mp3", "samples/drums.mp3",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
