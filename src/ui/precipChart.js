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
    // Sync the current-conditions card spark tile to the new window
    const tile = document.querySelector('.precip-spark-tile');
    if (tile && cachedRecentPrecip) {
        const sliced = sliceRecentPrecip(cachedRecentPrecip, w);
        if (sliced) {
            const tmp = document.createElement('div');
            tmp.innerHTML = renderPrecipSpark(sliced);
            tile.replaceWith(tmp.firstElementChild);
        }
    }
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function _rrRender() {
    if (!_rrData) return;

    const now    = new Date();
    const sliced = sliceRecentPrecip(_rrData, _rrWindow);
    if (!sliced) return;

    const { rainTotal, snowTotal, lagMinutes, method, source, qualityFlags, asOf,
            futureSeries, forecastRainTotal, forecastSnowTotal } = sliced;

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
    const coverageStr = startDate ? `${_rrFmtDT(startDate)} → NOW` : _rrFmtDT(asOfDate);

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

    // Forecast totals for header
    const hasForecast = futureSeries && futureSeries.length > 0;
    const fcstRainStr = (hasForecast && forecastRainTotal > 0) ? `${forecastRainTotal.toFixed(2)}"` : null;
    const fcstSnowStr = (hasForecast && forecastSnowTotal > 0) ? `${forecastSnowTotal.toFixed(2)}"` : null;

    document.getElementById('precipChartBody').innerHTML = `
        <div class="pc-header">
            <div>
                <div class="pc-label">PRECIP</div>
                <div class="pc-meta-row">
                    <span class="pc-val">🌧 ${rainStr}</span>
                    ${snowStr ? `<span class="pc-val">🌨 ${snowStr}</span>` : ''}
                    ${fcstRainStr ? `<span class="pc-val" style="opacity:0.6">🔮 ${fcstRainStr} fcst</span>` : ''}
                    ${fcstSnowStr ? `<span class="pc-val" style="opacity:0.6">🔮❄ ${fcstSnowStr} fcst</span>` : ''}
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
            ${_rrSVG(sliced.series, now, futureSeries)}
        </div>

        <div class="pc-footer">
            <span class="pc-delta">Observed: <strong>${coverageStr}</strong></span>
            ${hasForecast ? `<span class="pc-delta">Forecast: <strong>+${futureSeries.length}h (Open-Meteo)</strong></span>` : ''}
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
// Renders observed bars + optional forecast bars separated by a NOW divider.
// Layout: [observed bars] [gap + NOW line] [forecast bars]
// If futureSeries is empty, renders exactly as before (no gap, no divider).

function _rrSVG(series, now, futureSeries) {
    if (!series || !series.length) {
        return '<div class="pc-empty">No precipitation data available for this period</div>';
    }

    const W = 520, H = 210;
    const padL = 46, padR = 18, padT = 22, padB = 38;
    const cW = W - padL - padR;
    const cH = H - padT - padB;
    const n  = series.length;
    const fN = (futureSeries && futureSeries.length) || 0;

    // Total slots: observed + gap (if future exists) + future
    const totalSlots = fN > 0 ? n + 1 + fN : n;

    // Bar geometry: gap of 1px between bars
    const barW = Math.max(2, (cW / totalSlots) - 1);

    // Y scale — spans both observed and future
    const obsTotals = series.map(s => (s.rainIn || 0) + (s.snowIn || 0));
    const fcstTotals = fN > 0 ? futureSeries.map(s => (s.rainIn || 0) + (s.snowIn || 0)) : [];
    const rawMax    = Math.max(...obsTotals, ...fcstTotals, 0.01);
    const yMax      = _rrNiceMax(rawMax);
    const ystep     = _rrNiceStep(yMax);

    const xOf = i  => padL + (i / totalSlots) * cW;
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

    // ── Observed bars ──
    let bars = '';
    for (let i = 0; i < n; i++) {
        const s = series[i];
        const x = xOf(i);

        if (!s.present) {
            bars += `<rect x="${x.toFixed(1)}" y="${(bY - 6).toFixed(1)}" width="${barW.toFixed(1)}" height="6" `
                 + `fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.8" stroke-dasharray="2,2" rx="1"/>`;
        } else {
            const rain  = s.rainIn  || 0;
            const snow  = s.snowIn  || 0;
            const total = rain + snow;

            if (total > 0) {
                if (rain > 0) {
                    const rH = Math.max(1.5, (rain / yMax) * cH);
                    bars += `<rect x="${x.toFixed(1)}" y="${(bY - rH).toFixed(1)}" `
                         + `width="${barW.toFixed(1)}" height="${rH.toFixed(1)}" fill="#00d4ff" rx="1" opacity="0.82"/>`;
                }
                if (snow > 0) {
                    const sH = Math.max(1.5, (snow / yMax) * cH);
                    const sY = yOf(total);
                    bars += `<rect x="${x.toFixed(1)}" y="${sY.toFixed(1)}" `
                         + `width="${barW.toFixed(1)}" height="${sH.toFixed(1)}" fill="#a8daff" rx="1" opacity="0.85"/>`;
                }
            } else {
                bars += `<rect x="${x.toFixed(1)}" y="${(bY - 2).toFixed(1)}" `
                     + `width="${barW.toFixed(1)}" height="2" fill="rgba(255,255,255,0.1)" rx="0.5"/>`;
            }
        }
    }

    // ── NOW divider + forecast region ──
    let nowMark = '';
    let forecastBars = '';
    let forecastBg = '';
    let forecastLabel = '';

    if (fN > 0) {
        // NOW divider: positioned in the gap slot (index n)
        const nowX = xOf(n) + barW / 2;
        nowMark =
            `<line x1="${nowX.toFixed(1)}" y1="${padT}" x2="${nowX.toFixed(1)}" y2="${bY}" `
          + `stroke="rgba(255,255,255,0.5)" stroke-width="1.5"/>`
          + `<text x="${nowX.toFixed(1)}" y="${(padT - 5).toFixed(1)}" text-anchor="middle" `
          + `fill="rgba(255,255,255,0.65)" font-size="8" font-weight="600" font-family="JetBrains Mono, monospace">NOW</text>`;

        // Forecast background shading
        const fcstStartX = xOf(n + 1);
        const fcstEndX = xOf(totalSlots);
        forecastBg =
            `<rect x="${fcstStartX.toFixed(1)}" y="${padT}" width="${(fcstEndX - fcstStartX).toFixed(1)}" `
          + `height="${cH}" fill="rgba(255,255,255,0.025)" rx="2"/>`;

        // "FORECAST" label centered above future region
        const fcstMidX = (fcstStartX + fcstEndX) / 2;
        forecastLabel =
            `<text x="${fcstMidX.toFixed(1)}" y="${(padT + 10).toFixed(1)}" text-anchor="middle" `
          + `fill="rgba(255,255,255,0.3)" font-size="7" font-family="JetBrains Mono, monospace" letter-spacing="1">FORECAST</text>`;

        // Forecast bars — lighter, dashed outline
        for (let j = 0; j < fN; j++) {
            const s = futureSeries[j];
            const x = xOf(n + 1 + j);
            const rain  = s.rainIn  || 0;
            const snow  = s.snowIn  || 0;
            const total = rain + snow;

            if (total > 0) {
                if (rain > 0) {
                    const rH = Math.max(1.5, (rain / yMax) * cH);
                    forecastBars += `<rect x="${x.toFixed(1)}" y="${(bY - rH).toFixed(1)}" `
                        + `width="${barW.toFixed(1)}" height="${rH.toFixed(1)}" `
                        + `fill="rgba(0,212,255,0.25)" stroke="rgba(0,212,255,0.5)" stroke-width="0.8" stroke-dasharray="2,1" rx="1"/>`;
                }
                if (snow > 0) {
                    const sH = Math.max(1.5, (snow / yMax) * cH);
                    const sY = yOf(total);
                    forecastBars += `<rect x="${x.toFixed(1)}" y="${sY.toFixed(1)}" `
                        + `width="${barW.toFixed(1)}" height="${sH.toFixed(1)}" `
                        + `fill="rgba(168,218,255,0.25)" stroke="rgba(168,218,255,0.5)" stroke-width="0.8" stroke-dasharray="2,1" rx="1"/>`;
                }
            } else {
                forecastBars += `<rect x="${x.toFixed(1)}" y="${(bY - 2).toFixed(1)}" `
                    + `width="${barW.toFixed(1)}" height="2" fill="rgba(255,255,255,0.06)" rx="0.5"/>`;
            }
        }
    } else {
        // No future data — render old-style NOW marker if current time falls within window
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
    }

    // X-axis labels
    const xLabels = _rrXLabels(series, n, xOf, barW, padT, cH, padL, W, padR, futureSeries, totalSlots);

    // Legend (top-right corner) — extended with Forecast swatch if future exists
    const legY  = padT;
    const legX  = fN > 0 ? W - padR - 118 : W - padR - 72;
    let legend =
        `<rect x="${legX}" y="${legY}" width="8" height="8" fill="#00d4ff" rx="1"/>`
      + `<text x="${legX + 11}" y="${legY + 7}" fill="rgba(255,255,255,0.5)" font-size="8" font-family="JetBrains Mono, monospace">Rain</text>`
      + `<rect x="${legX + 38}" y="${legY}" width="8" height="8" fill="#a8daff" rx="1"/>`
      + `<text x="${legX + 51}" y="${legY + 7}" fill="rgba(255,255,255,0.5)" font-size="8" font-family="JetBrains Mono, monospace">Snow</text>`;
    if (fN > 0) {
        legend +=
            `<rect x="${legX + 82}" y="${legY}" width="8" height="8" fill="rgba(0,212,255,0.25)" stroke="rgba(0,212,255,0.5)" stroke-width="0.8" stroke-dasharray="2,1" rx="1"/>`
          + `<text x="${legX + 93}" y="${legY + 7}" fill="rgba(255,255,255,0.5)" font-size="8" font-family="JetBrains Mono, monospace">Fcst</text>`;
    }

    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:auto;display:block;" preserveAspectRatio="xMidYMid meet">
    ${yLines}
    ${baseline}
    ${forecastBg}
    ${bars}
    ${forecastBars}
    ${nowMark}
    ${forecastLabel}
    ${legend}
    ${xLabels}
