// Shared helpers for pressure, AQI, and similar line charts.
// Extracted from pressureChart.js and aqiChart.js to eliminate duplication.

// Return a "nice" step size (1, 2, 5, 10, 20, …) for approximately targetSteps intervals
function chartNiceStep(range, targetSteps) {
    const raw  = range / targetSteps;
    const exp  = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 0.001))));
    const frac = raw / exp;
    let nice;
    if      (frac < 1.5) nice = 1;
    else if (frac < 3)   nice = 2;
    else if (frac < 7)   nice = 5;
    else                  nice = 10;
    return Math.max(1, nice * exp);
}

// Build SVG Y-axis grid lines + labels
function buildYGrid(yMin, yMax, step, yOf, padL, W, padR, formatLabel) {
    const yStart = Math.ceil(yMin / step) * step;
    let svg = '';
    for (let v = yStart; v <= yMax; v += step) {
        const y = yOf(v).toFixed(1);
        const label = formatLabel ? formatLabel(v) : v;
        svg +=
            `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" `
          + `stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`
          + `<text x="${(padL - 6).toFixed(1)}" y="${y}" text-anchor="end" dominant-baseline="middle" `
          + `fill="rgba(255,255,255,0.45)" font-size="10" font-family="JetBrains Mono, monospace">${label}</text>`;
    }
    return svg;
}

// Build SVG X-axis time labels for ±range line charts (24h, 3d, 7d)
function buildChartXLabels(times, range, now, xOf, padT, cH, padL, W, padR) {
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
        const step = 12;
        for (let h = -24; h <= 24; h += step) {
            if (h === 0) continue;
            const t = new Date(now.getTime() + h * 3600000);
            const x = xOf(t);
            if (x < padL - 16 || x > W - padR + 1) continue;
            out.push(tick(x, `${h > 0 ? '+' : ''}${h}h`, false));
        }
    } else {
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
