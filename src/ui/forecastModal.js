// Forecast detail modal — 7-day day detail overlay
// Globals used: forecastDays, forecastDetailIndex

function openForecastDetail(index) {
    forecastDetailIndex = index;
    renderForecastDetailDay(index);
    document.getElementById('forecastDetailOverlay').classList.add('visible');
    document.body.style.overflow = 'hidden';
}

function closeForecastDetail() {
    document.getElementById('forecastDetailOverlay').classList.remove('visible');
    document.body.style.overflow = '';
}

function navigateForecastDetail(delta) {
    const next = forecastDetailIndex + delta;
    if (next < 0 || next >= forecastDays.length) return;
    forecastDetailIndex = next;
    renderForecastDetailDay(forecastDetailIndex);
}

function renderForecastDetailDay(index) {
    const d = forecastDays[index];
    if (!d) return;

    function fmtTime(iso) {
        if (!iso) return '—';
        const t = new Date(iso);
        return t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }

    const nwsHTML = d.nwsPeriods.length ? `
        <div class="fd-nws">
            ${d.nwsPeriods.map(p => `
                <div class="fd-nws-period">
                    <span class="fd-nws-name">${p.name}:</span>${p.detailedForecast}
                </div>`).join('')}
        </div>` : '';

    document.getElementById('forecastDetailBody').innerHTML = `
        <div class="fd-header-row">
            <span class="fd-day-name">${d.fullDayName}</span>
            <span class="fd-date">${d.dateDisplay}</span>
        </div>
        <div class="fd-icon-row">
            <span class="fd-icon">${d.icon}</span>
            <span class="fd-condition">${d.desc}</span>
        </div>
        <div class="fd-temps${d.hasSpread ? ' has-model-spread' : ''}"${d.hasSpread ? ` onclick="showModelTooltip(event, '${d.tooltipData}')"` : ''}>
            <span class="fd-high">${d.highDisplay}</span>
            <span class="fd-divider">/</span>
            <span class="fd-low">${d.lowDisplay}</span>
        </div>
        <div class="fd-grid">
            <div class="fd-stat"><div class="fd-stat-label">Precip Chance</div><div class="fd-stat-value">💧 ${d.precipProb}%</div></div>
            <div class="fd-stat"><div class="fd-stat-label">Precip Volume</div><div class="fd-stat-value">${(() => {
                const snowIn = d.snowfall > 0 ? (d.snowfall / 2.54) : 0;
                const rain = d.precipAmount > 0;
                const snow = snowIn > 0;
                if (rain && snow) return `🌧️ ${d.precipAmount.toFixed(2)}″ ❄️ ${snowIn.toFixed(1)}″`;
                if (snow) return `❄️ ${snowIn.toFixed(1)}″`;
                if (rain) return `🌧️ ${d.precipAmount.toFixed(2)}″`;
                return '0.0″';
            })()}</div></div>
            <div class="fd-stat fd-stat-wind">${renderWindCompass(d.windDegrees, d.windSpeed, d.gustSpeed)}</div>
            <div class="fd-stat">${cachedAQI ? `<div class="fd-stat-label">Air Quality</div><div class="fd-stat-value" style="color:${cachedAQI.color}">${cachedAQI.icon} ${cachedAQI.value}</div><div class="fd-stat-label" style="margin-top:0.2rem">${cachedAQI.level}</div>` : `<div class="fd-stat-label">Air Quality</div><div class="fd-stat-value">—</div>`}</div>
            <div class="fd-stat"><div class="fd-stat-label">Sun</div><div class="fd-stat-value fd-sun-value">↑ ${fmtTime(d.sunrise)}<br>↓ ${fmtTime(d.sunset)}</div></div>
        </div>
        ${nwsHTML}
    `;

    document.getElementById('forecastDetailCounter').textContent = `${index + 1} of ${forecastDays.length}`;
    document.getElementById('forecastPrevBtn').disabled = (index === 0);
    document.getElementById('forecastNextBtn').disabled = (index === forecastDays.length - 1);
}

// Touch swipe support for the forecast detail modal
(function initForecastDetailSwipe() {
    let swipeStartX = 0;
    const modal = document.getElementById('forecastDetailModal');
    modal.addEventListener('touchstart', e => { swipeStartX = e.touches[0].clientX; }, { passive: true });
    modal.addEventListener('touchend', e => {
        const dx = e.changedTouches[0].clientX - swipeStartX;
        if (Math.abs(dx) > 50) navigateForecastDetail(dx < 0 ? 1 : -1);
    }, { passive: true });
})();
