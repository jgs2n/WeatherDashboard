// AQI chart modal — SVG air quality history/forecast overlay
// Opens when user taps the Air Quality field in the current conditions card.
// Globals read: cachedAQIHourly, lastRefreshTime
// Globals read (utils): getAQICategory (from risk.js)

let _acRange = '3d';
let _acData  = null;

function openAQIChart(aqiHourly) {
    _acData  = aqiHourly || cachedAQIHourly;
    _acRange = '3d';
    _acRender();
    document.getElementById('aqiChartOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closeAQIChart() {
    document.getElementById('aqiChartOverlay').classList.remove('visible');
    document.body.style.overflow = '';
}

function setAQIRange(range) {
    _acRange = range;
    _acRender();
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function _acRender() {
    if (!_acData) {
        document.getElementById('aqiChartBody').innerHTML = `
            <div class="pc-header">
                <div><div class="pc-label">AIR QUALITY</div></div>
                <button class="pc-close" onclick="closeAQIChart()">✕</button>
            </div>
            <div class="pc-empty">Air quality history is not available for this location.</div>
        `;
        return;
    }
    const now   = new Date();
    const stats = _acStats(_acData, now);
    const { times, values } = _acSlice(_acData, _acRange, now);
    const cat   = getAQICategory(stats.current);

    let updatedStr = '';
    if (lastRefreshTime) {
        const mins = Math.round((now - lastRefreshTime) / 60000);
        updatedStr = mins <= 1 ? 'just now' : `${mins} min ago`;
    }

    const rangeBtns = ['24h', '3d', '7d'].map(r =>
        `<button class="pc-rb ${_acRange === r ? 'active' : ''}" onclick="setAQIRange('${r}')">${r}</button>`
    ).join('');

    // Δ 24h change
    let d24HTML = '';
    const ci = _acNowIndex(_acData, now);
    if (ci >= 24 && _acData.us_aqi[ci - 24] != null && _acData.us_aqi[ci] != null) {
        const d24 = Math.round(_acData.us_aqi[ci] - _acData.us_aqi[ci - 24]);
        d24HTML = `<span class="pc-delta">Δ 24h: <strong>${d24 >= 0 ? '+' : ''}${d24}</strong></span>`;
    }

    document.getElementById('aqiChartBody').innerHTML = `
        <div class="pc-header">
            <div>
                <div class="pc-label">AIR QUALITY</div>
                <div class="pc-meta-row">
                    <span class="pc-val" style="color:${cat.color}">${stats.current}<span class="pc-unit"> AQI</span></span>
                    <span class="pc-sealevel" style="color:${cat.color}">${cat.icon} ${cat.level}</span>
                    <span class="pc-hl">High ${stats.high}</span>
                    <span class="pc-hl">Low ${stats.low}</span>
                </div>
            </div>
            <button class="pc-close" onclick="closeAQIChart()">✕</button>
        </div>

        <div class="pc-range-bar">
            <span class="pc-range-label">Range:</span>
            ${rangeBtns}
            ${updatedStr ? `<span class="pc-updated-str">Updated: ${updatedStr}</span>` : ''}
        </div>

        <div class="pc-svg-wrap">
            ${_acSVG(times, values, _acRange, now, cat.color)}
        </div>

        <div class="pc-footer">
            ${d24HTML}
            <span class="pc-delta">Category: <strong style="color:${cat.color}">${cat.level}</strong></span>
        </div>
    `;
}

// ─── SVG chart builder ────────────────────────────────────────────────────────

function _acSVG(times, values, range, now, accentColor) {
    if (!times.length) {
        return '<div class="pc-empty">No air quality data available for this range</div>';
    }

    const W = 520, H = 210;
    const padL = 50, padR = 74, padT = 16, padB = 38;
    const cW = W - padL - padR;
    const cH = H - padT - padB;

    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const vpad   = Math.max(5, (rawMax - rawMin) * 0.3);
    const yMin   = Math.max(0, Math.floor((rawMin - vpad) / 5) * 5);
    const yMax   = Math.ceil((rawMax + vpad) / 5) * 5;

    const t0 = times[0].getTime();
    const t1 = times[times.length - 1].getTime();
    const tD = t1 - t0 || 1;

    const xOf = t => padL + ((t.getTime() - t0) / tD) * cW;
    const yOf = v => padT + (1 - (v - yMin) / (yMax - yMin)) * cH;

    const pts   = times.map((t, i) => `${xOf(t).toFixed(1)},${yOf(values[i]).toFixed(1)}`);
    const lineD = 'M ' + pts.join(' L ');
    const bY    = (padT + cH).toFixed(1);
    const areaD = `M ${xOf(times[0]).toFixed(1)},${bY} L ${pts.join(' L ')} `
                + `L ${xOf(times[times.length - 1]).toFixed(1)},${bY} Z`;

    // Y-axis grid + labels
    const ystep  = _acNiceStep(yMax - yMin, 5);
    const yStart = Math.ceil(yMin / ystep) * ystep;
    let yLines = '';
    for (let v = yStart; v <= yMax; v += ystep) {
        const y = yOf(v).toFixed(1);
        yLines +=
            `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" `
          + `stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`
          + `<text x="${(padL - 6).toFixed(1)}" y="${y}" text-anchor="end" dominant-baseline="middle" `
          + `fill="rgba(255,255,255,0.45)" font-size="10" font-family="JetBrains Mono, monospace">${v}</text>`;
    }

    // AQI threshold bands (subtle background zones)
    const thresholds = [
        { limit: 50,  color: '#00e400' },
        { limit: 100, color: '#ffff00' },
        { limit: 150, color: '#ff7e00' },
        { limit: 200, color: '#ff0000' },
        { limit: 300, color: '#8f3f97' },
    ];
    let bands = '';
    let prevY = padT;
    for (const { limit, color } of thresholds) {
        if (limit <= yMin) continue;
        const bandTop  = limit <= yMax ? yOf(limit).toFixed(1) : padT;
        const bandBot  = prevY;
        bands += `<rect x="${padL}" y="${bandTop}" width="${cW}" height="${parseFloat(bandBot) - parseFloat(bandTop)}" `
               + `fill="${color}" opacity="0.04"/>`;
        prevY = bandTop;
        if (limit >= yMax) break;
    }

    const baseline = `<line x1="${padL}" y1="${bY}" x2="${W - padR}" y2="${bY}" `
                   + `stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;

    const xLabels = _acXLabels(times, range, now, xOf, padT, cH, padL, W, padR);

    // "Now" marker for past-range charts
    let nowMark = '';
    if (range !== '7d') {
        const lastI = times.length - 1;
        const nx    = xOf(times[lastI]).toFixed(1);
        const ny    = yOf(values[lastI]).toFixed(1);
        const nowV  = Math.round(values[lastI]);
        nowMark =
            `<line x1="${nx}" y1="${padT}" x2="${nx}" y2="${bY}" `
          + `stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="3,3"/>`
          + `<circle cx="${nx}" cy="${ny}" r="4.5" fill="${accentColor}" stroke="#0d1117" stroke-width="2"/>`
          + `<text x="${(parseFloat(nx) + 9).toFixed(1)}" y="${ny}" dominant-baseline="middle" `
          + `fill="rgba(255,255,255,0.82)" font-size="10" font-family="JetBrains Mono, monospace">`
          + `Now ${nowV}</text>`;
    }

    // Encode accent color for SVG gradient ID (strip #)
    const gradId = 'acAreaGrad';

    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:auto;display:block;" preserveAspectRatio="xMidYMid meet">
    <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="${accentColor}" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="${accentColor}" stop-opacity="0.01"/>
        </linearGradient>
    </defs>
    ${bands}
    ${yLines}
    ${baseline}
    <path d="${areaD}" fill="url(#${gradId})"/>
    <path d="${lineD}" fill="none" stroke="rgba(255,255,255,0.88)"
          stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${nowMark}
    ${xLabels}
</svg>`;
}

function _acXLabels(times, range, now, xOf, padT, cH, padL, W, padR) {
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

    if (range === '24h' || range === '3d') {
        const dataStartH = (times[0].getTime() - now.getTime()) / 3600000;
        const actualSpan = Math.abs(dataStartH);
        let step;
        if      (actualSpan <= 2)  step = 0.5;
        else if (actualSpan <= 6)  step = 1;
        else if (actualSpan <= 12) step = 3;
        else if (actualSpan <= 24) step = 6;
        else                       step = 12;

        const hStart = Math.floor(dataStartH / step) * step;
        for (let h = hStart; h <= 0; h += step) {
            const t = new Date(now.getTime() + h * 3600000);
            const x = xOf(t);
            if (x < padL - 16 || x > W - padR + 1) continue;
            out.push(tick(x, h === 0 ? 'Now' : `${Math.round(h)}h`, false));
        }
    } else {
        // 7d — day separators
        for (let d = 0; d <= 7; d++) {
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

function _acSlice(hourly, range, now) {
    let s, e;
    if (range === '24h') {
        s = new Date(now.getTime() - 24 * 3600000); e = now;
    } else if (range === '3d') {
        s = new Date(now.getTime() - 72 * 3600000); e = now;
    } else {
        s = now; e = new Date(now.getTime() + 7 * 24 * 3600000);
    }
    const times = [], values = [];
    for (let i = 0; i < hourly.time.length; i++) {
        const t = new Date(hourly.time[i]);
        if (t >= s && t <= e && hourly.us_aqi[i] != null) {
            times.push(t);
            values.push(hourly.us_aqi[i]);
        }
    }
    return { times, values };
}

function _acNowIndex(hourly, now) {
    let ci = hourly.time.findIndex(t => new Date(t) >= now);
    if (ci < 0) ci = hourly.time.length - 1;
    return ci;
}

function _acStats(hourly, now) {
    const ci = _acNowIndex(hourly, now);
    const current = ci >= 0 && hourly.us_aqi[ci] != null ? Math.round(hourly.us_aqi[ci]) : 0;

    // High / Low over past 24 h
    const cutoff = new Date(now.getTime() - 24 * 3600000);
    const win = [];
    for (let i = 0; i < hourly.time.length; i++) {
        const t = new Date(hourly.time[i]);
        if (t >= cutoff && t <= now && hourly.us_aqi[i] != null) win.push(hourly.us_aqi[i]);
    }
    const high = win.length ? Math.round(Math.max(...win)) : '—';
    const low  = win.length ? Math.round(Math.min(...win)) : '—';

    return { current, high, low };
}

function _acNiceStep(range, targetSteps) {
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
