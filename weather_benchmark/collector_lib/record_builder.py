"""Port of src/services/nowcastLogger.js _buildLogRecord.

Produces the exact JSONL schema (_schemaVersion: 2) that ingest.py expects.
Each record is a single snapshot from one city.
"""

import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any


def build_record(*, lat: float, lon: float, country: str, location_name: str,
                 state_code: Optional[str], station: Optional[str],
                 radar_state: Optional[Dict], motion: Optional[Dict],
                 obs: Optional[Dict], summary: Dict,
                 model_context: Optional[Dict],
                 model_hourly: Optional[list]) -> Dict:
    """Build a JSONL record matching the browser's schema."""

    nowcast_state = summary.get('nowcastState') or {}
    precip_ns = nowcast_state.get('precip') or {}
    sky_state = summary.get('skyState')
    precip_state_now = summary.get('precipStateNow')
    trend_60m = summary.get('precipTrend60m') or {}
    lightning_state = summary.get('lightningState')

    precip_active = precip_ns.get('active') is True
    displayed_condition = _desc_from_scored_precip(precip_ns) if precip_active else 'Dry'

    if precip_active:
        displayed_icon = precip_ns.get('icon')
    else:
        sky_icon = (nowcast_state.get('sky') or {}).get('icon')
        if sky_icon and re.search(r'rain|drizzle|thunder|snow|sleet', sky_icon):
            displayed_icon = None
        else:
            displayed_icon = sky_icon

    sky = ({
        'desc': sky_state.get('desc'),
        'source': sky_state.get('source'),
        'confidence': sky_state.get('confidence'),
    } if sky_state else {'desc': None, 'source': None, 'confidence': None})

    trend = {
        'summary': trend_60m.get('summary'),
        'summaryConfidence': trend_60m.get('summaryConfidence'),
        'beginInMin': trend_60m.get('beginInMin'),
        'endInMin': trend_60m.get('endInMin'),
        'timeline': trend_60m.get('timeline'),
        'method': trend_60m.get('method'),   # 'edge' | 'slope' | 'edge-horizon' | 'none'
        'edge': trend_60m.get('edge'),       # {distKm, speedKmh, lateralHits} | None
    }

    lightning = ({
        'state': lightning_state.get('state'),
        'nearestFlashMi': lightning_state.get('nearestFlashMi'),
        'flashCounts': lightning_state.get('flashCounts'),
        'trend': lightning_state.get('trend'),
        'confidence': lightning_state.get('confidence'),
        'source': lightning_state.get('source'),
        'connected': lightning_state.get('connected'),
        'bufferAgeMs': lightning_state.get('bufferAgeMs'),
    } if lightning_state else None)

    radar = ({
        'dbz': radar_state.get('dbz'),
        'rainState': radar_state.get('rainState'),
        'source': radar_state.get('source'),
        'lastValidDbzTime': radar_state.get('lastValidDbzTime'),
        'motionSpeed': motion.get('speed_kmh') if motion else None,
        'motionDir': motion.get('direction_deg') if motion else None,
        'motionSource': motion.get('source') if motion else None,  # radar | persisted | model-wind
    } if radar_state else None)

    precip = ({
        'phenomenon': precip_state_now.get('phenomenon'),
        'desc': precip_state_now.get('desc'),
        'source': precip_state_now.get('source'),
        'confidence': precip_state_now.get('confidence'),
    } if precip_state_now else None)

    record = {
        '_schemaVersion': 2,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'lat': lat,
        'lon': lon,
        'country': country,
        'stateCode': state_code,
        'station': station,
        'locationName': location_name,
        'displayedCondition': displayed_condition,
        'displayedIcon': displayed_icon,
        'precip': precip,
        'sky': sky,
        'lightning': lightning,
        'trend': trend,
        'radar': radar,
        'model': model_context,
        'modelHourly': model_hourly,
    }
    _validate_record(record)
    return record


def _desc_from_scored_precip(precip: Dict) -> str:
    if not precip or not precip.get('active'):
        return 'Dry'
    t, i = precip.get('type'), precip.get('intensity')
    if t == 'snow':
        return ('Heavy Snow' if i == 'heavy' else 'Light Snow' if i == 'light' else 'Snow')
    if t == 'rain':
        if i == 'heavy':
            return 'Heavy Rain'
        if i == 'light':
            return 'Light Rain'
        return 'Rain'
    return precip.get('type') or 'Precipitation'


def _validate_record(record: Dict) -> None:
    """Mirror of nowcastLogger.js _validateRecord — flags coherence issues."""
    flags = []
    icon, cond = record.get('displayedIcon'), record.get('displayedCondition')
    if icon and cond:
        icon_is_rain = re.search(r'rain|drizzle|thunder|snow|sleet', icon) is not None
        cond_is_dry = cond == 'Dry'
        icon_is_clear = re.search(r'clear|cloudy|overcast', icon) and not icon_is_rain
        cond_is_rain = re.search(r'drizzle|rain|thunder|snow|sleet', cond, re.IGNORECASE) is not None
        if icon_is_rain and cond_is_dry:
            flags.append('rain_icon_dry_cond')
        if icon_is_clear and cond_is_rain:
            flags.append('clear_icon_rain_cond')
    if record.get('model') is None:
        flags.append('model_unavailable')
    r = record.get('radar')
    if r:
        if r.get('dbz') is None and r.get('rainState') in ('ON', 'HOLDING'):
            flags.append('radar_state_no_dbz')
    if flags:
        record['_validationFlags'] = flags
