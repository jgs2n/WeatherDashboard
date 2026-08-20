// Weather HQ — global state store
// All variables declared here are implicit globals (classic script, no ES modules).
// Loaded first in index.html so all other scripts can read/write these freely.
// loadSavedLocations() is called from init() to preserve startup timing.

// App version
const APP_VERSION = '0.9.4';

const CHANGELOG = [
    {
        version: '0.9.4',
        date: '2026-08-20',
        features: [
            {
                title: 'Precip vs Normal: 30-Year Baseline',
                desc: 'The "expected" precipitation baseline extended from a 10-year to a 30-year average — the same convention NOAA climate normals use — roughly halving the sampling noise in the comparison. A validation audit against the Asheville airport rain gauge confirmed the departure percentages are the trustworthy part of this tile: the ERA5 grid data runs about a third below valley gauge readings in mountainous terrain (a stable bias that cancels out of the percentages, but means absolute inch values read low vs a local gauge).'
            }
        ]
    },
    {
        version: '0.9.3',
        date: '2026-07-23',
        features: [
            {
                title: 'Rain Timing Tuned from Live Data',
                desc: 'Four days of measurement drove three refinements: the steering-wind fallback now uses a calibrated 75% speed factor (raw 700 mb wind overestimates storm motion); small radar cells can now produce measured motion vectors (the accurate kind — 11-minute error vs 22 for estimated motion); and the second-opinion consensus source switched to Open-Meteo 15-minute precipitation data after RainViewer discontinued free forecast frames. Agreement between radar edge-tracking and the model now upgrades prediction confidence.'
            }
        ]
    },
    {
        version: '0.9.2',
        date: '2026-07-19',
        features: [
            {
                title: 'Lightning Ingest Hardened',
                desc: 'A reliability audit found GLM lightning ingest could silently starve for hours: when the satellite data feed publishes files with more than 3 minutes of latency, every file was rejected as "too old" and the app kept showing no lightning while appearing connected. The age window is now 10 minutes with a newest-file fallback, so high-latency periods degrade to slightly delayed data instead of none.'
            },
            {
                title: 'Smarter Rain Wording',
                desc: 'Start predictions now say what kind of rain is coming — "Heavy rain starting ~3:45 PM" vs "Light rain likely in ~20–30 min" — using the radar intensity measured at the incoming edge (only when actually observed; projections never claim intensity). A compact dot meter under the Storms Nearby label shows prediction confidence at a glance: ●●● high, ●●○ medium, ●○○ low.'
            },
            {
                title: 'Honest "Data Unavailable" Indicator',
                desc: 'When lightning data goes stale during heavy rain or storm conditions, the storm lane now says "⚠ Lightning data unavailable" instead of silently showing nothing. Absence of a warning should never be mistaken for absence of lightning — if you can hear thunder, you are in range.'
            }
        ]
    },
    {
        version: '0.9.1',
        date: '2026-07-19',
        features: [
            {
                title: 'Honest "Rain Continuing" Wording',
                desc: 'Fixed a bias found in three days of benchmark data: when rain persisted, the fallback predictor kept saying "tapering off in ~50–60 min" and rolling the number forward every poll — technically consistent, never true. Projections that stay wet through the whole hour now say "Rain continuing this hour", and consistency alone can no longer promote a fallback prediction to high confidence.'
            },
            {
                title: 'Storm Motion Fallback',
                desc: 'The motion vector was only measurable from radar in about 12% of rainy polls (scattered summer cells defeat frame correlation), starving the accurate edge-based timing method. Now a good vector persists for 15 minutes, and when radar correlation fails entirely, the 700 mb steering wind from the forecast model fills in — capped at medium confidence since it is an estimate, not an observation.'
            },
            {
                title: 'RainViewer Nowcast Actually Works Now',
                desc: 'The RainViewer consensus signal never fired in three days: its "universal blue" tiles use colors our radar palette matcher rejects (a test tile had 994 rain pixels, zero matched). Switched to RainViewer\'s raw data encoding (color scheme 0), which stores exact dBZ values in each pixel — no color matching at all.'
            }
        ]
    },
    {
        version: '0.9.0',
        date: '2026-07-16',
        features: [
            {
                title: 'Precip vs Normal — 1/3/6/12-Month Totals',
                desc: 'New tile in the current conditions card compares actual precipitation over the last 1, 3, 6, and 12 months against the 10-year average for the same windows (ERA5 reanalysis via Open-Meteo, worldwide, no API key). Color-coded departure shows wetter (blue) or drier (amber) than normal at a glance; tap for a grouped bar chart with exact totals. Results are cached per location, so the tile is instant on repeat visits.'
            },
            {
                title: 'Rain Start/End Times as Clock Times',
                desc: 'The nowcast now predicts when rain will start and stop using edge geometry — it finds the leading or trailing edge of the echo along the storm track and divides by closing speed, instead of extrapolating reflectivity trends at a point. High-confidence predictions show clock times rounded to 5 minutes ("Rain starting ~3:45 PM", "Clearing by ~4:20 PM"); medium confidence shows ranges; low confidence stays deliberately vague.'
            },
            {
                title: 'Motion Vector Fixed and Upgraded',
                desc: 'Fixed a direction-convention bug that pointed upstream storm sampling 90° off track — the main reason arrival estimates rarely fired. The correlation search also widened (9×9 grid, ±4 cells with sub-cell refinement), so fast-moving squall lines up to ~107 km/h now resolve instead of saturating at ~53 km/h.'
            },
            {
                title: 'Self-Correcting Predictions + RainViewer Consensus',
                desc: 'Each poll compares the new start/end estimate against the previous one: converging predictions earn a confidence boost, diverging ones decay. RainViewer’s own nowcast frames (already in the data we fetch) act as an independent cross-check — agreement raises confidence, and they fill in when no motion vector is available, including internationally.'
            },
            {
                title: 'Faster Radar Sampling',
                desc: 'Decoded radar tiles are now cached per poll cycle, collapsing ~75 redundant image decodes per motion estimate into about 3 tile fetches. Lower data use and faster nowcast updates, especially on phones.'
            },
            {
                title: 'Offline Cache Fix',
                desc: 'The service worker precache list had drifted out of sync with the app’s versioned file URLs, silently dropping several files from offline storage. The list is now generated to match exactly, restoring full offline coverage.'
            }
        ]
    },
    {
        version: '0.8.1',
        date: '2026-05-09',
        features: [
            {
                title: 'Lightning Rebuilt on NOAA GOES GLM',
                desc: 'Replaced the Blitzortung WebSocket with direct NOAA GOES GLM (Geostationary Lightning Mapper) polling. Reads GLM L2 LCFA NetCDF files straight from the noaa-goes19/noaa-goes18 S3 buckets and parses them in-browser using a vendored 176 KB pure-JS HDF5 reader (jsfive, lazy-loaded on first poll). No proxy, no API key, no runtime CDN dependency. Auto-selects GOES-East or GOES-West by longitude.'
            },
            {
                title: 'Honest Lightning Bands',
                desc: 'GLM is a storm-scale flash detector at ~10 km resolution, not a precise strike locator. Distance bands were widened accordingly: active ≤ 10 mi (10 min), nearby ≤ 20 mi (15 min), approaching ≤ 40 mi (20 min). The rolling buffer is 20 minutes. Dry-background "thunder nearby" now requires at least two close flashes to suppress single-pixel noise. Coverage is the Americas only (~52N–52S); outside coverage falls back to METAR thunder detection in the US.'
            },
            {
                title: 'Synthesized Nowcast State',
                desc: 'New unified nowcast state cleanly answers three questions independently — is it precipitating, what is the sky doing, and is there thunder. Radar leads precip, METAR can override for drizzle/fog cases radar misses, and the model only gap-fills when no observation is available. Sky state uses hysteresis to stop the condition label from flipping on borderline readings, and per-source confidence scores drive the merge.'
            },
            {
                title: 'Nowcast Snapshot Logger',
                desc: 'Every nowcast cycle now emits a structured snapshot (radar, METAR, lightning, model context, derived state) to an optional local logger endpoint. Silently no-ops when the logger or server is unavailable. Powers the new weather_benchmark backtesting tooling without affecting the live dashboard.'
            },
            {
                title: 'Smarter Polling Cadence',
                desc: 'Lightning polling now adapts to conditions: 60 s during active storms, 2 min when unsettled, 5 min when quiet. File fetches are capped by age and size so polls stay light even when many GLM files land at once.'
            },
            {
                title: 'Recent Precip Tile De-duplication',
                desc: 'Fixed a rendering bug where the recent-precipitation sparkline tile could be appended multiple times on rapid refresh, leaving duplicate tiles in the weather details strip.'
            },
            {
                title: 'Meteocons Vendored for Offline Use',
                desc: 'All Meteocons SVG icons (clear, partly cloudy, overcast, fog, drizzle, rain, snow, sleet, thunderstorms, hail, mist) are now precached by the service worker and bundled into the deploy script, so the dashboard renders correctly offline and on first load even on slow networks.'
            },
            {
                title: 'About Page Refresh',
                desc: 'The Nowcast section in the About page was rewritten for clarity — explains the four-source fusion (radar, station observations, GLM lightning, model gap-fill) and the role of hysteresis and adaptive polling without drowning the reader in thresholds.'
            }
        ]
    },
    {
        version: '0.8.0',
        date: '2026-03-15',
        features: [
            {
                title: 'Hazard Lane Alert System',
                desc: 'Three-lane hazard panel replacing simple alert banners. Red lane for NWS alerts with severity tiers (advisory through critical with flashing animation). Yellow lane for SPC convective outlooks. Blue lane for near-term storm status from nowcast and lightning.'
            },
            {
                title: '"My Location" GPS Tracking',
                desc: 'Continuous GPS watch with 1 km movement threshold and auto-refresh. Toggle via the crosshair button in the header. Pauses when the tab is hidden to save battery.'
            },
            {
                title: 'SVG Weather Icons',
                desc: 'Full migration from emoji to Meteocons SVG icons with day/night variants. Improved sleet and rain/snow mix detection using hourly codes and daily accumulation totals.'
            },
            {
                title: 'SPC Convective Outlook',
                desc: 'Storm Prediction Center Day 1 categorical outlook integration. Point-in-polygon matching shows your local severe weather risk level (Marginal through High).'
            },
            {
                title: 'Faster Loading',
                desc: 'Tiered data loading renders the main dashboard in under a second while supplementary data fills in progressively. All secondary API calls run in parallel. Radar maps lazy-load after initial paint. Nowcast polling adapts to conditions. SVG icons use native lazy loading.'
            },
            {
                title: 'Section Visibility & Order',
                desc: 'Show or hide dashboard sections from Settings. Default order changed to hourly-first for quicker at-a-glance reads.'
            },
            {
                title: 'Night Forecast Icons',
                desc: 'The 7-day forecast now shows a night icon alongside the day icon when overnight conditions differ meaningfully — storms, rain, snow, or fog that the daytime icon alone wouldn\'t convey. Matching conditions are deduplicated to keep the display clean.'
            },
            {
                title: 'Icon Rationale',
                desc: 'Tap the current conditions icon to see why it was chosen — shows the data source, confidence level, and any lightning promotion logic.'
            }
        ]
    }
];

