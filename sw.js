/* Service worker — cache do app para funcionar offline e permitir instalação */
const CACHE = 'venda-terreno-v7';
const ARQUIVOS = [
  './', './index.html', './styles.css', './app.js', './manifest.json',
  './icons/logo.png', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icon-180.png', './icon-192.png', './icon-512.png'
];
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'venda-terreno-recebido').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Rede primeiro (pega atualizações), cache como reserva quando estiver offline
// Recebe o arquivo de backup compartilhado pelo WhatsApp (Compartilhar › Venda Terreno)
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'POST' || !u.pathname.endsWith('/receber-backup')) return;
  e.respondWith((async () => {
    try {
      const fd = await e.request.formData();
      const f = fd.get('backup') || [...fd.values()].find(v => typeof v === 'object');
      if (f) await (await caches.open('venda-terreno-recebido')).put(new URL('__backup-recebido', self.registration.scope).href, new Response(f));
    } catch (err) { }
    return Response.redirect(new URL('index.html#backup-recebido', self.registration.scope).href, 303);
  })());
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || !e.request.url.startsWith(self.location.origin)) return;
  const navegacao = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request, navegacao ? { cache: 'no-store' } : {}).then(r => {
      if (r && r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
