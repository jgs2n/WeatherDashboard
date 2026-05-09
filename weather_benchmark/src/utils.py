"""
Shared constants and helpers for the Weather HQ benchmark tool.

Ports key tables from the Weather HQ app:
  - WMO weather code → condition category  (from src/utils/weatherCodes.js)
  - METAR wx-code parsing                  (from src/utils/metarParse.js)
"""

import re
import math
import numpy as np

# ── WMO weather-code → condition category ────────────────────────────────────
# Exact mirror of WEATHER_CODES in src/utils/weatherCodes.js lines 3-32.
# 11 categories that collapse the full WMO range into scorable groups.

WMO_CATEGORY_MAP = {
    0:  'clear',            # Clear sky
    1:  'clear',            # Mainly clear
    2:  'partly_cloudy',    # Partly cloudy
    3:  'overcast',         # Overcast
    45: 'fog',              # Foggy
    48: 'fog',              # Rime fog
    51: 'drizzle',          # Light drizzle
    53: 'drizzle',          # Moderate drizzle
    55: 'drizzle',          # Dense drizzle
    56: 'freezing_precip',  # Light freezing drizzle
    57: 'freezing_precip',  # Heavy freezing drizzle
    61: 'rain',             # Slight rain
    63: 'rain',             # Moderate rain
    65: 'heavy_rain',       # Heavy rain
    66: 'freezing_precip',  # Light freezing rain
    67: 'freezing_precip',  # Heavy freezing rain
    71: 'snow',             # Slight snow
    73: 'snow',             # Moderate snow
    75: 'heavy_snow',       # Heavy snow
    77: 'heavy_snow',       # Snow grains
    80: 'rain',             # Slight rain showers
    81: 'rain',             # Moderate rain showers
    82: 'heavy_rain',       # Violent rain showers
    85: 'snow',             # Slight snow showers
    86: 'heavy_snow',       # Heavy snow showers
    95: 'thunderstorm',     # Thunderstorm
    96: 'thunderstorm',     # Thunderstorm with hail
    99: 'thunderstorm',     # Thunderstorm with heavy hail
}

# Human-readable labels for reports
WMO_CATEGORY_LABELS = {
    'clear':           'Clear',
    'partly_cloudy':   'Partly Cloudy',
    'overcast':        'Overcast',
    'fog':             'Fog',
    'drizzle':         'Drizzle',
    'rain':            'Rain',
    'heavy_rain':      'Heavy Rain',
    'freezing_precip': 'Freezing Precip',
    'snow':            'Snow',
    'heavy_snow':      'Heavy Snow',
    'thunderstorm':    'Thunderstorm',
}

# All known categories (for iteration / confusion matrices)
ALL_CATEGORIES = list(WMO_CATEGORY_LABELS.keys())

# ── Condition similarity matrix ──────────────────────────────────────────────
# Partial credit for "close enough" condition matches.
# Keyed by frozenset of two categories → score (0-1).
# Exact match always = 1.0.  Unlisted pairs = 0.0.

CONDITION_SIMILARITY = {
    frozenset({'clear', 'partly_cloudy'}):      0.5,
    frozenset({'partly_cloudy', 'overcast'}):    0.3,
    frozenset({'rain', 'drizzle'}):              0.5,
    frozenset({'rain', 'heavy_rain'}):           0.5,
    frozenset({'drizzle', 'freezing_precip'}):   0.3,
    frozenset({'snow', 'heavy_snow'}):           0.5,
    frozenset({'thunderstorm', 'heavy_rain'}):   0.25,
    frozenset({'rain', 'freezing_precip'}):      0.3,
}


def condition_match_score(cat_a: str, cat_b: str) -> float:
    """Return 1.0 for exact match, partial credit from similarity matrix, else 0."""
    if cat_a == cat_b:
        return 1.0
    return CONDITION_SIMILARITY.get(frozenset({cat_a, cat_b}), 0.0)


