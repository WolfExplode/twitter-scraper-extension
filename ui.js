'use strict';

// Lightweight UI bootstrap for the Twitter scraper.
// All core logic and state lives in `scraper.js`; this file only builds the floating controls and hooks them up.

function waitForBodyReady() {
    // In MV3 content scripts running at document_start, document.body can briefly be null.
    // We wait until <body> exists before appending our UI to avoid racey crashes.
    if (document.body) return Promise.resolve(document.body);
    return new Promise((resolve) => {
        const done = () => resolve(document.body);
        if (document.body) return done();

        try {
            const obs = new MutationObserver(() => {
                if (document.body) {
                    try { obs.disconnect(); } catch { /* ignore */ }
                    done();
                }
            });
            obs.observe(document.documentElement || document, { childList: true, subtree: true });
        } catch { /* ignore */ }

        // Fallback: DOMContentLoaded is late but reliable.
        document.addEventListener('DOMContentLoaded', done, { once: true });
    });
}

// --- UI Setup ---
// Load any saved checkpoint before building UI (so the status line reflects it).
loadRememberScrapedIdsEnabledSetting();
loadRememberedScrapedIds();
loadStartTweetCheckpoint();
loadScrollStepSetting();
loadTranslationSettings();
loadAutoHarvestWithExtensionSetting();
loadVoiceExportSettings();
loadHighlightScrapedSetting();

const uiContainer = document.createElement('div');
uiContainer.style.cssText = 'position:fixed;top:10px;left:10px;z-index:9999;padding:8px;background:rgba(255, 255, 255, 0.9);border:1px solid #ccc;border-radius:6px;box-shadow:0 2px 5px rgba(0,0,0,0.2);display:flex;flex-direction:column;gap:5px;';

const statusLine = document.createElement('div');
statusLine.id = 'wxp-scraper-status';
statusLine.style.cssText = 'font:12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial;max-width:320px;color:#111;';
statusLine.textContent = formatStartTweetStatus();
uiContainer.appendChild(statusLine);

const autoStopRow = document.createElement('label');
autoStopRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
const autoStopCb = document.createElement('input');
autoStopCb.type = 'checkbox';
autoStopCb.checked = autoStopEnabled;
autoStopCb.onchange = () => { autoStopEnabled = autoStopCb.checked; };
autoStopRow.appendChild(autoStopCb);
autoStopRow.appendChild(document.createTextNode('Auto-stop when no new tweets'));
uiContainer.appendChild(autoStopRow);

const autoDlRow = document.createElement('label');
autoDlRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
const autoDlCb = document.createElement('input');
autoDlCb.type = 'checkbox';
autoDlCb.checked = autoDownloadOnAutoStop;
autoDlCb.onchange = () => { autoDownloadOnAutoStop = autoDlCb.checked; };
autoDlRow.appendChild(autoDlCb);
autoDlRow.appendChild(document.createTextNode('Auto-download on auto-stop'));
uiContainer.appendChild(autoDlRow);

// --- Resume support: remember + import/export scraped tweet IDs ---
const rememberRow = document.createElement('label');
rememberRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;flex-wrap:wrap;';
const rememberCb = document.createElement('input');
rememberCb.type = 'checkbox';
rememberCb.checked = !!rememberScrapedIdsEnabled;
const rememberCount = document.createElement('span');
rememberCount.style.cssText = 'color:#374151;';
const updateRememberCount = () => {
    rememberCount.textContent = `stored: ${rememberedScrapedIdSet.size}`;
};
updateRememberCount();
rememberCb.onchange = () => {
    rememberScrapedIdsEnabled = rememberCb.checked;
    saveRememberScrapedIdsEnabledSetting();
    // Re-seed dedupe depending on toggle state.
    scrapedIdSet = rememberScrapedIdsEnabled ? new Set(rememberedScrapedIdSet) : new Set();
    setUiStatus(`Remember scraped IDs: ${rememberScrapedIdsEnabled ? 'ON' : 'OFF'} (${rememberedScrapedIdSet.size})`);
};
rememberRow.appendChild(rememberCb);
rememberRow.appendChild(document.createTextNode('Remember scraped IDs (skip on future runs)'));
rememberRow.appendChild(rememberCount);
uiContainer.appendChild(rememberRow);

