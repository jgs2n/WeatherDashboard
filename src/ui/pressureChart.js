// Pressure chart modal — SVG pressure history/forecast overlay
// Opens when user taps the Pressure field in the current conditions card.
// Globals read: cachedHourlyData, lastRefreshTime
// Globals read (utils): getPressureTrend (from format.js)

let _pcRange = '3d';
let _pcData  = null;

function openPressureChart(hourlyData) {
    _pcData  = hourlyData;
    _pcRange = '3d';
    _pcRender();
    document.getElementById('pressureChartOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closePressureChart() {
    document.getElementById('pressureChartOverlay').classList.remove('visible');
    document.body.style.overflow = '';
}

function setPressureRange(range) {
    _pcRange = range;
    _pcRender();
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function _pcRender() {
    if (!_pcData) return;
    const now   = new Date();
    const stats = _pcStats(_pcData, now);
    const delta = _pcDeltas(_pcData, now);
    const { times, pressures } = _pcSlice(_pcData, _pcRange, now);
    const tSign = stats.trend.change >= 0 ? '+' : '';

    let updatedStr = '';
    if (lastRefreshTime) {
        const mins = Math.round((now - lastRefreshTime) / 60000);
        updatedStr = mins <= 1 ? 'just now' : `${mins} min ago`;
    }

    const rangeBtns = ['24h', '3d', '7d'].map(r =>
        `<button class="pc-rb ${_pcRange === r ? 'active' : ''}" onclick="setPressureRange('${r}')">${r}</button>`
    ).join('');

    const trendHTML = stats.trend.arrow
        ? `<span class="pc-trend" style="color:${stats.trend.color}">${stats.trend.arrow} ${tSign}${stats.trend.label} <span class="pc-note">(3h)</span></span>`
        : '';

    const d6HTML  = delta.d6  !== null
        ? `<span class="pc-delta">Δ 6h: <strong>${delta.d6  >= 0 ? '+' : ''}${delta.d6} hPa</strong></span>`  : '';
    const d12HTML = delta.d12 !== null
        ? `<span class="pc-delta">Δ 12h: <strong>${delta.d12 >= 0 ? '+' : ''}${delta.d12} hPa</strong></span>` : '';

    document.getElementById('pressureChartBody').innerHTML = `
        <div class="pc-header">
            <div>
                <div class="pc-label">PRESSURE</div>
                <div class="pc-meta-row">
                    <span class="pc-val">${stats.current}<span class="pc-unit"> hPa</span></span>
                    ${trendHTML}
                    <span class="pc-hl">High ${stats.high}</span>
                    <span class="pc-hl">Low ${stats.low}</span>
                    <span class="pc-dot">•</span>
                    <span class="pc-sealevel">Sea-level</span>
                </div>
            </div>
            <button class="pc-close" onclick="closePressureChart()">✕</button>
        </div>

        <div class="pc-range-bar">
            <span class="pc-range-label">Range:</span>
            ${rangeBtns}
            ${updatedStr ? `<span class="pc-updated-str">Updated: ${updatedStr}</span>` : ''}
        </div>

        <div class="pc-svg-wrap">
            ${_pcSVG(times, pressures, _pcRange, now)}
        </div>

        <div class="pc-footer">
            ${d6HTML}
            ${d12HTML}
            <span class="pc-delta">Trend: <strong style="color:${stats.trend.color}">${delta.trendLabel}</strong></span>
        </div>
    `;
}

// ─── SVG chart builder ────────────────────────────────────────────────────────

function _pcSVG(times, pressures, range, now) {
    if (!times.length) {
        return '<div class="pc-empty">No pressure data available for this range</div>';
    }

    const W = 520, H = 210;
    const padL = 50, padR = 74, padT = 16, padB = 38;
    const cW = W - padL - padR;
    const cH = H - padT - padB;

    const rawMin = Math.min(...pressures);
    const rawMax = Math.max(...pressures);
    const vpad   = Math.max(4, (rawMax - rawMin) * 0.3);
    const yMin   = Math.floor((rawMin - vpad) / 2) * 2;
    const yMax   = Math.ceil((rawMax  + vpad) / 2) * 2;

    const t0 = times[0].getTime();
    const t1 = times[times.length - 1].getTime();
    const tD = t1 - t0 || 1;

    const xOf = t => padL + ((t.getTime() - t0) / tD) * cW;
    const yOf = p => padT + (1 - (p - yMin) / (yMax - yMin)) * cH;

    // Split data at "now" into past and future segments
    let ni = times.findIndex(t => t >= now);
    if (ni < 0) ni = times.length;
    const allPts  = times.map((t, i) => `${xOf(t).toFixed(1)},${yOf(pressures[i]).toFixed(1)}`);
    const pastPts = allPts.slice(0, ni + 1);
    const futPts  = allPts.slice(Math.max(0, ni));

    const pastLineD = pastPts.length >= 2 ? 'M ' + pastPts.join(' L ') : '';
    const futLineD  = futPts.length >= 2  ? 'M ' + futPts.join(' L ')  : '';

    const bY    = (padT + cH).toFixed(1);
    const areaD = `M ${xOf(times[0]).toFixed(1)},${bY} L ${allPts.join(' L ')} `
                + `L ${xOf(times[times.length - 1]).toFixed(1)},${bY} Z`;

    // Y-axis grid + labels
    const ystep  = _pcNiceStep(yMax - yMin, 5);
    const yStart = Math.ceil(yMin / ystep) * ystep;
    let yLines = '';
    for (let p = yStart; p <= yMax; p += ystep) {
        const y = yOf(p).toFixed(1);
        yLines +=
            `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" `
          + `stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`
          + `<text x="${(padL - 6).toFixed(1)}" y="${y}" text-anchor="end" dominant-baseline="middle" `
          + `fill="rgba(255,255,255,0.45)" font-size="10" font-family="JetBrains Mono, monospace">${p}</text>`;
    }

    const baseline = `<line x1="${padL}" y1="${bY}" x2="${W - padR}" y2="${bY}" `
                   + `stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;

    const xLabels = _pcXLabels(times, range, now, xOf, padT, cH, padL, W, padR);

    // "Now" marker — vertical dashed line + dot + stacked label above chart
    const nx   = xOf(now).toFixed(1);
    const nowI = ni < times.length ? ni : times.length - 1;
    const nowP = Math.round(pressures[nowI]);
    const ny   = yOf(pressures[nowI]).toFixed(1);
    const nowMark =
        `<line x1="${nx}" y1="${padT}" x2="${nx}" y2="${bY}" `
      + `stroke="rgba(0,212,255,0.22)" stroke-width="1" stroke-dasharray="3,3"/>`
      + `<circle cx="${nx}" cy="${ny}" r="4.5" fill="#00d4ff" stroke="#0d1117" stroke-width="2"/>`
      + `<text x="${nx}" y="${(parseFloat(ny) - 22).toFixed(1)}" text-anchor="middle" `
      + `fill="rgba(255,255,255,0.55)" font-size="9" font-family="JetBrains Mono, monospace">Now</text>`
      + `<text x="${nx}" y="${(parseFloat(ny) - 10).toFixed(1)}" text-anchor="middle" `
      + `fill="rgba(0,212,255,0.85)" font-size="10" font-weight="bold" font-family="JetBrains Mono, monospace">${nowP}</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:auto;display:block;" preserveAspectRatio="xMidYMid meet">
    <defs>
        <linearGradient id="pcAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#00d4ff" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="#00d4ff" stop-opacity="0.01"/>
        </linearGradient>
    </defs>
    ${yLines}
    ${baseline}
    <path d="${areaD}" fill="url(#pcAreaGrad)"/>
    ${pastLineD ? `<path d="${pastLineD}" fill="none" stroke="rgba(255,255,255,0.88)"
          stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${futLineD ? `<path d="${futLineD}" fill="none" stroke="rgba(255,255,255,0.50)"
          stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
    ${nowMark}
    ${xLabels}
</svg>`;
}

function _pcXLabels(times, range, now, xOf, padT, cH, padL, W, padR) {
    const out  = [];
    const lY   = (padT + cH + 22).toFixed(1);
    const tY1  = padT + cH;
    const tY2  = padT + cH + 5;

    const tick = (x, label, vertLine) => {
        const xs = x.toFixed(1);
        const v  = vertLine
            ? `<line x1="${xs}" y1="${padT}" x2="${xs}" y2="${tY1}" `
            + `stroke="rgba(255,255,255,0.05)" stroke-width="1" stroke-dasharray="4,4"/>`
            : '';
        return v
            + `<line x1="${xs}" y1="${tY1}" x2="${xs}" y2="${tY2}" `
            + `stroke="rgba(255,255,255,0.25)" stroke-width="1"/>`
            + `<text x="${xs}" y="${lY}" text-anchor="middle" `
            + `fill="rgba(255,255,255,0.45)" font-size="10" font-family="JetBrains Mono, monospace">${label}</text>`;
    };

    if (range === '24h') {
        // ±24h: relative hour labels
        const step = 12;
        for (let h = -24; h <= 24; h += step) {
            if (h === 0) continue; // Now marker handles center
            const t = new Date(now.getTime() + h * 3600000);
            const x = xOf(t);
            if (x < padL - 16 || x > W - padR + 1) continue;
            out.push(tick(x, `${h > 0 ? '+' : ''}${h}h`, false));
        }
    } else {
        // 3d / 7d — day separators + day labels on both sides of Now
        const maxDays = range === '3d' ? 3 : 7;
        for (let d = -maxDays; d <= maxDays; d++) {
            if (range === '7d' && d !== 0 && Math.abs(d) % 2 !== 0) continue;
            const t = new Date(now);
            t.setDate(t.getDate() + d);
            t.setHours(0, 0, 0, 0);
            const x = xOf(t);
            if (x < padL - 1 || x > W - padR + 1) continue;
            const label = d === 0 ? 'Today' : t.toLocaleDateString('en-US', { weekday: 'short' });
            out.push(tick(x, label, true));
        }
    }
    return out.join('');
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function _pcSlice(hourly, range, now) {
    const h = range === '24h' ? 24 : range === '3d' ? 72 : 168;
    const s = new Date(now.getTime() - h * 3600000);
    const e = new Date(now.getTime() + h * 3600000);
    const times = [], pressures = [];
    for (let i = 0; i < hourly.time.length; i++) {
        const t = new Date(hourly.time[i]);
        if (t >= s && t <= e && hourly.pressure_msl[i] != null) {
            times.push(t);
            pressures.push(hourly.pressure_msl[i]);
        }
    }
    return { times, pressures };
}

function _pcStats(hourly, now) {
    // Current: first hourly slot at or after now
    let ci = hourly.time.findIndex(t => new Date(t) >= now);
    if (ci < 0) ci = hourly.time.length - 1;
    const current = ci >= 0 ? Math.round(hourly.pressure_msl[ci]) : '—';

    // High / Low over past 72 h
    const cutoff = new Date(now.getTime() - 72 * 3600000);
    const win = [];
    for (let i = 0; i < hourly.time.length; i++) {
        const t = new Date(hourly.time[i]);
        if (t >= cutoff && t <= now && hourly.pressure_msl[i] != null) win.push(hourly.pressure_msl[i]);
    }
    const high = win.length ? Math.round(Math.max(...win)) : '—';
    const low  = win.length ? Math.round(Math.min(...win)) : '—';

    return { current, high, low, trend: getPressureTrend(hourly) };
}

function _pcDeltas(hourly, now) {
    let ci = hourly.time.findIndex(t => new Date(t) >= now);
    if (ci < 0) ci = hourly.time.length - 1;

    const d = h => {
        if (ci - h < 0 || hourly.pressure_msl[ci - h] == null) return null;
        return Math.round((hourly.pressure_msl[ci] - hourly.pressure_msl[ci - h]) * 10) / 10;
    };

    const trend = getPressureTrend(hourly);
    const a = Math.abs(trend.change);
    let trendLabel = 'Steady';
    if      (a >= 3)   trendLabel = trend.change > 0 ? 'Rising (rapid)'    : 'Falling (rapid)';
    else if (a >= 1.5) trendLabel = trend.change > 0 ? 'Rising (moderate)' : 'Falling (moderate)';
    else if (a >= 0.5) trendLabel = trend.change > 0 ? 'Rising (slow)'     : 'Falling (slow)';

    return { d6: d(6), d12: d(12), trendLabel, trend };
}

// Return a "nice" step size (1, 2, 5, 10, 20, …) for approximately targetSteps intervals
function _pcNiceStep(range, targetSteps) {
    const raw  = range / targetSteps;
    const exp  = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.001))));
    const frac = raw / exp;
    let nice;
    if      (frac < 1.5) nice = 1;
    else if (frac < 3)   nice = 2;
    else if (frac < 7)   nice = 5;
    else                 nice = 10;
    return Math.max(1, nice * exp);
}
