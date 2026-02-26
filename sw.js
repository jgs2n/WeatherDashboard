const CACHE_NAME = 'weather-hq-v1.1.2';
const PRECACHE_URLS = [
    './',
    'css/styles.css',
    'src/state/store.js',
    'src/utils/weatherCodes.js',
    'src/utils/risk.js',
    'src/utils/dom.js',
    'src/utils/moon.js',
    'src/utils/format.js',
    'src/services/geocode.js',
    'src/services/openMeteo.js',
    'src/services/nws.js',
    'src/services/recentPrecip.js',
    'src/ui/locationPicker.js',
    'src/ui/pressureChart.js',
    'src/ui/precipChart.js',
    'src/ui/forecastModal.js',
    'src/ui/hourly.js',
    'src/ui/share.js',
    'src/ui/renderDashboard.js',
    'src/ui/tabDrag.js',
    'src/main.js',
    'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Bebas+Neue&display=swap'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.all(PRECACHE_URLS.map(url =>
                fetch(url, { cache: 'no-cache' }).then(r => cache.put(url, r)).catch(() => {})
            ))
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    // Network-first for API calls, cache-first for assets
    if (event.request.url.includes('api.') || event.request.url.includes('weather.gov')) {
        event.respondWith(
            fetch(event.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => caches.match(event.request))
        );
    } else {
        event.respondWith(
            caches.match(event.request).then(cached => cached || fetch(event.request))
        );
    }
});
