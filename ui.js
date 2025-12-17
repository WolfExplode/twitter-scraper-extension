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
loadSearchRunSettings();
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

const clearPageIdsBtn = document.createElement('button');
clearPageIdsBtn.textContent = 'Clear IDs (this page only)';
clearPageIdsBtn.style.cssText = 'padding:6px 8px;background:#f97316;color:white;border:none;border-radius:4px;cursor:pointer;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
clearPageIdsBtn.onclick = () => {
    if (typeof clearRememberedScrapedIdsForCurrentPage === 'function') {
        clearRememberedScrapedIdsForCurrentPage();
        updateRememberCount();
    } else {
        setUiStatus('Per-page ID clearing is not available in this build.');
    }
};

rememberButtonsRow.appendChild(exportIdsBtn);
rememberButtonsRow.appendChild(importIdsBtn);
rememberButtonsRow.appendChild(clearIdsBtn);
rememberButtonsRow.appendChild(clearPageIdsBtn);
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

const searchRunLimitRow = document.createElement('label');
searchRunLimitRow.style.cssText = 'display:flex;align-items:center;gap:6px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';
searchRunLimitRow.appendChild(document.createTextNode('Max /status posts per search run:'));
const searchRunLimitInput = document.createElement('input');
searchRunLimitInput.type = 'number';
searchRunLimitInput.min = String(MIN_SEARCH_RUN_MAX_STATUS_POSTS);
searchRunLimitInput.max = String(MAX_SEARCH_RUN_MAX_STATUS_POSTS);
searchRunLimitInput.step = '50';
searchRunLimitInput.value = String(getSearchRunMaxStatusPosts());
searchRunLimitInput.style.cssText = 'width:86px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:4px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;';
searchRunLimitInput.onchange = () => {
    searchRunMaxStatusPosts = clampNumber(
        parseInt(searchRunLimitInput.value, 10),
        MIN_SEARCH_RUN_MAX_STATUS_POSTS,
        MAX_SEARCH_RUN_MAX_STATUS_POSTS
    );
    searchRunLimitInput.value = String(getSearchRunMaxStatusPosts());
    saveSearchRunSettings();
};
searchRunLimitRow.appendChild(searchRunLimitInput);
uiContainer.appendChild(searchRunLimitRow);

// --- Search date range controls (since:/until:) ---
try {
    const mode = typeof getPageModeFromLocation === 'function' ? getPageModeFromLocation() : 'other';
    const canShiftDates =
        (mode === 'search' || mode === 'search_advanced') &&
        typeof shiftCurrentSearchDateRange === 'function' &&
        typeof describeCurrentSearchDateRange === 'function';

    if (canShiftDates) {
        const rangeRow = document.createElement('div');
        rangeRow.style.cssText =
            'display:flex;align-items:center;gap:4px;font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;color:#111;user-select:none;';

        const label = document.createElement('span');
        label.textContent = 'Search date range:';
        rangeRow.appendChild(label);

        const leftBtn = document.createElement('button');
        leftBtn.textContent = '←';
        leftBtn.title = 'Shift range ~1 window earlier';
        leftBtn.style.cssText =
            'padding:2px 6px;background:#e5e7eb;color:#111;border:1px solid #d1d5db;border-radius:4px;cursor:pointer;';

        const rightBtn = document.createElement('button');
        rightBtn.textContent = '→';
        rightBtn.title = 'Shift range ~1 window later';
        rightBtn.style.cssText =
            'padding:2px 6px;background:#e5e7eb;color:#111;border:1px solid #d1d5db;border-radius:4px;cursor:pointer;';

        const rangeText = document.createElement('span');
        rangeText.style.cssText =
            'margin-left:4px;color:#374151;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

        const refreshRangeText = () => {
            try {
                const desc = describeCurrentSearchDateRange?.() || '';
                rangeText.textContent = desc || '(no since:/until: in query)';
            } catch {
                rangeText.textContent = '(date range unavailable)';
            }
        };

        leftBtn.onclick = () => {
            try {
                shiftCurrentSearchDateRange(-1);
            } catch {
                /* ignore */
            }
        };
        rightBtn.onclick = () => {
            try {
                shiftCurrentSearchDateRange(1);
            } catch {
                /* ignore */
            }
        };

        rangeRow.appendChild(leftBtn);
        rangeRow.appendChild(rightBtn);
        rangeRow.appendChild(rangeText);

        uiContainer.appendChild(rangeRow);
        refreshRangeText();
    }
} catch {
    // Ignore UI errors: never break the page if helpers are missing.
}

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
startButton.style.cssText = 'padding:8px;background:#1da1f2;color:white;border:none;border-radius:4px;cursor:pointer;';
uiContainer.appendChild(startButton);

