// Tab drag/reorder — touch long-press state machine + desktop HTML5 drag
// Globals consumed (from store.js): savedLocations, isTouchDevice, saveLocations()
// Globals consumed (from index.html inline script): renderTabs()
// No imports or exports — classic global script.

// ===== TOUCH LONG-PRESS REORDER SYSTEM =====
let touchDragState = {
    timer: null,
    isDragging: false,
    editMode: false,
    editModeTimer: null,
    editModeClickHandler: null,
    dragIndex: null,
    clone: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    tabs: [],
    scrollContainer: null,
    prevented: false,
    longPressTab: null,
    longPressIndex: null,
    longPressTouch: null,
    dragStartedFromEditMode: false
};

function exitEditMode() {
    document.getElementById('locationTabs').classList.remove('edit-mode');
    touchDragState.editMode = false;
    clearTimeout(touchDragState.editModeTimer);
    if (touchDragState.editModeClickHandler) {
        document.removeEventListener('click', touchDragState.editModeClickHandler);
        touchDragState.editModeClickHandler = null;
    }
}

function initTouchReorder() {
    const tabs = document.querySelectorAll('.location-tab:not(.add-tab)');
    tabs.forEach(tab => {
        tab.addEventListener('touchstart', onTouchStart, { passive: false });
        tab.addEventListener('touchmove', onTouchMove, { passive: false });
        tab.addEventListener('touchend', onTouchEnd, { passive: false });
        tab.addEventListener('touchcancel', onTouchEnd, { passive: false });
    });
}

function onTouchStart(e) {
    const tab = e.currentTarget;
    const index = parseInt(tab.dataset.index);
    if (isNaN(index)) return;

    const touch = e.touches[0];
    touchDragState.startX = touch.clientX;
    touchDragState.startY = touch.clientY;
    touchDragState.prevented = false;
    touchDragState.longPressTab = tab;
    touchDragState.longPressIndex = index;
    touchDragState.longPressTouch = { clientX: touch.clientX, clientY: touch.clientY };

    // Long-press timer (2000ms) → enter edit mode
    touchDragState.timer = setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate(50);
        touchDragState.editMode = true;
        touchDragState.prevented = true;
        document.getElementById('locationTabs').classList.add('edit-mode');

        // Auto-exit after 5 seconds
        clearTimeout(touchDragState.editModeTimer);
        touchDragState.editModeTimer = setTimeout(exitEditMode, 5000);

        // Exit on outside tap (delayed to avoid catching this touch)
        setTimeout(() => {
            const handler = function(evt) {
                if (!evt.target.closest('.remove-btn') && !evt.target.closest('.remove-btn.confirm')) {
                    exitEditMode();
                    document.removeEventListener('click', handler);
                    touchDragState.editModeClickHandler = null;
                }
            };
            touchDragState.editModeClickHandler = handler;
            document.addEventListener('click', handler);
        }, 300);
    }, 2000);
}

function onTouchMove(e) {
    const touch = e.touches[0];

    // If already dragging, move the clone
    if (touchDragState.isDragging) {
        e.preventDefault();
        e.stopPropagation();
        const x = touch.clientX - touchDragState.offsetX;
        const y = touch.clientY;
        touchDragState.clone.style.left = x + 'px';
        touchDragState.clone.style.top = (y - 25) + 'px';
        highlightDropTarget(touch.clientX, touch.clientY);
        return;
    }

    const dx = Math.abs(touch.clientX - touchDragState.startX);
    const dy = Math.abs(touch.clientY - touchDragState.startY);

    // If in edit mode (long press fired) and finger moves, transition to drag
    // Keep edit-mode class active so × buttons stay visible during drag
    if (touchDragState.editMode && !touchDragState.isDragging && (dx > 10 || dy > 10)) {
        touchDragState.dragStartedFromEditMode = true;
        touchDragState.editMode = false; // prevent re-entrancy but keep CSS class
        clearTimeout(touchDragState.editModeTimer); // pause auto-exit during drag
        if (touchDragState.editModeClickHandler) {
            document.removeEventListener('click', touchDragState.editModeClickHandler);
            touchDragState.editModeClickHandler = null;
        }
        startTouchDrag(touchDragState.longPressTab, touchDragState.longPressIndex, touchDragState.longPressTouch);
        return;
    }

    // If moved before long-press fires, cancel it (allow normal scroll)
    if (dx > 10 || dy > 10) {
        clearTimeout(touchDragState.timer);
    }
}

function onTouchEnd(e) {
    clearTimeout(touchDragState.timer);

    if (touchDragState.isDragging) {
        e.preventDefault();
        e.stopPropagation();
        completeTouchDrag();
        return;
    }

    // If in edit mode (long press fired, no drag), stay in edit mode
    // The X buttons are now visible for the user to tap
    if (touchDragState.editMode) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }
}

