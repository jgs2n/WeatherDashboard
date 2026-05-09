// SPC service — US-only Day 1 Categorical Convective Outlook
// Returns highest risk category for a lat/lon, or null on error / non-US / no risk

const SPC_CATEGORIES = {
    'MRGL': { label: 'Marginal Risk',  rank: 2 },
    'SLGT': { label: 'Slight Risk',    rank: 3 },
    'ENH':  { label: 'Enhanced Risk',  rank: 4 },
    'MDT':  { label: 'Moderate Risk',  rank: 5 },
    'HIGH': { label: 'High Risk',      rank: 6 }
};

let _spcCache   = { data: null, ts: null };
let _spcPending = null;
const SPC_CACHE_TTL = 30 * 60 * 1000;

// Ray-casting point-in-polygon
function _pointInPolygon(point, ring) {
    const [x, y] = point;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function _findHighestCategory(geojson, lat, lon) {
    const point = [lon, lat]; // GeoJSON uses [lon, lat]
    let highest = null;

    for (const feature of geojson.features) {
        const label = (feature.properties.LABEL || '').trim();
        const catInfo = SPC_CATEGORIES[label];
        if (!catInfo) continue; // skip TSTM and unknowns

        const geom = feature.geometry;
        let rings = [];
        if (geom.type === 'Polygon') {
            rings = [geom.coordinates[0]];
        } else if (geom.type === 'MultiPolygon') {
            rings = geom.coordinates.map(p => p[0]);
        }

        for (const ring of rings) {
            if (_pointInPolygon(point, ring)) {
                if (!highest || catInfo.rank > highest.rank) {
                    highest = { category: label, ...catInfo, valid: feature.properties.VALID, expire: feature.properties.EXPIRE };
                }
                break;
            }
        }
    }
    return highest;
}

async function fetchSPCOutlook(lat, lon) {
    if (_spcCache.data && _spcCache.ts && (Date.now() - _spcCache.ts < SPC_CACHE_TTL)) {
        return _findHighestCategory(_spcCache.data, lat, lon);
    }
    if (_spcPending) {
        const geojson = await _spcPending;
        return geojson ? _findHighestCategory(geojson, lat, lon) : null;
    }

    _spcPending = (async () => {
        try {
            const resp = await fetch('https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson');
            if (!resp.ok) { console.warn(`[SPC] HTTP ${resp.status}`); return null; }
            const geojson = await resp.json();
            _spcCache = { data: geojson, ts: Date.now() };
            return geojson;
        } catch (err) {
            console.warn('[SPC] fetch failed:', err.message);
            return null;
        }
    })().finally(() => { _spcPending = null; });

    const geojson = await _spcPending;
    return geojson ? _findHighestCategory(geojson, lat, lon) : null;
}