function refreshStartButtonLabelAndBehavior() {
    // Default baseline: simple "Start Scraping" behaviour.
    const setDefault = () => {
        startButton.disabled = false;
        startButton.textContent = 'Start Scraping';
        startButton.onclick = () => {
            stopAutoScrollToText('Auto-scroll: stopped (scraper started).');
            startScraping();
        };
    };

    try {
        const ctx = typeof computeRunContextFromCurrentPage === 'function'
            ? computeRunContextFromCurrentPage()
            : null;
        const state = typeof loadSearchRunState === 'function'
            ? loadSearchRunState()
            : null;

        const hasSearchQueue =
            !!(state && !state.done && Array.isArray(state.tweetQueue) && state.tweetQueue.length > 0);
        const isPaused = !!(state && state.paused);

        // Non-search pages or no search run state: keep legacy "Start Scraping".
        if (!ctx || !(ctx.mode === 'search' || ctx.mode === 'search_advanced' || ctx.mode === 'status') || !hasSearchQueue) {
            setDefault();
            return;
        }

        // On the search page itself: when paused, "Start" becomes "Resume".
        if (ctx.mode === 'search' || ctx.mode === 'search_advanced') {
            startButton.disabled = false;
            if (isPaused) {
                startButton.textContent = 'Resume search run';
                startButton.onclick = () => {
                    stopAutoScrollToText('Auto-scroll: stopped (resuming search run).');
                    startScraping();
                };
            } else {
                setDefault();
            }
            return;
        }

        // On a status page that is part of the active search run:
        if (ctx.mode === 'status') {
            const currentUrl = normalizeStatusUrl(window.location?.href || '');
            const idx = Number.isFinite(state.currentIndex) ? (state.currentIndex | 0) : 0;
            const target =
                state.tweetQueue[idx] ||
                state.tweetQueue.find(u => normalizeStatusUrl(u) === currentUrl);
            const isCurrent = !!(target && normalizeStatusUrl(target) === currentUrl);

            if (isCurrent && typeof pauseSearchRunAfterCurrentPage === 'function') {
                // Repurpose the start button as a pause/resume toggle for search runs.
                startButton.disabled = false;
                if (isPaused) {
                    startButton.textContent = 'Resume after this page';
                } else {
                    startButton.textContent = 'Pause after this page';
                }
                startButton.onclick = () => {
                    pauseSearchRunAfterCurrentPage();
                    // Recompute label based on the new paused state.
                    try { refreshStartButtonLabelAndBehavior(); } catch { /* ignore */ }
                };
                return;
            }

            // Fallback: behave like a plain start button.
            setDefault();
            return;
        }

        // Fallback for any unexpected mode.
        setDefault();
    } catch {
        setDefault();
    }
}

refreshStartButtonLabelAndBehavior();

const stopButton = document.createElement('button');
stopButton.textContent = 'Stop and Download';
stopButton.style.cssText = 'padding:8px;background:#e0245e;color:white;border:none;border-radius:4px;cursor:pointer;';
stopButton.onclick = () => stopAndDownload({ cancelAll: true });
uiContainer.appendChild(stopButton);

