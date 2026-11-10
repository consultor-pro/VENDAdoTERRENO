/* Service worker — cache do app para funcionar offline e permitir instalação */
const CACHE = 'venda-terreno-v9';
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

/* ---------- Avisos de vencimento (notificações) ----------
   Sem servidor: o Android acorda o app ~1x por dia (Periodic Background Sync, app instalado)
   e o app também confere toda vez que é aberto. */
function abrirBanco() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('rt_comprovantes', 2);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('f')) db.createObjectStore('f', { keyPath: 'id' }); if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function kv(db, modo, fn) {
  return new Promise((res, rej) => { const t = db.transaction('kv', modo); let out; const q = fn(t.objectStore('kv')); if (q) q.onsuccess = () => out = q.result; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); });
}
const brlSW = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
async function verificarVencimentos() {
  if (!self.Notification || Notification.permission !== 'granted') return 0;
  const db = await abrirBanco();
  const dados = await kv(db, 'readonly', s => s.get('dados')); if (!dados || !dados.itens) return 0;
  const avisados = (await kv(db, 'readonly', s => s.get('avisados'))) || {};
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  let n = 0;
  for (const it of dados.itens) {
    if (it.pago || !(it.tipo === 'mensal' || it.tipo === 'balao')) continue;
    const [y, m, d] = it.venc.split('-').map(Number);
    const dias = Math.round((new Date(y, m - 1, d) - hoje) / 86400000);
    let chave = null, titulo = '';
    if (dias === 3 || dias === 1) { chave = 'antes' + dias; titulo = `${it.rotulo} vence em ${dias} dia${dias > 1 ? 's' : ''}`; }
    else if (dias === 0) { chave = 'hoje'; titulo = `Hoje vence a ${it.rotulo}`; }
    else if (dias < 0 && dias >= -120) { chave = 'atraso' + Math.floor((-dias - 1) / 7); titulo = `⚠️ ${it.rotulo} atrasada há ${-dias} dia${dias < -1 ? 's' : ''}`; }
    if (!chave || avisados[it.id + ':' + chave]) continue;
    await self.registration.showNotification(titulo, {
      body: `Valor ${brlSW(it.valor)} · vencimento ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`,
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'venc-' + it.id, renotify: true, data: { id: it.id }
    });
    avisados[it.id + ':' + chave] = Date.now(); n++;
  }
  await kv(db, 'readwrite', s => s.put(avisados, 'avisados'));
  return n;
}
self.addEventListener('periodicsync', e => { if (e.tag === 'vencimentos') e.waitUntil(verificarVencimentos()); });
self.addEventListener('message', e => { if (e.data === 'verificar-vencimentos') e.waitUntil(verificarVencimentos()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL('index.html', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
    return clients.openWindow(alvo);
  }));
});