// Location state
let savedLocations = [];
let activeLocation = null;
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
let lastRefreshTime = null;
let locationTemps = {}; // keyed by location name: { temp, code, is_day }
let nwsShowByDefault = null;

// Geo "Me" mode state
let geoMeActive = false;
let lastGeoPosition = null;       // { lat, lon, name, displayName, country }
let _previousActiveLocation = null;

// Forecast modal state
let forecastDays = []; // raw data for forecast detail modal
let forecastDetailIndex = 0;

// Hourly strip state
let cachedHourlyData = null;
let activeHourlyIndex = null;
let cachedCurrentData = null;  // current conditions snapshot for NOW pill
let cachedNowIndex = null;     // hourly index that maps to "now"
let cachedUtcOffsetSec = null; // active location's UTC offset (Open-Meteo utc_offset_seconds)

// Radar / timeline state
let activeRadarView = 'radar';
let showForecastTimeline = false;

// Alert state
let cachedAlerts = { active: [], upcoming: [] };

// AQI state (current AQI for display in forecast modal)
let cachedAQI = null;
let cachedAQIHourly = null;

// Recent precipitation state
let cachedRecentPrecip = null;

// Climatology (precip vs normal) state
let cachedClimatology = null;

// Station observation state (for condition detail modal)
let cachedStationObs = null;

