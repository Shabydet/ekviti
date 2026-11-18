/* Service worker: приложение целиком лежит в кэше и открывается без сети.
   Версия ниже должна совпадать с APP_VERSION в app.js (проверяет tools/make_release.py).
   Меняешь файлы приложения — поднимай VERSION, иначе телефон останется на старой копии. */
const VERSION = '1.1.0';
const CACHE = 'ekviti-' + VERSION;

/* Всё, что нужно для полного офлайна. index.html — точка входа для навигации. */
const CORE = [
  './',
  'index.html',
  'styles.css',
  'engine.js',
  'drills.js',
  'ui.js',
  'app.js',
  'trainer.js',
  'manifest.webmanifest',
  'assets/icons/favicon-32.png',
  'assets/icons/icon-180.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/splash/splash-1179x2556.png',
  'assets/splash/splash-2556x1179.png',
];

const abs = (p) => new URL(p, self.location.href).toString();
const INDEX = abs('index.html');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // каждый файл отдельно: одна недоступная картинка не должна сломать установку
    await Promise.all(CORE.map((path) =>
      cache.add(new Request(abs(path), { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Страница спрашивает версию, чтобы показать её в настройках. */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: VERSION, cache: CACHE });
  }
});

/* Навигация: адрес приложения отдаётся из кэша сразу (мгновенный старт, работает
   без сети), незнакомый адрес сначала спрашиваем у сети, а если её нет —
   подсовываем приложение. Новая версия приходит через обновление service worker. */
async function serveDocument(req) {
  const cache = await caches.open(CACHE);
  // 1. этот адрес уже лежит в кэше — отдаём без сети
  const exact = await cache.match(req, { ignoreSearch: true });
  if (exact) return exact;
  // 2. неизвестный адрес — пробуем сеть и кладём в кэш
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) { /* сети нет — ниже отдадим приложение */ }
  // 3. офлайн: любая навигация ведёт в приложение
  const hit = await cache.match(INDEX);
  if (hit) return hit;
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Эквити</title>' +
    '<body style="margin:0;background:#0b0e14;color:#e8eaf0;font:16px system-ui;' +
    'display:grid;place-items:center;height:100vh;text-align:center">' +
    '<div><p style="font-size:20px;margin:0 0 8px">Приложение ещё не сохранено</p>' +
    '<p style="color:#8b93a7;margin:0">Открой его один раз при интернете — дальше работает без сети.</p></div>',
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

async function serveAsset(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;   // чужие адреса не трогаем

  if (req.mode === 'navigate') event.respondWith(serveDocument(req));
  else event.respondWith(serveAsset(req));
});
