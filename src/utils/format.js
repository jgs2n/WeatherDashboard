function getWindDirection(degrees) {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(degrees / 22.5) % 16;
    return directions[index];
}

function renderWindCompass(degrees, speed, gusts, compact = false, showLabel = true) {
    const dirLabel = getWindDirection(degrees);
    const cx = 22, cy = 22, r = 19;

    // 16 tick marks
    let ticks = '';
    for (let i = 0; i < 16; i++) {
        const angle = i * 22.5;
        const isCardinal = i % 4 === 0;
        const rad = (angle - 90) * Math.PI / 180;
        const outerX = cx + r * Math.cos(rad);
        const outerY = cy + r * Math.sin(rad);
        const tickLen = isCardinal ? 6 : 3;
        const innerX = cx + (r - tickLen) * Math.cos(rad);
        const innerY = cy + (r - tickLen) * Math.sin(rad);
        const sw = isCardinal ? '1.5' : '0.8';
        ticks += `<line x1="${outerX.toFixed(2)}" y1="${outerY.toFixed(2)}" x2="${innerX.toFixed(2)}" y2="${innerY.toFixed(2)}" stroke="rgba(255,255,255,0.3)" stroke-width="${sw}"/>`;
    }

    // N/E/S/W labels
    const labelOffset = r - 11;
    const labels = [
        { text: 'N', dx: 0,           dy: -labelOffset },
        { text: 'E', dx: labelOffset,  dy: 0 },
        { text: 'S', dx: 0,           dy: labelOffset },
        { text: 'W', dx: -labelOffset, dy: 0 },
    ].map(l => `<text x="${(cx + l.dx).toFixed(1)}" y="${(cy + l.dy + 2).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="rgba(255,255,255,0.45)" font-size="5" font-family="inherit">${l.text}</text>`).join('');

    // Arrow pointing in the direction the wind is blowing (toward destination)
    const blowDir = (degrees + 180) % 360;
    const arrow = `<g transform="rotate(${blowDir}, ${cx}, ${cy})">
        <polygon points="${cx},3 ${cx-3.5},12 ${cx+3.5},12" fill="#00d4ff"/>
        <line x1="${cx}" y1="11" x2="${cx}" y2="33" stroke="#00d4ff" stroke-width="2" stroke-linecap="round"/>
    </g>`;

    const svg = `<svg class="wind-compass-svg" width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
        ${ticks}
        ${labels}
        ${arrow}
    </svg>`;

    if (compact) {
        const speedText = gusts ? `${speed} / ${gusts} mph` : `${speed} mph`;
        return `<div class="wind-compass-compact">
            <svg class="wind-compass-svg" width="38" height="38" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>
                ${ticks}
                ${labels}
                ${arrow}
            </svg>
            <span class="wind-from">From ${Math.round(degrees)}°</span>
            <span class="wind-speed">${speedText}</span>
        </div>`;
    }

    if (!showLabel) {
        return `<div class="wind-hero-row">
            <div class="wind-compass-svg-col">
                ${svg}
                <span class="wind-from">From ${Math.round(degrees)}°</span>
            </div>
            <div class="wind-compass-text">
                <span class="wind-speed">${speed} mph</span>
                <span class="wind-gusts">Gusts ${gusts} mph</span>
            </div>
        </div>`;
    }

    return `<div class="detail-item">
        <div class="detail-label">Wind</div>
        <div class="wind-compass-body">
            ${svg}
            <div class="wind-compass-text">
                <span class="wind-from">From ${Math.round(degrees)}°</span>
                <span class="wind-speed">${speed} mph</span>
                <span class="wind-gusts">Gusts ${gusts} mph</span>
            </div>
        </div>
    </div>`;
}

