// Share current conditions card as image or text
// Globals used: activeLocation
// External dep: html2canvas (CDN)
// Utils: extractDisplayName (src/utils/dom.js)

// CSS overrides for share capture — hardcoded colors (no var() references)
// so html2canvas can resolve them reliably on iOS Safari
function getShareStyleOverrides() {
    return `
        .share-capture-root {
            filter: brightness(1.12);
        }
        .share-capture-root .card {
            background: #131826;
            border-color: rgba(255, 255, 255, 0.1);
        }
        .share-capture-root .card-header {
            border-bottom-color: rgba(255, 255, 255, 0.25);
        }
        .share-capture-root .card-title {
            font-family: 'Bebas Neue', cursive;
            color: #5ef0ff;
        }
        .share-capture-root .source-badge {
            color: #5ef0ff;
            border-color: #5ef0ff;
            background: rgba(94, 240, 255, 0.3);
        }
        .share-capture-root .temperature {
            background: none;
            -webkit-background-clip: unset;
            background-clip: unset;
            -webkit-text-fill-color: #5ef0ff;
            color: #5ef0ff;
        }
        .share-capture-root .weather-icon {
            filter: brightness(1.8);
        }
        .share-capture-root .detail-label {
            color: #cdd5e2;
        }
        .share-capture-root .detail-value {
            color: #ffffff;
            -webkit-text-fill-color: #ffffff;
        }
        .share-capture-root .moon-phase-row {
            border-top-color: rgba(255, 255, 255, 0.25);
        }
        .share-capture-root .moon-phase-name {
            color: #ffffff;
        }
        .share-capture-root .moon-details {
            color: #b0b8c8;
        }
        .share-capture-root .moon-icon {
            filter: brightness(1.8);
        }
        .share-capture-root .moon-direction {
            color: #ffcc44;
        }
        .share-capture-root .moon-direction.waning {
            color: #5ef0ff;
        }
        .share-capture-root .moon-col-time .detail-label {
            color: #cdd5e2;
        }
        .share-capture-root .moon-col-time .detail-value {
            color: #ffffff;
        }
        .share-capture-root .alert-banner.severity-active {
            background: linear-gradient(135deg, rgba(255, 0, 0, 0.2), rgba(255, 107, 0, 0.15));
            border-color: rgba(255, 68, 68, 0.6);
        }
        .share-capture-root .alert-banner.severity-upcoming {
            background: linear-gradient(135deg, rgba(255, 193, 7, 0.15), rgba(255, 152, 0, 0.1));
            border-color: rgba(255, 193, 7, 0.5);
        }
        .share-capture-root .alert-banner-event {
            color: #ff9999;
        }
        .share-capture-root .alert-banner.severity-upcoming .alert-banner-event {
            color: #ffe082;
        }
        .share-capture-root .alert-banner-count,
        .share-capture-root .alert-banner-arrow {
            color: #cdd5e2;
        }
        .share-capture-root .alert-banner-icon {
            filter: brightness(1.8);
            animation: none;
        }
        .share-capture-root .nws-label {
            color: #5ef0ff;
        }
        .share-capture-root .nws-text {
            color: #dde3ee;
        }
        .share-capture-root .snow-info {
            color: #e0f4ff;
            filter: brightness(1.5);
        }
    `;
}

// Flatten canvas onto an opaque background — removes any alpha channel
// so iOS won't dim the shared image
function flattenToOpaqueCanvas(srcCanvas, bg = '#131826') {
    const out = document.createElement('canvas');
    out.width = srcCanvas.width;
    out.height = srcCanvas.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(srcCanvas, 0, 0);
    // Subtle border helps iOS thumbnail heuristics
    ctx.strokeStyle = '#2a3145';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, out.width - 2, out.height - 2);
    return out;
}

// Clone-based card capture — avoids modifying the live DOM and
// ensures html2canvas sees resolved (non-variable) CSS on all platforms
async function captureCardAsCanvas(card) {
    const clone = card.cloneNode(true);

    const shareBtn = clone.querySelector('.share-btn');
    if (shareBtn) shareBtn.remove();

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:fixed;inset:0;opacity:0;pointer-events:none;z-index:2147483647;';

    const styleEl = document.createElement('style');
    styleEl.textContent = getShareStyleOverrides();
    wrapper.appendChild(styleEl);

    const container = document.createElement('div');
    container.className = 'share-capture-root';
    container.style.cssText = `position:absolute;left:0;top:0;width:${card.offsetWidth}px;background:#131826;`;
    container.appendChild(clone);
    wrapper.appendChild(container);

    document.body.appendChild(wrapper);

    // Double rAF ensures layout is fully committed (more reliable than offsetHeight on iOS)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const canvas = await html2canvas(container, {
        backgroundColor: '#131826',
        scale: 2,
        useCORS: true,
        logging: false
    });

    document.body.removeChild(wrapper);
    return canvas;
}

async function shareCurrentCard() {
    const card = document.querySelector('.card:not(.forecast-card):not(.satellite-card)');
    if (!card) return;

    const btn = document.querySelector('.share-btn');
    const origHTML = btn ? btn.innerHTML : '';

    if (btn) {
        btn.innerHTML = '<span style="display:inline-block;animation:spin 0.8s linear infinite;">↻</span>';
        btn.disabled = true;
    }

    const loc = activeLocation ? extractDisplayName(activeLocation.name) : 'Unknown';

    try {
        const canvas = await captureCardAsCanvas(card);
        const flat = flattenToOpaqueCanvas(canvas, '#131826');

        const blob = await new Promise(resolve => flat.toBlob(resolve, 'image/jpeg', 0.92));
        const file = new File([blob], `weather-${loc.replace(/\s+/g, '-').toLowerCase()}.jpg`, { type: 'image/jpeg' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({
                title: `Weather in ${loc}`,
                text: `Current weather in ${loc}`,
                files: [file]
            });
        } else if (navigator.share) {
            const shareText = buildShareText(card, loc);
            await navigator.share({ title: `Weather in ${loc}`, text: shareText });
        } else {
            // Desktop fallback: download the image
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `weather-${loc.replace(/\s+/g, '-').toLowerCase()}.jpg`;
            a.click();
            URL.revokeObjectURL(url);
            showShareSuccess(btn, origHTML);
            return;
        }
    } catch (err) {
        if (err.name !== 'AbortError') console.log('Share error:', err);
    } finally {
        if (btn) {
            btn.innerHTML = origHTML;
            btn.disabled = false;
        }
    }
}

function buildShareText(card, loc) {
    const tempEl = card.querySelector('.temperature');
    const temp = tempEl ? tempEl.textContent.trim() : '';
    const details = card.querySelectorAll('.detail-item');
    let lines = [`🌡️ Weather in ${loc}: ${temp}`];
    details.forEach(item => {
        const label = item.querySelector('.detail-label');
        const value = item.querySelector('.detail-value');
        if (label && value) {
            lines.push(`${label.textContent.trim()}: ${value.textContent.trim()}`);
        }
    });
    lines.push(`\n— Weather Command Center`);
    return lines.join('\n');
}

function showShareSuccess(btn, origHTML) {
    if (btn) {
        btn.innerHTML = '✓';
        btn.style.color = '#4caf50';
        setTimeout(() => { btn.innerHTML = origHTML; btn.style.color = ''; }, 1500);
    }
}