// Tooltip state
let activeTooltip = null;

// Section order (mobile layout customization)
const SECTION_ORDER_KEY = 'sectionOrder';
const DEFAULT_SECTION_ORDER = ['hourly', 'forecast', 'satellite'];
let sectionOrder = [...DEFAULT_SECTION_ORDER];

// Section visibility (show/hide individual sections)
const SECTION_VISIBILITY_KEY = 'sectionVisibility';
const DEFAULT_SECTION_VISIBILITY = { hourly: true, forecast: true, satellite: true };
let sectionVisibility = { ...DEFAULT_SECTION_VISIBILITY };

// Nowcast state
let cachedNowSummary = null;
let _nowcastPollTimer = null;
let _nowcastPollGen = 0;  // generation counter — increments on start/stop to invalidate stale polls
const NOWCAST_STORAGE_KEY = 'nowcastState';

// Adaptive polling intervals (ms)
const POLL_DRY_MS     = 5 * 60 * 1000;  // 5 min — dry, no nearby echoes
const POLL_ACTIVE_MS  = 2 * 60 * 1000;  // 2 min — raining or rain imminent
const POLL_DEFAULT_MS = 3 * 60 * 1000;  // 3 min — fallback

// Load saved locations from localStorage
function loadSavedLocations() {
    const stored = localStorage.getItem('weatherLocations');
    if (stored) {
        savedLocations = JSON.parse(stored);
    } else {
        // Start with empty locations for new users
        savedLocations = [];
    }
    // Load section order + visibility
    loadSectionOrder();
    loadSectionVisibility();
    const storedNWS = localStorage.getItem('nwsShowByDefault');
    nwsShowByDefault = storedNWS !== null ? storedNWS === 'true' : null;

    const activeLocationName = localStorage.getItem('activeLocation');
    if (activeLocationName) {
        activeLocation = savedLocations.find(loc => loc.name === activeLocationName) || savedLocations[0];
    } else if (savedLocations.length > 0) {
        activeLocation = savedLocations[0];
    } else {
        activeLocation = null;
    }

    // Load Geo "Me" mode state
    geoMeActive = localStorage.getItem('geoMeActive') === 'true';
    const storedGeoPos = localStorage.getItem('lastGeoPosition');
    if (storedGeoPos) {
        try { lastGeoPosition = JSON.parse(storedGeoPos); } catch (e) { lastGeoPosition = null; }
    }
}

