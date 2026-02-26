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

// Recent precipitation state
let cachedRecentPrecip = null;

// Tooltip state
let activeTooltip = null;

// Load saved locations from localStorage
function loadSavedLocations() {
    const stored = localStorage.getItem('weatherLocations');
    if (stored) {
        savedLocations = JSON.parse(stored);
    } else {
        // Start with empty locations for new users
        savedLocations = [];
    }
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