function startTouchDrag(tab, index, touch) {
    touchDragState.isDragging = true;
    touchDragState.dragIndex = index;

    // Haptic feedback if available
    if (navigator.vibrate) navigator.vibrate(50);

    // Create floating clone
    const rect = tab.getBoundingClientRect();
    const clone = tab.cloneNode(true);
    clone.className = 'location-tab touch-drag-clone';
    clone.style.cssText = `
        position: fixed;
        left: ${rect.left}px;
        top: ${rect.top}px;
        width: ${rect.width}px;
        z-index: 10001;
        opacity: 0.9;
        transform: scale(1.05);
        box-shadow: 0 8px 25px rgba(0,0,0,0.5);
        border: 2px solid var(--accent-primary);
        pointer-events: none;
        transition: none;
    `;
    document.body.appendChild(clone);
    touchDragState.clone = clone;
    touchDragState.offsetX = touch.clientX - rect.left;

    // Dim the original tab
    tab.classList.add('touch-drag-source');

    // Mark all tabs for drop targeting
    touchDragState.tabs = Array.from(document.querySelectorAll('.location-tab:not(.add-tab)'));

    // Prevent the tab's onclick from firing
    touchDragState.prevented = true;
}

function highlightDropTarget(cx, cy) {
    let closestIdx = -1;
    let closestDist = Infinity;

    touchDragState.tabs.forEach((tab, i) => {
        tab.classList.remove('touch-drag-over');
        const r = tab.getBoundingClientRect();
        const tabCx = r.left + r.width / 2;
        const dist = Math.abs(cx - tabCx);
        if (dist < closestDist) {
            closestDist = dist;
            closestIdx = i;
        }
    });

    if (closestIdx >= 0 && closestIdx !== touchDragState.dragIndex) {
        touchDragState.tabs[closestIdx].classList.add('touch-drag-over');
    }
}

function completeTouchDrag() {
    // Remember if this drag came from edit mode before resetting state
    const wasEditing = touchDragState.dragStartedFromEditMode;

    // Find which tab we're dropping on
    const overTab = touchDragState.tabs.find(t => t.classList.contains('touch-drag-over'));

    if (overTab) {
        const dropIndex = parseInt(overTab.dataset.index);
        const dragIndex = touchDragState.dragIndex;

        if (!isNaN(dropIndex) && dragIndex !== dropIndex) {
            const dragged = savedLocations[dragIndex];
            savedLocations.splice(dragIndex, 1);
            savedLocations.splice(dropIndex, 0, dragged);
            saveLocations();
            if (navigator.vibrate) navigator.vibrate(30);
        }
    }

    // Clean up
    if (touchDragState.clone) {
        touchDragState.clone.remove();
    }
    touchDragState.tabs.forEach(t => {
        t.classList.remove('touch-drag-over');
        t.classList.remove('touch-drag-source');
    });

    touchDragState.isDragging = false;
    touchDragState.dragIndex = null;
    touchDragState.clone = null;
    touchDragState.dragStartedFromEditMode = false;

    renderTabs();

    // Re-enter edit mode so the user can keep sorting/deleting without re-long-pressing
    if (wasEditing) {
        document.getElementById('locationTabs').classList.add('edit-mode');
        touchDragState.editMode = true;
        clearTimeout(touchDragState.editModeTimer);
        touchDragState.editModeTimer = setTimeout(exitEditMode, 5000);

        // Re-register tap-outside handler
        setTimeout(() => {
            const handler = function(evt) {
                if (!evt.target.closest('.remove-btn') && !evt.target.closest('.remove-btn.confirm')) {
                    exitEditMode();
                    document.removeEventListener('click', handler);
                    touchDragState.editModeClickHandler = null;
                }
            };
            touchDragState.editModeClickHandler = handler;
            document.addEventListener('click', handler);
        }, 300);
    }
}

// ===== DESKTOP HTML5 DRAG AND DROP =====
let draggedIndex = null;

function handleDragStart(event, index) {
    draggedIndex = index;
    event.currentTarget.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = event.currentTarget;
    if (target.classList.contains('location-tab') && !target.classList.contains('add-tab')) {
        target.classList.add('drag-over');
    }
}

function handleDrop(event, dropIndex) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');

    if (draggedIndex === null || draggedIndex === dropIndex) return;

    // Reorder the locations array
    const draggedLocation = savedLocations[draggedIndex];
    savedLocations.splice(draggedIndex, 1);
    savedLocations.splice(dropIndex, 0, draggedLocation);

    saveLocations();
    renderTabs();
}

function handleDragEnd(event) {
    event.currentTarget.classList.remove('dragging');
    // Remove drag-over class from all tabs
    document.querySelectorAll('.location-tab').forEach(tab => {
        tab.classList.remove('drag-over');
    });
    draggedIndex = null;
}