// Save Geo "Me" state to localStorage
function saveGeoMeState() {
    localStorage.setItem('geoMeActive', geoMeActive ? 'true' : 'false');
    if (lastGeoPosition) {
        localStorage.setItem('lastGeoPosition', JSON.stringify(lastGeoPosition));
    }
}

// Save locations to localStorage
function saveLocations() {
    localStorage.setItem('weatherLocations', JSON.stringify(savedLocations));
    if (activeLocation) {
        localStorage.setItem('activeLocation', activeLocation.name);
    }
}

// Load cached nowcast state from localStorage (called from init)
function loadNowcastState() {
    try {
        const stored = localStorage.getItem(NOWCAST_STORAGE_KEY);
        if (!stored || !activeLocation) return;
        const parsed = JSON.parse(stored);
        const locKey = `${activeLocation.lat.toFixed(2)}_${activeLocation.lon.toFixed(2)}`;
        if (parsed._locationKey !== locKey) return;
        const ageMs = Date.now() - new Date(parsed._savedAt).getTime();
        if (ageMs > 10 * 60 * 1000) return; // discard if > 10 min old
        cachedNowSummary = parsed.summary;
        cachedNowSummary._isStored = true;
        cachedNowSummary._storedAgeMin = Math.floor(ageMs / 60000);
    } catch (e) {
        console.warn('[Nowcast] Failed to load stored state:', e.message);
    }
}

// Load section order from localStorage
function loadSectionOrder() {
    try {
        const stored = localStorage.getItem(SECTION_ORDER_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length === 3) {
                sectionOrder = parsed;
            }
        }
    } catch (e) {
        console.warn('[Settings] Failed to load section order:', e.message);
    }
}

// Save section order to localStorage
function saveSectionOrder(order) {
    sectionOrder = order;
    localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
}

// Load section visibility from localStorage
function loadSectionVisibility() {
    try {
        const stored = localStorage.getItem(SECTION_VISIBILITY_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (parsed && typeof parsed === 'object') {
                sectionVisibility = { ...DEFAULT_SECTION_VISIBILITY, ...parsed };
            }
        }
    } catch (e) {
        console.warn('[Settings] Failed to load section visibility:', e.message);
    }
}

// Save section visibility to localStorage
function saveSectionVisibility(vis) {
    sectionVisibility = vis;
    localStorage.setItem(SECTION_VISIBILITY_KEY, JSON.stringify(vis));
}

// Save nowcast state to localStorage
function saveNowcastState(summary, lat, lon) {
    try {
        localStorage.setItem(NOWCAST_STORAGE_KEY, JSON.stringify({
            summary,
            _locationKey: `${lat.toFixed(2)}_${lon.toFixed(2)}`,
            _savedAt: new Date().toISOString()
        }));
    } catch (e) {
        console.warn('[Nowcast] Failed to save state:', e.message);
    }
}
