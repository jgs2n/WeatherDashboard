const CACHE_NAME = 'weather-hq-v1.31.0';
const PRECACHE_URLS = [
    './',
    'css/styles.css',
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
    'src/state/store.js',
    'src/utils/weatherCodes.js',
    'src/utils/risk.js',
    'src/utils/dailyIcon.js',
    'src/utils/dom.js',
    'src/utils/moon.js',
    'src/utils/metarParse.js',
    'src/utils/format.js',
    'src/services/geocode.js',
    'src/services/openMeteo.js',
    'src/services/nws.js',
    'src/services/spc.js',
    'src/services/recentPrecip.js',
    'src/services/observations.js',
    'src/services/radarSampler.js',
    'src/services/lightning.js',
    'src/services/nowcast.js',
    'src/services/geolocation.js',
    'src/ui/locationPicker.js',
    'src/ui/pressureChart.js',
    'src/ui/aqiChart.js?v=1.0.5',
    'src/ui/precipChart.js',
    'src/ui/forecastModal.js',
    'src/ui/hourly.js',
    'src/ui/share.js',
    'src/ui/renderDashboard.js?v=1.10.0',
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