function renderPrecipSpark(rp) {
    const series = rp.series || [];
    const n = series.length;
    if (n === 0) return '';

    // Summary badges
    const rainStr = (rp.rainTotal > 0) ? `${rp.rainTotal.toFixed(2)}"` : '—';
    const lagMinutes = rp.lagMinutes || 0;
    const lagStr = lagMinutes < 60 ? `${lagMinutes} min ago` : `${Math.floor(lagMinutes / 60)}h ago`;
    const missingStr = rp.missingHours > 0 ? ` · ⚠ ${rp.missingHours}h missing` : '';
    let badgeClass = 'est', badgeText = 'EST';
    if (rp.method === 'meteostat_hourly' && !rp.qualityFlags.includes('stale') && !rp.qualityFlags.includes('very_stale')) {
        badgeClass = 'live'; badgeText = 'LIVE';
    }
    if (lagMinutes > 360 || rp.qualityFlags.includes('very_stale')) {
        badgeClass = 'stale'; badgeText = 'STALE';
    }

    // SVG layout
    const W = 500, H = 77, PL = 6, PR = 6, PT = 6, PB = 20;
    const chartW = W - PL - PR, chartH = H - PT - PB;
    const baseline = PT + chartH;

    let yMax = 0.05;
    series.forEach(pt => {
        if (pt.present) yMax = Math.max(yMax, (pt.rainIn || 0) + (pt.snowIn || 0));
    });

    const pts = series.map((pt, i) => {
        const x = n > 1 ? PL + (i / (n - 1)) * chartW : PL + chartW / 2;
        const rain = pt.present ? (pt.rainIn || 0) : 0;
        const snow = pt.present ? (pt.snowIn || 0) : 0;
        return { x, yRain: baseline - (rain / yMax) * chartH, ySnow: baseline - ((rain + snow) / yMax) * chartH };
    });

    // Rain area path
    let rainD = `M ${pts[0].x.toFixed(1)},${baseline}`;
    pts.forEach(p => { rainD += ` L ${p.x.toFixed(1)},${p.yRain.toFixed(1)}`; });
    rainD += ` L ${pts[n - 1].x.toFixed(1)},${baseline} Z`;

    // Snow stacked area path
    let snowD = '';
    if (rp.snowTotal > 0) {
        snowD = `M ${pts[0].x.toFixed(1)},${pts[0].yRain.toFixed(1)}`;
        pts.forEach(p => { snowD += ` L ${p.x.toFixed(1)},${p.ySnow.toFixed(1)}`; });
        for (let i = n - 1; i >= 0; i--) snowD += ` L ${pts[i].x.toFixed(1)},${pts[i].yRain.toFixed(1)}`;
        snowD += ' Z';
    }

    // X-axis labels every ~windowHours/6 steps
    const step = Math.max(1, Math.round(n / 6));
    let xLabels = '';
    series.forEach((pt, i) => {
        if (i % step === 0 || i === n - 1) {
            const label = new Date(pt.time).toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' ', '').toLowerCase();
            xLabels += `<text x="${pts[i].x.toFixed(1)}" y="${H - 3}" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="9" font-family="inherit">${label}</text>`;
        }
    });

    const svg = `<svg class="precip-spark-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <line x1="${PL}" y1="${baseline}" x2="${W - PR}" y2="${baseline}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
        <path d="${rainD}" fill="rgba(0,212,255,0.22)" stroke="#00d4ff" stroke-width="1.5" stroke-linejoin="round"/>
        ${snowD ? `<path d="${snowD}" fill="rgba(168,218,255,0.4)" stroke="#a8daff" stroke-width="1" stroke-linejoin="round"/>` : ''}
        ${xLabels}
    </svg>`;

    return `<div class="precip-spark-tile" onclick="openPrecipChart(cachedRecentPrecip)" title="View recent precipitation history">
        <div class="precip-spark-header">Recent Precip</div>
        <div class="precip-spark-summary">
            <span class="precip-rain">🌧 ${rainStr}</span>
            ${rp.snowTotal > 0 ? `<span class="precip-snow">🌨 ${rp.snowTotal.toFixed(2)}"</span>` : ''}
            <span class="precip-window-badge">${rp.windowHours}H</span>
            <span class="precip-method-badge ${badgeClass}">${badgeText}</span>
            <span class="precip-spark-lag">· ${lagStr}${missingStr}</span>
        </div>
        ${svg}
    </div>`;
}

function formatSunTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ===== PRESSURE TREND (3hr change from hourly data) =====
function getPressureTrend(hourlyData) {
    if (!hourlyData || !hourlyData.pressure_msl || !hourlyData.time) {
        return { arrow: '', change: 0, color: 'var(--text-secondary)', label: '' };
    }

    const now = new Date();
    let currentIdx = -1;
    for (let i = 0; i < hourlyData.time.length; i++) {
        if (new Date(hourlyData.time[i]) >= now) {
            currentIdx = i;
            break;
        }
    }
    if (currentIdx < 3) {
        return { arrow: '', change: 0, color: 'var(--text-secondary)', label: '' };
    }

    const currentP = hourlyData.pressure_msl[currentIdx];
    const pastP = hourlyData.pressure_msl[currentIdx - 3];
    if (currentP == null || pastP == null) {
        return { arrow: '', change: 0, color: 'var(--text-secondary)', label: '' };
    }

    const change = Math.round((currentP - pastP) * 10) / 10;
    const abs = Math.abs(change);

    let arrow, color;
    if (abs < 0.5) {
        arrow = '→'; color = 'var(--text-secondary)';
    } else if (change > 0) {
        arrow = abs >= 3 ? '⬆' : abs >= 1.5 ? '↑' : '↗';
        color = 'var(--accent-primary)';
    } else {
        arrow = abs >= 3 ? '⬇' : abs >= 1.5 ? '↓' : '↘';
        color = 'var(--accent-warm)';
    }

    const sign = change > 0 ? '+' : '';
    return { arrow, change, color, label: `${sign}${change}` };
}