const rememberButtonsRow = document.createElement('div');
rememberButtonsRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

const exportIdsBtn = document.createElement('button');
exportIdsBtn.textContent = 'Export IDs';
exportIdsBtn.style.cssText = 'padding:6px 8px;background:#10b981;color:white;border:none;border-radius:4px;cursor:pointer;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
exportIdsBtn.onclick = () => {
    const ctx = computeRunContextFromCurrentPage();
    exportRememberedScrapedIdsToJsonFile(ctx.exportKey || currentRunExportKey || 'account');
    setUiStatus(`Exported scraped IDs (${rememberedScrapedIdSet.size}).`);
};

const importIdsBtn = document.createElement('button');
importIdsBtn.textContent = 'Import IDs';
importIdsBtn.style.cssText = 'padding:6px 8px;background:#3b82f6;color:white;border:none;border-radius:4px;cursor:pointer;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';

const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.json,.txt,application/json,text/plain';
importInput.style.display = 'none';
importInput.onchange = async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    try {
        const res = await importRememberedScrapedIdsFromFile(file);
        updateRememberCount();
        setUiStatus(`Imported IDs: +${res.added} (total stored: ${res.total}).`);
    } catch {
        setUiStatus('Import failed (could not read/parse file).');
    }
};
importIdsBtn.onclick = () => importInput.click();

const clearIdsBtn = document.createElement('button');
clearIdsBtn.textContent = 'Clear IDs';
clearIdsBtn.style.cssText = 'padding:6px 8px;background:#ef4444;color:white;border:none;border-radius:4px;cursor:pointer;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
clearIdsBtn.onclick = () => {
    clearRememberedScrapedIds();
    updateRememberCount();
    // Also clear current run dedupe if it's based on remembered IDs.
    if (rememberScrapedIdsEnabled) scrapedIdSet = new Set();
    setUiStatus('Cleared remembered scraped IDs.');
};

rememberButtonsRow.appendChild(exportIdsBtn);
rememberButtonsRow.appendChild(importIdsBtn);
rememberButtonsRow.appendChild(clearIdsBtn);
rememberButtonsRow.appendChild(importInput);
uiContainer.appendChild(rememberButtonsRow);

const highlightScrapedRow = document.createElement('label');
highlightScrapedRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui;color:#111;user-select:none;';
const highlightScrapedCb = document.createElement('input');
highlightScrapedCb.type = 'checkbox';
highlightScrapedCb.checked = highlightScrapedEnabled;
highlightScrapedCb.onchange = () => {
    highlightScrapedEnabled = highlightScrapedCb.checked;
    saveHighlightScrapedSetting();
    if (highlightScrapedEnabled) {
        highlightAllScrapedTweets();
        startScrapedHighlightObserver();
    } else {
        document.querySelectorAll(`.${SCRAPED_HIGHLIGHT_CLASS}`).forEach(removeScrapedHighlight);
        stopScrapedHighlightObserver();
    }
    setUiStatus(`Highlight scraped tweets: ${highlightScrapedEnabled ? 'ON' : 'OFF'}`);
};
highlightScrapedRow.appendChild(highlightScrapedCb);
highlightScrapedRow.appendChild(document.createTextNode('Highlight scraped tweets'));
uiContainer.appendChild(highlightScrapedRow);

const autoHarvestRow = document.createElement('label');
autoHarvestRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
const autoHarvestCb = document.createElement('input');
autoHarvestCb.type = 'checkbox';
autoHarvestCb.checked = !!autoHarvestWithExtension;
autoHarvestCb.onchange = () => {
    autoHarvestWithExtension = autoHarvestCb.checked;
    saveAutoHarvestWithExtensionSetting();
    if (autoHarvestWithExtension) startHarvestPump();
    else stopHarvestPump();
};
autoHarvestRow.appendChild(autoHarvestCb);
autoHarvestRow.appendChild(document.createTextNode('Auto-harvest via MediaHarvest extension'));
uiContainer.appendChild(autoHarvestRow);