</svg>`;
}

function _rrXLabels(series, n, xOf, barW, padT, cH, padL, W, padR, futureSeries, totalSlots) {
    const out  = [];
    const lY   = (padT + cH + 21).toFixed(1);
    const tY1  = padT + cH;
    const tY2  = padT + cH + 5;
    // Show ~6 labels for observed regardless of window size
    const step = n <= 6 ? 1 : n <= 12 ? 2 : n <= 24 ? 4 : 8;

    // Observed labels — time-of-day
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

    // Forecast labels — relative format (+1h, +2h, +3h)
    // When bars are narrow (large observed windows), show only a single centered "+3h" label
    const fN = (futureSeries && futureSeries.length) || 0;
    if (fN > 0) {
        const fcstBarWidth = barW + 1; // bar + gap
        const showAll = fcstBarWidth * fN > 60; // enough room for individual labels

        if (showAll) {
            for (let j = 0; j < fN; j++) {
                const cx = (xOf(n + 1 + j) + barW / 2).toFixed(1);
                const label = `+${j + 1}h`;
                out.push(
                    `<line x1="${cx}" y1="${tY1}" x2="${cx}" y2="${tY2}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`
                  + `<text x="${cx}" y="${lY}" text-anchor="middle" `
                  + `fill="rgba(255,255,255,0.35)" font-size="9" font-family="JetBrains Mono, monospace">${label}</text>`
                );
            }
        } else {
            // Single centered label for the forecast region
            const midX = ((xOf(n + 1) + xOf(n + fN) + barW) / 2).toFixed(1);
            out.push(
                `<text x="${midX}" y="${lY}" text-anchor="middle" `
              + `fill="rgba(255,255,255,0.35)" font-size="8" font-family="JetBrains Mono, monospace">+${fN}h</text>`
            );
        }
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
