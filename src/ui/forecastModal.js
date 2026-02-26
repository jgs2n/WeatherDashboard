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
        <div class="fd-day-name">${d.fullDayName}</div>
        <div class="fd-date">${d.dateDisplay}</div>
        <div class="fd-icon">${d.icon}</div>
        <div class="fd-condition">${d.desc}</div>
        <div class="fd-temps">
            <span class="fd-high">${d.highDisplay}</span>
            <span class="fd-divider">/</span>
            <span class="fd-low">${d.lowDisplay}</span>
        </div>
        <div class="fd-grid">
            ${d.precipProb > 0 ? `<div class="fd-stat"><div class="fd-stat-label">Precip</div><div class="fd-stat-value">💧 ${d.precipProb}%${d.precipAmount > 0 ? ` · ${d.precipAmount.toFixed(1)}″` : ''}</div></div>` : ''}
            ${d.snowfall > 0 ? `<div class="fd-stat"><div class="fd-stat-label">Snow</div><div class="fd-stat-value">❄️ ${(d.snowfall / 2.54).toFixed(1)}″</div></div>` : ''}
            <div class="fd-stat fd-stat-wind">${renderWindCompass(d.windDegrees, d.windSpeed, d.gustSpeed)}</div>
            ${(d.uvMax != null || cachedAQI) ? `
            <div class="fd-stat-paired">
                ${d.uvMax != null ? `<div class="fd-stat"><div class="fd-stat-label">UV Index</div><div class="fd-stat-value">${d.uvMax}</div></div>` : '<div></div>'}
                ${cachedAQI ? `<div class="fd-stat"><div class="fd-stat-label">Air Quality</div><div class="fd-stat-value" style="color:${cachedAQI.color}">${cachedAQI.icon} ${cachedAQI.value}</div><div class="fd-stat-label" style="margin-top:0.2rem">${cachedAQI.level}</div></div>` : '<div></div>'}
            </div>` : ''}
            ${(d.sunrise || d.sunset) ? `
            <div class="fd-stat-paired">
                ${d.sunrise ? `<div class="fd-stat"><div class="fd-stat-label">Sunrise</div><div class="fd-stat-value">🌅 ${fmtTime(d.sunrise)}</div></div>` : '<div></div>'}
                ${d.sunset ? `<div class="fd-stat"><div class="fd-stat-label">Sunset</div><div class="fd-stat-value">🌇 ${fmtTime(d.sunset)}</div></div>` : '<div></div>'}
            </div>` : ''}
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