const exportVoiceRow = document.createElement('label');
exportVoiceRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
const exportVoiceCb = document.createElement('input');
exportVoiceCb.type = 'checkbox';
exportVoiceCb.checked = !!exportVoiceYtDlp;
exportVoiceCb.onchange = () => {
    exportVoiceYtDlp = exportVoiceCb.checked;
    saveVoiceExportSettings();
};
exportVoiceRow.appendChild(exportVoiceCb);
exportVoiceRow.appendChild(document.createTextNode('generate a list of media that requires manual download'));
uiContainer.appendChild(exportVoiceRow);

const cookiesRow = document.createElement('label');
cookiesRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
cookiesRow.appendChild(document.createTextNode('yt-dlp cookies browser:'));
const cookiesInput = document.createElement('input');
cookiesInput.type = 'text';
cookiesInput.value = String(ytDlpCookiesBrowser || DEFAULT_YTDLP_COOKIES_BROWSER);
cookiesInput.placeholder = 'firefox / chrome / edge ...';
cookiesInput.style.cssText = 'width:110px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
cookiesInput.onchange = () => {
    ytDlpCookiesBrowser = String(cookiesInput.value || '').trim() || DEFAULT_YTDLP_COOKIES_BROWSER;
    cookiesInput.value = ytDlpCookiesBrowser;
    saveVoiceExportSettings();
};
cookiesRow.appendChild(cookiesInput);
uiContainer.appendChild(cookiesRow);

const translateWaitRow = document.createElement('label');
translateWaitRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
const translateWaitCb = document.createElement('input');
translateWaitCb.type = 'checkbox';
translateWaitCb.checked = !!waitForImmersiveTranslate;
translateWaitCb.onchange = () => {
    waitForImmersiveTranslate = translateWaitCb.checked;
    saveTranslationSettings();
};
translateWaitRow.appendChild(translateWaitCb);
translateWaitRow.appendChild(document.createTextNode('Wait for Immersive Translate'));
uiContainer.appendChild(translateWaitRow);

const translateWaitMsRow = document.createElement('label');
translateWaitMsRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
translateWaitMsRow.appendChild(document.createTextNode('Translation wait (ms):'));
const translateWaitMsInput = document.createElement('input');
translateWaitMsInput.type = 'number';
translateWaitMsInput.min = String(MIN_TRANSLATION_WAIT_MS);
translateWaitMsInput.max = String(MAX_TRANSLATION_WAIT_MS);
translateWaitMsInput.step = '100';
translateWaitMsInput.value = String(getTranslationWaitMs());
translateWaitMsInput.style.cssText = 'width:86px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
translateWaitMsInput.onchange = () => {
    translationWaitMs = clampNumber(parseInt(translateWaitMsInput.value, 10), MIN_TRANSLATION_WAIT_MS, MAX_TRANSLATION_WAIT_MS);
    translateWaitMsInput.value = String(getTranslationWaitMs());
    saveTranslationSettings();
};
translateWaitMsRow.appendChild(translateWaitMsInput);
uiContainer.appendChild(translateWaitMsRow);

const scrollStepRow = document.createElement('label');
scrollStepRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
scrollStepRow.appendChild(document.createTextNode('Scroll step (px):'));
const scrollStepInput = document.createElement('input');
scrollStepInput.type = 'number';
scrollStepInput.min = String(MIN_SCROLL_STEP_PX);
scrollStepInput.max = String(MAX_SCROLL_STEP_PX);
scrollStepInput.step = '50';
scrollStepInput.value = String(getScrollStepPx());
scrollStepInput.style.cssText = 'width:86px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
scrollStepInput.onchange = () => {
    scrollStepPx = clampNumber(parseInt(scrollStepInput.value, 10), MIN_SCROLL_STEP_PX, MAX_SCROLL_STEP_PX);
    scrollStepInput.value = String(getScrollStepPx());
    saveScrollStepSetting();
};
scrollStepRow.appendChild(scrollStepInput);
uiContainer.appendChild(scrollStepRow);

