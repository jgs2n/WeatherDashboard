const CACHE_NAME = 'weather-hq-v1.52.0';
// NOTE: entries with ?v= must match index.html exactly — the fetch handler
// matches full URLs including the query string, so a stale ?v here means the
// file silently misses the cache offline.
const PRECACHE_URLS = [
    './',
    'css/styles.css?v=1.21.0',
    'icons/meteocons/clear-day.svg',
    'icons/meteocons/clear-night.svg',
    'icons/meteocons/partly-cloudy-day.svg',
    'icons/meteocons/partly-cloudy-night.svg',
    'icons/meteocons/overcast-day.svg',
    'icons/meteocons/overcast-night.svg',
    'icons/meteocons/fog-day.svg',
    'icons/meteocons/fog-night.svg',
    'icons/meteocons/drizzle.svg',
    'icons/meteocons/rain.svg',
    'icons/meteocons/snow.svg',
    'icons/meteocons/sleet.svg',
    'icons/meteocons/thunderstorms-rain.svg',
    'icons/meteocons/thunderstorms-day-rain.svg',
    'icons/meteocons/thunderstorms-night-rain.svg',
    'icons/meteocons/hail.svg',
    'icons/meteocons/mist.svg',
    'icons/meteocons/not-available.svg',
    'pwa/manifest.json',
    'pwa/icon.svg',
    'src/state/store.js?v=1.17.0',
    'src/utils/weatherCodes.js?v=1.0.0',
    'src/utils/risk.js?v=1.2.7',
    'src/utils/dailyIcon.js?v=1.1.0',
    'src/utils/dom.js?v=0.6.1',
    'src/utils/moon.js?v=1.0.0',
    'src/utils/metarParse.js?v=1.0.0',
    'src/utils/format.js?v=0.10.0',
    'src/utils/chartHelpers.js?v=1.0.0',
    'src/utils/geo.js?v=1.0.0',
    'src/services/geocode.js?v=1.9.3',
    'src/services/openMeteo.js?v=1.2.0',
    'src/services/modelComparison.js?v=1.0.0',
    'src/services/nws.js?v=1.0.0',
    'src/services/spc.js?v=1.0.0',
    'src/services/recentPrecip.js?v=1.8.1',
    'src/services/climatology.js?v=1.0.0',
    'src/services/observations.js?v=1.8.1',
    'src/services/radarSampler.js?v=1.3.0',
    'lib/jsfive.esm.js',
    'src/services/lightning.js?v=1.1.0',
    'src/services/nowcast.js?v=1.3.0',
    'src/services/nowcastDisplay.js?v=1.0.0',
    'src/services/geolocation.js?v=1.0.0',
    'src/ui/locationPicker.js?v=1.9.3',
    'src/ui/pressureChart.js?v=1.0.0',
    'src/ui/aqiChart.js?v=1.0.5',
    'src/ui/precipChart.js?v=1.0.0',
    'src/ui/climatologyChart.js?v=1.0.0',
    'src/ui/forecastModal.js?v=1.1.0',
    'src/ui/hourly.js?v=1.0.0',
    'src/ui/share.js?v=1.0.0',
    'src/ui/renderDashboard.js?v=1.15.0',
    'src/ui/tabDrag.js?v=1.1.7',
    'src/main.js?v=1.16.0',
    'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Bebas+Neue&display=swap'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            Promise.all(PRECACHE_URLS.map(url =>
                fetch(url, { cache: 'no-cache' }).then(r => cache.put(url, r)).catch(() => console.warn('[SW] precache skip:', url))
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
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => caches.match(event.request))
        );
    } else {
        event.respondWith(
            caches.match(event.request).then(cached => cached || fetch(event.request))
        );
    }
});