# ── METAR wxcodes parsing ────────────────────────────────────────────────────
# Ported from src/utils/metarParse.js _METAR_PATTERNS (lines 9-38) and
# detectThunder (line 143).

METAR_THUNDER_RX = re.compile(r'\bTS\b|TSRA|TSSN|TSGS', re.IGNORECASE)

# Ordered pattern list — first match wins (mirrors JS _METAR_PATTERNS order).
_METAR_WX_PATTERNS = [
    # Thunderstorm
    (re.compile(r'\+TS',              re.I), 'thunderstorm'),
    (re.compile(r'TSRA|TSSN|TSGS',   re.I), 'thunderstorm'),
    (re.compile(r'\bTS\b',           re.I), 'thunderstorm'),
    # Freezing precip
    (re.compile(r'FZRA',             re.I), 'freezing_precip'),
    (re.compile(r'FZDZ',             re.I), 'freezing_precip'),
    # Snow
    (re.compile(r'\+SN',             re.I), 'heavy_snow'),
    (re.compile(r'\bSN\b',          re.I), 'snow'),
    (re.compile(r'-SN',              re.I), 'snow'),
    (re.compile(r'SG|IC|PE|PL|GS',   re.I), 'freezing_precip'),
    # Rain
    (re.compile(r'\+RA',             re.I), 'heavy_rain'),
    (re.compile(r'\bRA\b',          re.I), 'rain'),
    (re.compile(r'-RA',              re.I), 'drizzle'),
    # Drizzle
    (re.compile(r'\bDZ\b|\+DZ|-DZ',  re.I), 'drizzle'),
    # Showers
    (re.compile(r'\+SH',             re.I), 'heavy_rain'),
    (re.compile(r'SHRA',             re.I), 'rain'),
    (re.compile(r'\bSH\b|-SH',      re.I), 'drizzle'),
    # Fog / visibility
    (re.compile(r'FG',               re.I), 'fog'),
    (re.compile(r'BR',               re.I), 'fog'),
    (re.compile(r'HZ',               re.I), 'fog'),
]

# Sky-cover code → category (used when wxcodes is empty)
_SKY_COVER_MAP = {
    'CLR': 'clear', 'SKC': 'clear', 'FEW': 'partly_cloudy',
    'SCT': 'partly_cloudy', 'BKN': 'overcast', 'OVC': 'overcast',
    'VV':  'fog',
}


def wmo_to_category(code) -> str:
    """Map a WMO weather code to a condition category string."""
    if code is None:
        return 'clear'
    try:
        code = int(code)
    except (ValueError, TypeError):
        return 'clear'
    return WMO_CATEGORY_MAP.get(code, 'clear')


def metar_wx_to_category(wxcodes: str, sky_cover: str = None) -> str:
    """
    Map IEM ASOS wxcodes string to a condition category.
    Falls back to sky_cover if no weather is reported.
    """
    if wxcodes and wxcodes.strip():
        for rx, cat in _METAR_WX_PATTERNS:
            if rx.search(wxcodes):
                return cat
    # No significant weather — use sky cover
    if sky_cover:
        cover = sky_cover.strip().upper()
        return _SKY_COVER_MAP.get(cover, 'partly_cloudy')
    return 'clear'


def has_thunder(wxcodes: str) -> bool:
    """Return True if wxcodes string contains a thunderstorm indicator."""
    if not wxcodes:
        return False
    return bool(METAR_THUNDER_RX.search(wxcodes))


# ── Unit conversions ─────────────────────────────────────────────────────────