const pickStartButton = document.createElement('button');
pickStartButton.textContent = 'Pick start tweet';
pickStartButton.style.cssText = 'padding:8px;background:#6b7280;color:white;border:none;border-radius:4px;cursor:pointer;';
pickStartButton.onclick = () => {
    // Avoid fighting scroll/hover while in picker mode.
    stopAutoScrollToText('Auto-scroll: stopped (picker mode).');
    if (isPickingStartTweet) {
        stopPickingMode();
        return;
    }
    startPickingMode();
};
uiContainer.appendChild(pickStartButton);

const clearStartButton = document.createElement('button');
clearStartButton.textContent = 'Clear start tweet';
clearStartButton.style.cssText = 'padding:8px;background:#9ca3af;color:white;border:none;border-radius:4px;cursor:pointer;';
clearStartButton.onclick = () => {
    stopPickingMode();
    clearStartTweetSelection();
};
uiContainer.appendChild(clearStartButton);

// --- QoL: Auto-scroll until a specific text is rendered in a tweet ---
const autoScrollLabel = document.createElement('div');
autoScrollLabel.style.cssText = 'font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;margin-top:4px;';
autoScrollLabel.textContent = 'Auto-scroll to text (stops when found):';
uiContainer.appendChild(autoScrollLabel);

const autoScrollRow = document.createElement('div');
autoScrollRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

const autoScrollInput = document.createElement('input');
autoScrollInput.type = 'text';
autoScrollInput.placeholder = 'Paste a snippet from the target tweet…';
autoScrollInput.style.cssText = 'flex:1;min-width:180px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:4px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';

const autoScrollBtn = document.createElement('button');
autoScrollBtn.id = 'wxp-autoscroll-btn';
autoScrollBtn.textContent = 'Scroll to text';
autoScrollBtn.style.cssText = 'padding:8px;background:#f59e0b;color:#111;border:none;border-radius:4px;cursor:pointer;white-space:nowrap;';
autoScrollBtn.onclick = () => startAutoScrollToText(autoScrollInput.value);

autoScrollInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        autoScrollBtn.click();
    }
});

autoScrollRow.appendChild(autoScrollInput);
autoScrollRow.appendChild(autoScrollBtn);
uiContainer.appendChild(autoScrollRow);

const autoScrollStatus = document.createElement('div');
autoScrollStatus.id = 'wxp-autoscroll-status';
autoScrollStatus.style.cssText = 'font:12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial;max-width:320px;color:#111;';
autoScrollStatus.textContent = 'Auto-scroll: idle.';
uiContainer.appendChild(autoScrollStatus);

const startButton = document.createElement('button');
startButton.textContent = 'Start Scraping';
startButton.style.cssText = 'padding:8px;background:#1da1f2;color:white;border:none;border-radius:4px;cursor:pointer;';
startButton.onclick = () => {
    stopAutoScrollToText('Auto-scroll: stopped (scraper started).');
    startScraping();
};
uiContainer.appendChild(startButton);

const stopButton = document.createElement('button');
stopButton.textContent = 'Stop and Download';
stopButton.style.cssText = 'padding:8px;background:#e0245e;color:white;border:none;border-radius:4px;cursor:pointer;';
stopButton.onclick = stopAndDownload;
uiContainer.appendChild(stopButton);

waitForBodyReady().then(() => {
    // Avoid duplicate UI if X's SPA re-injects the script in some edge cases.
    if (!document.getElementById('wxp-scraper-status')) {
        document.body.appendChild(uiContainer);
    }
    if (highlightScrapedEnabled) {
        highlightAllScrapedTweets();
        startScrapedHighlightObserver();
    }
}).catch(() => {
    // As a last resort, try append immediately.
    try { document.body && document.body.appendChild(uiContainer); } catch { /* ignore */ }
});

// Global picker listeners (capture so we can stop click navigation reliably)
document.addEventListener('mousemove', onPickerMouseMove, true);
document.addEventListener('click', onPickerClick, true);
document.addEventListener('keydown', onPickerKeyDown, true);


