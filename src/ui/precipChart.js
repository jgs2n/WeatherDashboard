// Precip chart modal — SVG recent precipitation bar chart overlay
// Opens when user taps the Recent Precip tile in the current conditions card.
// Globals read: cachedRecentPrecip, lastRefreshTime
// Globals read (services): sliceRecentPrecip (from recentPrecip.js)

let _rrWindow = parseInt(localStorage.getItem('precipWindow')) || 12;
let _rrData   = null;

function openPrecipChart(precipData) {
    _rrData   = precipData;
    _rrWindow = parseInt(localStorage.getItem('precipWindow')) || 12;
    _rrRender();
    document.getElementById('precipChartOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closePrecipChart() {
    document.getElementById('precipChartOverlay').classList.remove('visible');
    document.body.style.overflow = '';
}

function setPrecipWindow(w) {
    _rrWindow = w;
    localStorage.setItem('precipWindow', w);
    _rrRender();
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function _rrRender() {
    if (!_rrData) return;

    const now    = new Date();
    const sliced = sliceRecentPrecip(_rrData, _rrWindow);
    if (!sliced) return;

    const { rainTotal, snowTotal, lagMinutes, method, source, qualityFlags, asOf } = sliced;

    // Method badge class + label
    let badgeClass = 'est', badgeText = 'EST';
    if (method === 'meteostat_hourly' && !qualityFlags.includes('stale') && !qualityFlags.includes('very_stale')) {
        badgeClass = 'live'; badgeText = 'LIVE';
    }
    if (lagMinutes > 360 || qualityFlags.includes('very_stale')) {
        badgeClass = 'stale'; badgeText = 'STALE';
    }

    // Coverage + provenance strings
    const asOfDate    = new Date(asOf);
    const startDate   = sliced.coverageStart ? new Date(sliced.coverageStart) : null;
    const lagStr      = lagMinutes < 60
        ? `${lagMinutes} min ago`
        : `${Math.floor(lagMinutes / 60)}h ${lagMinutes % 60}m ago`;
    const coverageStr = startDate ? `${_rrFmtDT(startDate)} → ${_rrFmtDT(asOfDate)}` : _rrFmtDT(asOfDate);

    let sourceStr = source.provider;
    if (source.stationName) sourceStr += ` / ${source.stationName}`;
    else if (source.stationId) sourceStr += ` / ${source.stationId}`;
    if (source.distanceKm)  sourceStr += ` · ${source.distanceKm} km`;
    if (source.gridProduct) sourceStr += ` / ${source.gridProduct}`;

    const completenessStr = sliced.missingHours > 0
        ? `${sliced.reportedHours} of ${sliced.expectedHours} hours reported`
        : `${sliced.expectedHours} of ${sliced.expectedHours} hours complete`;

    // Range buttons
    const rangeBtns = [6, 12, 24, 48].map(w =>
        `<button class="pc-rb ${_rrWindow === w ? 'active' : ''}" onclick="setPrecipWindow(${w})">${w}H</button>`
    ).join('');

    let updatedStr = '';
    if (lastRefreshTime) {
        const mins = Math.round((now - lastRefreshTime) / 60000);
        updatedStr = mins <= 1 ? 'just now' : `${mins} min ago`;
    }

    const rainStr = (rainTotal !== null && rainTotal > 0) ? `${rainTotal.toFixed(2)}"` : '—';
    const snowStr = (snowTotal > 0) ? `${snowTotal.toFixed(2)}"` : null;

    document.getElementById('precipChartBody').innerHTML = `
        <div class="pc-header">
            <div>
                <div class="pc-label">RECENT PRECIP</div>
                <div class="pc-meta-row">
                    <span class="pc-val">🌧 ${rainStr}</span>
                    ${snowStr ? `<span class="pc-val">🌨 ${snowStr}</span>` : ''}
                    <span class="pc-hl">${_rrWindow}H</span>
                    <span class="precip-method-badge ${badgeClass}" style="vertical-align:middle">${badgeText}</span>
                </div>
            </div>
            <button class="pc-close" onclick="closePrecipChart()">✕</button>
        </div>

        <div class="pc-range-bar">
            <span class="pc-range-label">Window:</span>
            ${rangeBtns}
            ${updatedStr ? `<span class="pc-updated-str">Updated: ${updatedStr}</span>` : ''}
        </div>

        <div class="pc-svg-wrap">
            ${_rrSVG(sliced.series, now)}
        </div>

        <div class="pc-footer">
            <span class="pc-delta">Coverage: <strong>${coverageStr}</strong></span>
            <span class="pc-delta">Data as of: <strong>${_rrFmtDT(asOfDate)}</strong> (${lagStr})</span>
            <span class="pc-delta" ${sliced.missingHours > 0 ? 'style="color:var(--alert-amber,#f9a825)"' : ''}>${sliced.missingHours > 0 ? '⚠ ' : ''}${completenessStr}</span>
            <span class="pc-delta">Source: <strong>${sourceStr}</strong></span>
        </div>
    `;
}

function _rrFmtDT(d) {
    return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ─── SVG stacked bar chart ────────────────────────────────────────────────────

function _rrSVG(series, now) {
    if (!series || !series.length) {
        return '<div class="pc-empty">No precipitation data available for this period</div>';
    }

    const W = 520, H = 210;
    const padL = 46, padR = 18, padT = 22, padB = 38;
    const cW = W - padL - padR;
    const cH = H - padT - padB;
    const n  = series.length;

    // Bar geometry: gap of 1px between bars
    const barW = Math.max(2, (cW / n) - 1);

    // Y scale
    const allTotals = series.map(s => (s.rainIn || 0) + (s.snowIn || 0));
    const rawMax    = Math.max(...allTotals, 0.01);
    const yMax      = _rrNiceMax(rawMax);
    const ystep     = _rrNiceStep(yMax);

    const xOf = i  => padL + (i / n) * cW;
    const yOf = v  => padT + (1 - v / yMax) * cH;
    const bY  = padT + cH;

    // Y-axis grid lines + labels
    let yLines = '';
    for (let p = 0; p <= yMax + 0.0001; p += ystep) {
        if (p > yMax + 0.0001) break;
        const y = yOf(p).toFixed(1);
        yLines +=
            `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`
          + `<text x="${(padL - 5).toFixed(1)}" y="${y}" text-anchor="end" dominant-baseline="middle" `
          + `fill="rgba(255,255,255,0.45)" font-size="9" font-family="JetBrains Mono, monospace">${p.toFixed(2)}"</text>`;
    }

    // Baseline
    const baseline = `<line x1="${padL}" y1="${bY}" x2="${W - padR}" y2="${bY}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;

    // Bars
    let bars = '';
    for (let i = 0; i < n; i++) {
        const s = series[i];
        const x = xOf(i);

        if (!s.present) {
            // Missing hour: subtle empty stub with dashed border
            bars += `<rect x="${x.toFixed(1)}" y="${(bY - 6).toFixed(1)}" width="${barW.toFixed(1)}" height="6" `
                 + `fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.8" stroke-dasharray="2,2" rx="1"/>`;
        } else {
            const rain  = s.rainIn  || 0;
            const snow  = s.snowIn  || 0;
            const total = rain + snow;

            if (total > 0) {
                // Rain segment (bottom, cyan)
                if (rain > 0) {
                    const rH = Math.max(1.5, (rain / yMax) * cH);
                    bars += `<rect x="${x.toFixed(1)}" y="${(bY - rH).toFixed(1)}" `
                         + `width="${barW.toFixed(1)}" height="${rH.toFixed(1)}" fill="#00d4ff" rx="1" opacity="0.82"/>`;
                }
                // Snow segment (on top of rain, light blue)
                if (snow > 0) {
                    const sH = Math.max(1.5, (snow / yMax) * cH);
                    const sY = yOf(total);
                    bars += `<rect x="${x.toFixed(1)}" y="${sY.toFixed(1)}" `
                         + `width="${barW.toFixed(1)}" height="${sH.toFixed(1)}" fill="#a8daff" rx="1" opacity="0.85"/>`;
                }
            } else {
                // Dry hour: hairline stub
                bars += `<rect x="${x.toFixed(1)}" y="${(bY - 2).toFixed(1)}" `
                     + `width="${barW.toFixed(1)}" height="2" fill="rgba(255,255,255,0.1)" rx="0.5"/>`;
            }
        }
    }

    // X-axis labels
    const xLabels = _rrXLabels(series, n, xOf, barW, padT, cH, padL, W, padR);

    // "Now" vertical marker (if current time falls within the chart window)
    let nowMark = '';
    if (series.length > 1) {
        const t0 = new Date(series[0].time).getTime();
        const t1 = new Date(series[series.length - 1].time).getTime() + 3600000;
        if (now.getTime() >= t0 && now.getTime() <= t1) {
            const frac = (now.getTime() - t0) / (t1 - t0);
            const nx   = (padL + frac * cW).toFixed(1);
            nowMark =
                `<line x1="${nx}" y1="${padT}" x2="${nx}" y2="${bY}" `
              + `stroke="rgba(0,212,255,0.3)" stroke-width="1" stroke-dasharray="3,3"/>`
              + `<text x="${(parseFloat(nx) + 3).toFixed(1)}" y="${(padT + 9).toFixed(1)}" `
              + `fill="rgba(255,255,255,0.55)" font-size="8" font-family="JetBrains Mono, monospace">NOW</text>`;
        }
    }

    // Legend (top-right corner)
    const legY  = padT;
    const legX  = W - padR - 72;
    const legend =
        `<rect x="${legX}" y="${legY}" width="8" height="8" fill="#00d4ff" rx="1"/>`
      + `<text x="${legX + 11}" y="${legY + 7}" fill="rgba(255,255,255,0.5)" font-size="8" font-family="JetBrains Mono, monospace">Rain</text>`
      + `<rect x="${legX + 38}" y="${legY}" width="8" height="8" fill="#a8daff" rx="1"/>`
      + `<text x="${legX + 51}" y="${legY + 7}" fill="rgba(255,255,255,0.5)" font-size="8" font-family="JetBrains Mono, monospace">Snow</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:auto;display:block;" preserveAspectRatio="xMidYMid meet">
    ${yLines}
    ${baseline}
    ${bars}
    ${nowMark}
    ${legend}
    ${xLabels}
</svg>`;
}

function _rrXLabels(series, n, xOf, barW, padT, cH, padL, W, padR) {
    const out  = [];
    const lY   = (padT + cH + 21).toFixed(1);
    const tY1  = padT + cH;
    const tY2  = padT + cH + 5;
    // Show ~6 labels regardless of window size
    const step = n <= 6 ? 1 : n <= 12 ? 2 : n <= 24 ? 4 : 8;

    for (let i = 0; i < n; i += step) {
        const cx = (xOf(i) + barW / 2).toFixed(1);
        const d  = new Date(series[i].time);
        const hr = d.getHours();
        const label = hr === 0
            ? d.toLocaleDateString('en-US', { weekday: 'short' })
            : d.toLocaleTimeString('en-US', { hour: 'numeric' }).replace(' AM', 'a').replace(' PM', 'p');
        out.push(
            `<line x1="${cx}" y1="${tY1}" x2="${cx}" y2="${tY2}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`
          + `<text x="${cx}" y="${lY}" text-anchor="middle" `
          + `fill="rgba(255,255,255,0.45)" font-size="9" font-family="JetBrains Mono, monospace">${label}</text>`
        );
    }
    return out.join('');
}

// ─── Scale helpers ────────────────────────────────────────────────────────────

function _rrNiceMax(v) {
    if (v <= 0.05) return 0.10;
    if (v <= 0.10) return 0.20;
    if (v <= 0.25) return 0.50;
    if (v <= 0.50) return 1.00;
    if (v <= 1.00) return 1.50;
    if (v <= 2.00) return 2.50;
    return Math.ceil(v * 1.3 * 10) / 10;
}

function _rrNiceStep(yMax) {
    if (yMax <= 0.10) return 0.05;
    if (yMax <= 0.50) return 0.10;
    if (yMax <= 1.00) return 0.25;
    if (yMax <= 2.00) return 0.50;
    return 1.00;
}