def parse_metar_temp(metar: str):
    """
    Extract temperature and dewpoint (°C) from a METAR string.
    Prefers the precise T-group in remarks (e.g. T01700010).
    Falls back to the standard temp/dew group (e.g. 17/01, 06/M08).
    Returns (temp_c, dewpoint_c) — either can be None.
    """
    if not metar or not isinstance(metar, str):
        return None, None

    # Try precise T-group first: Tssttttssdddd where s=sign(0=+,1=-), tttt/dddd = tenths °C
    t_match = re.search(r'\bT(\d)(\d{3})(\d)(\d{3})\b', metar)
    if t_match:
        t_sign = -1 if t_match.group(1) == '1' else 1
        temp_c = t_sign * int(t_match.group(2)) / 10.0
        d_sign = -1 if t_match.group(3) == '1' else 1
        dew_c = d_sign * int(t_match.group(4)) / 10.0
        return temp_c, dew_c

    # Fallback: standard temp/dew group (e.g. 17/01, M03/M08)
    td_match = re.search(r'\b(M?\d{2})/(M?\d{2})\b', metar)
    if td_match:
        def _parse_td(s):
            if s.startswith('M'):
                return -int(s[1:])
            return int(s)
        return _parse_td(td_match.group(1)), _parse_td(td_match.group(2))

    return None, None


def knots_to_mph(knots: float) -> float:
    """Convert wind speed from knots to mph."""
    if knots is None or math.isnan(knots):
        return float('nan')
    return knots * 1.15078


def celsius_to_fahrenheit(c: float) -> float:
    """Convert temperature from Celsius to Fahrenheit."""
    if c is None or math.isnan(c):
        return float('nan')
    return c * 9.0 / 5.0 + 32.0


# ── Time classifiers ─────────────────────────────────────────────────────────

def classify_time_of_day(hour: int) -> str:
    """Classify UTC hour into time-of-day bucket."""
    if 0 <= hour < 6:
        return 'night'
    elif 6 <= hour < 12:
        return 'morning'
    elif 12 <= hour < 18:
        return 'afternoon'
    else:
        return 'evening'


def classify_season(month: int) -> str:
    """Classify month into meteorological season."""
    if month in (12, 1, 2):
        return 'winter'
    elif month in (3, 4, 5):
        return 'spring'
    elif month in (6, 7, 8):
        return 'summer'
    else:
        return 'fall'


# ── Safe aggregators ─────────────────────────────────────────────────────────

def safe_mean(values) -> float:
    """NaN-safe mean that returns NaN for empty input."""
    arr = np.array(values, dtype=float)
    arr = arr[~np.isnan(arr)]
    if len(arr) == 0:
        return float('nan')
    return float(np.mean(arr))


def safe_mae(forecast, observed) -> float:
    """NaN-safe Mean Absolute Error."""
    f = np.array(forecast, dtype=float)
    o = np.array(observed, dtype=float)
    mask = ~(np.isnan(f) | np.isnan(o))
    if mask.sum() == 0:
        return float('nan')
    return float(np.mean(np.abs(f[mask] - o[mask])))


def safe_bias(forecast, observed) -> float:
    """NaN-safe mean bias (forecast - observed). Positive = forecast too high."""
    f = np.array(forecast, dtype=float)
    o = np.array(observed, dtype=float)
    mask = ~(np.isnan(f) | np.isnan(o))
    if mask.sum() == 0:
        return float('nan')
    return float(np.mean(f[mask] - o[mask]))


def safe_rmse(forecast, observed) -> float:
    """NaN-safe Root Mean Squared Error."""
    f = np.array(forecast, dtype=float)
    o = np.array(observed, dtype=float)
    mask = ~(np.isnan(f) | np.isnan(o))
    if mask.sum() == 0:
        return float('nan')
    return float(np.sqrt(np.mean((f[mask] - o[mask]) ** 2)))


def format_metric(value, fmt: str = '.1f', na: str = 'N/A') -> str:
    """Format a metric for display, handling NaN/None."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return na
    return f'{value:{fmt}}'


def format_pct(value, na: str = 'N/A') -> str:
    """Format a 0-1 fraction as a percentage string."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return na
    return f'{value * 100:.0f}%'