const cancelSearchRunButton = document.createElement('button');
cancelSearchRunButton.textContent = 'Cancel search run';
cancelSearchRunButton.style.cssText = 'padding:8px;background:#b91c1c;color:white;border:none;border-radius:4px;cursor:pointer;';
cancelSearchRunButton.onclick = () => {
    try {
        if (typeof cancelSearchRun === 'function') {
            cancelSearchRun();
        } else {
            setUiStatus('Search run cancel is not available in this build.');
        }
    } catch {
        setUiStatus('Failed to cancel search run.');
    }
};
uiContainer.appendChild(cancelSearchRunButton);

const exportSearchMediaBtn = document.createElement('button');
exportSearchMediaBtn.textContent = 'Download search media lists';
exportSearchMediaBtn.style.cssText = 'padding:8px;background:#0f766e;color:white;border:none;border-radius:4px;cursor:pointer;';
exportSearchMediaBtn.onclick = () => {
    try {
        const agg = typeof loadSearchAggregate === 'function' ? loadSearchAggregate() : null;
        if (!agg || !Array.isArray(agg.tweets) || agg.tweets.length === 0) {
            setUiStatus('No aggregated search media to export yet.');
            return;
        }
        const ownerHandle = agg.ownerHandle || '';
        const keySource = ownerHandle || agg.exportKey || 'account';
        const account = typeof handleToExportKey === 'function' ? handleToExportKey(keySource) : keySource;

        // Export a single combined set of avatar + voice media helpers for the whole search run.
        if (typeof exportVoiceTweetUrlListFile === 'function' && typeof exportVoiceYtDlp !== 'undefined' && exportVoiceYtDlp) {
            try { exportVoiceTweetUrlListFile(agg.tweets, account); } catch { /* ignore */ }
        }
        if (typeof exportAvatarDownloadFiles === 'function') {
            try { exportAvatarDownloadFiles(agg.tweets, account); } catch { /* ignore */ }
        }
        if (typeof exportCombinedDownloadMediaRunner === 'function') {
            try { exportCombinedDownloadMediaRunner(account); } catch { /* ignore */ }
        }

        setUiStatus(`Exported search media lists from ${agg.tweets.length} tweets.`);
    } catch {
        setUiStatus('Failed to export aggregated search media lists.');
    }
};
uiContainer.appendChild(exportSearchMediaBtn);

waitForBodyReady().then(() => {
    // Avoid duplicate UI if X's SPA re-injects the script in some edge cases.
    if (!document.getElementById('wxp-scraper-status')) {
        document.body.appendChild(uiContainer);
    }
    if (highlightScrapedEnabled) {
        highlightAllScrapedTweets();
        startScrapedHighlightObserver();
    }
    // If we are on a status page as part of an active search run, auto-start scraping.
    try {
        const ctx = computeRunContextFromCurrentPage?.();
        if (ctx && ctx.mode === 'status') {
            const state = loadSearchRunState?.();
            if (state && !state.done && !state.paused && Array.isArray(state.tweetQueue) && state.tweetQueue.length > 0) {
                const currentUrl = normalizeStatusUrl(window.location?.href || '');
                const idx = Number.isFinite(state.currentIndex) ? state.currentIndex | 0 : 0;
                const target = state.tweetQueue[idx] || state.tweetQueue.find(u => normalizeStatusUrl(u) === currentUrl);
                if (target && normalizeStatusUrl(target) === currentUrl) {
                    // Auto-start only once per page to avoid accidental double runs.
                    if (!window.__wxp_auto_started_search_status) {
                        window.__wxp_auto_started_search_status = true;
                        startScraping();
                    }
                }
            }
        }

        // Re-sync the primary control labels now that the page + state are known.
        try { refreshStartButtonLabelAndBehavior(); } catch { /* ignore */ }
    } catch {
        // ignore auto-start errors
    }
}).catch(() => {
    // As a last resort, try append immediately.
    try { document.body && document.body.appendChild(uiContainer); } catch { /* ignore */ }
});

// Global picker listeners (capture so we can stop click navigation reliably)
document.addEventListener('mousemove', onPickerMouseMove, true);
document.addEventListener('click', onPickerClick, true);
document.addEventListener('keydown', onPickerKeyDown, true);


