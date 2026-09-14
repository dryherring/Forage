const CACHE='forage-v1';
const ASSETS=['./','./index.html','./manifest.webmanifest','./forage-icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>e.respondWith(fetch(e.request).then(r=>{
  const copy=r.clone(); caches.open(CACHE).then(c=>c.put(e.request,copy)); return r;
}).catch(()=>caches.match(e.request))));
