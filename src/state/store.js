// Weather HQ — global state store
// All variables declared here are implicit globals (classic script, no ES modules).
// Loaded first in index.html so all other scripts can read/write these freely.
// loadSavedLocations() is called from init() to preserve startup timing.

// App version
const APP_VERSION = '0.7.0';

// Location state
let savedLocations = [];
let activeLocation = null;
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
let lastRefreshTime = null;
let locationTemps = {}; // keyed by location name
let nwsShowByDefault = null;

// Forecast modal state
let forecastDays = []; // raw data for forecast detail modal
let forecastDetailIndex = 0;

// Hourly strip state
let cachedHourlyData = null;
let activeHourlyIndex = null;
let cachedCurrentData = null;  // current conditions snapshot for NOW pill
let cachedNowIndex = null;     // hourly index that maps to "now"

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

// Station observation state (for condition detail modal)
let cachedStationObs = null;

// Tooltip state
let activeTooltip = null;

// Section order (mobile layout customization)
const SECTION_ORDER_KEY = 'sectionOrder';
const DEFAULT_SECTION_ORDER = ['forecast', 'hourly', 'satellite'];
let sectionOrder = [...DEFAULT_SECTION_ORDER];

// Nowcast state
let cachedNowSummary = null;
let _nowcastPollTimer = null;
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
    // Load section order
    loadSectionOrder();

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
