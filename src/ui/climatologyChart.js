// Climatology chart modal — grouped bars: actual vs 10-yr expected precip
// for the trailing 1/3/6/12-month windows.
// Opens when user taps the Precip vs Normal tile in the current conditions card.
// Globals read: cachedClimatology
// Globals read (ui/utils): _rrNiceMax (precipChart.js), chartNiceStep (chartHelpers.js),
//                          _climoFmtIn, _climoDepText (format.js)

function openClimoChart() {
    if (!cachedClimatology || !cachedClimatology.windows) return;
    _ccRender();
    document.getElementById('climoChartOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closeClimoChart() {
    document.getElementById('climoChartOverlay').classList.remove('visible');
    document.body.style.overflow = '';
}

// ─── Main renderer ────────────────────────────────────────────────────────────

function _ccRender() {
    const climo = cachedClimatology;
    if (!climo || !climo.windows) return;

    const yearsSpan = climo.baselineYears && climo.baselineYears.length
        ? `${climo.baselineYears[0]}–${climo.baselineYears[climo.baselineYears.length - 1]}`
        : '10-yr';
    const minYears = Math.min(...climo.windows.map(w => w.yearsUsed || 0));
    const snow12 = climo.windows.find(w => w.days === 365);
    const snowStr = (snow12 && snow12.snowActualIn > 0) ? `${snow12.snowActualIn.toFixed(1)}"` : null;

    document.getElementById('climoChartBody').innerHTML = `
        <div class="pc-header">
            <div>
                <div class="pc-label">PRECIP VS NORMAL</div>
                <div class="pc-meta-row">
                    <span class="pc-val">Actual vs ${yearsSpan} average</span>
                    ${snowStr ? `<span class="pc-val" style="opacity:0.6">🌨 ${snowStr} snow (12M)</span>` : ''}
                </div>
            </div>
            <button class="pc-close" onclick="closeClimoChart()">✕</button>
        </div>

        <div class="pc-svg-wrap">
            ${_ccSVG(climo.windows)}
        </div>

        <div class="pc-footer">
            <span class="pc-delta">Baseline: <strong>${yearsSpan} same-window average</strong>${minYears < 10 ? ` (${minYears}+ yrs used)` : ''}</span>
            <span class="pc-delta">Data as of: <strong>${climo.asOf}</strong>${climo.actualsGapDays > 0 ? ` (last ${climo.actualsGapDays}d est.)` : ''}</span>
            <span class="pc-delta">Source: <strong>ERA5 reanalysis (Open-Meteo)</strong></span>
        </div>
    `;
}

// ─── SVG grouped bar chart (4 groups × actual/expected) ──────────────────────

function _ccSVG(windows) {
    const W = 520, H = 240;
    const padL = 46, padR = 14, padT = 26, padB = 46;
    const cW = W - padL - padR;
    const cH = H - padT - padB;
    const n = windows.length;

    const allVals = windows.flatMap(w => [w.actualIn || 0, w.expectedIn || 0]);
    const yMax = _rrNiceMax(Math.max(...allVals, 0.01));
    // chartNiceStep (not _rrNiceStep): annual totals need 10"-scale steps,
    // _rrNiceStep caps at 1" and would draw dozens of gridlines.
    const ystep = chartNiceStep(yMax, 5);
    const yOf = v => padT + (1 - v / yMax) * cH;
    const bY = padT + cH;

    // Y grid + labels
    let yLines = '';
    for (let p = 0; p <= yMax + 0.0001; p += ystep) {
        const y = yOf(p).toFixed(1);
        yLines += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.08)"/>` +
            `<text x="${padL - 6}" y="${+y + 3}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.45)">${p.toFixed(p < 10 ? 1 : 0)}"</text>`;
    }

    const groupW = cW / n;
    const barW = Math.min(34, groupW * 0.28);
    const gapIn = 6; // gap between the two bars of a group

    let bars = '';
    windows.forEach((w, i) => {
        const cx = padL + groupW * i + groupW / 2;
        const ax = cx - barW - gapIn / 2;
        const ex = cx + gapIn / 2;

        // Actual bar (solid)
        if (w.actualIn !== null) {
            const y = yOf(w.actualIn);
            bars += `<rect x="${ax.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, bY - y).toFixed(1)}" fill="#00d4ff" rx="2"/>` +
                `<text x="${(ax + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="#00d4ff">${_climoFmtIn(w.actualIn)}</text>`;
        } else {
            bars += `<text x="${(ax + barW / 2).toFixed(1)}" y="${(bY - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.35)">—</text>`;
        }

        // Expected bar (translucent + dashed outline)
        if (w.expectedIn !== null) {
            const y = yOf(w.expectedIn);
            bars += `<rect x="${ex.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, bY - y).toFixed(1)}" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.5)" stroke-width="1" stroke-dasharray="3,2" rx="2"/>` +
                `<text x="${(ex + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.6)">${_climoFmtIn(w.expectedIn)}</text>`;
        } else {
            bars += `<text x="${(ex + barW / 2).toFixed(1)}" y="${(bY - 6).toFixed(1)}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,0.35)">—</text>`;
        }

        // Group label + % departure
        const depColor = w.pctDeparture === null ? 'rgba(255,255,255,0.4)'
            : w.pctDeparture >= 10 ? '#00d4ff'
            : w.pctDeparture <= -10 ? 'var(--alert-amber, #f9a825)'
            : 'rgba(255,255,255,0.6)';
        bars += `<text x="${cx.toFixed(1)}" y="${(bY + 14).toFixed(1)}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.8)">${w.label}</text>` +
            `<text x="${cx.toFixed(1)}" y="${(bY + 28).toFixed(1)}" text-anchor="middle" font-size="10" fill="${depColor}">${_climoDepText(w.pctDeparture)}</text>`;
    });

    // Legend (top-right)
    const legend =
        `<rect x="${W - padR - 150}" y="8" width="10" height="10" fill="#00d4ff" rx="2"/>` +
        `<text x="${W - padR - 136}" y="17" font-size="9" fill="rgba(255,255,255,0.7)">Actual</text>` +
        `<rect x="${W - padR - 92}" y="8" width="10" height="10" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.5)" stroke-dasharray="3,2" rx="2"/>` +
        `<text x="${W - padR - 78}" y="17" font-size="9" fill="rgba(255,255,255,0.7)">Expected (10-yr avg)</text>`;

    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto">
        ${yLines}
        <line x1="${padL}" y1="${bY}" x2="${W - padR}" y2="${bY}" stroke="rgba(255,255,255,0.25)"/>
        ${bars}
        ${legend}
    </svg>`;
}
