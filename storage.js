'use strict';

// Storage and settings helpers for the Twitter scraper.
// NOTE:
// - This file is loaded before `scraper.js` (see `manifest.json`).
// - It intentionally defines only functions and simple globals; it does not
//   execute behaviour on load, so it can safely reference globals that are
//   declared later in `scraper.js` (e.g. rememberScrapedIdsEnabled).

// Cross-page search run coordination (search results -> status pages -> back)
function loadSearchRunState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.searchRunState);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Array.isArray(parsed.tweetQueue)) parsed.tweetQueue = [];
        parsed.currentIndex = Number.isFinite(parsed.currentIndex) ? parsed.currentIndex | 0 : 0;
        parsed.paused = !!parsed.paused;
        return parsed;
    } catch {
        return null;
    }
}

function saveSearchRunState(state) {
    if (!state) return;
    try {
        const payload = {
            version: 1,
            mode: state.mode || 'search',
            searchUrl: state.searchUrl || '',
            exportKey: state.exportKey || 'account',
            ownerHandle: state.ownerHandle || '',
            tweetQueue: Array.isArray(state.tweetQueue) ? state.tweetQueue : [],
            currentIndex: Number.isFinite(state.currentIndex) ? state.currentIndex | 0 : 0,
            startedAt: state.startedAt || new Date().toISOString(),
            done: !!state.done,
            paused: !!state.paused
        };
        localStorage.setItem(STORAGE_KEYS.searchRunState, JSON.stringify(payload));
    } catch {
        // ignore
    }
}

function clearSearchRunState() {
    try {
        localStorage.removeItem(STORAGE_KEYS.searchRunState);
    } catch {
        // ignore
    }
}

// Aggregated media data across a search run (for single *_avatars.tsv + *_download_media.cmd export)
function loadSearchAggregate() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.searchAggregate);
        if (!raw) {
            return { exportKey: '', ownerHandle: '', tweets: [] };
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return { exportKey: '', ownerHandle: '', tweets: [] };
        }
        const ownerHandle = String(parsed.ownerHandle || '').trim();
        const exportKey = String(parsed.exportKey || '').trim();
        const tweets = Array.isArray(parsed.tweets) ? parsed.tweets : [];
        return { exportKey, ownerHandle, tweets };
    } catch {
        return { exportKey: '', ownerHandle: '', tweets: [] };
    }
}

function saveSearchAggregate(agg) {
    if (!agg || typeof agg !== 'object') return;
    try {
        const payload = {
            version: 1,
            exportKey: agg.exportKey || '',
            ownerHandle: agg.ownerHandle || '',
            tweets: Array.isArray(agg.tweets) ? agg.tweets : []
        };
        localStorage.setItem(STORAGE_KEYS.searchAggregate, JSON.stringify(payload));
    } catch {
        // ignore (quota etc.)
    }
}

function clearSearchAggregate() {
    try {
        localStorage.removeItem(STORAGE_KEYS.searchAggregate);
    } catch {
        // ignore
    }
}

function loadAutoHarvestWithExtensionSetting() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.autoHarvestWithExtension);
        if (raw == null || raw === '') return;
        autoHarvestWithExtension = raw === '1' || raw === 'true';
    } catch {
        // ignore
    }
}

function saveAutoHarvestWithExtensionSetting() {
    try {
        localStorage.setItem(STORAGE_KEYS.autoHarvestWithExtension, autoHarvestWithExtension ? '1' : '0');
    } catch {
        // ignore
    }
}

function loadVoiceExportSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.exportVoiceYtDlp);
        if (raw != null && raw !== '') exportVoiceYtDlp = raw === '1' || raw === 'true';
    } catch { /* ignore */ }

    try {
        const raw = localStorage.getItem(STORAGE_KEYS.ytDlpCookiesBrowser);
        if (raw != null && raw.trim()) ytDlpCookiesBrowser = String(raw).trim();
    } catch { /* ignore */ }
}

function saveVoiceExportSettings() {
    try {
        localStorage.setItem(STORAGE_KEYS.exportVoiceYtDlp, exportVoiceYtDlp ? '1' : '0');
        localStorage.setItem(STORAGE_KEYS.ytDlpCookiesBrowser, String(ytDlpCookiesBrowser || '').trim() || DEFAULT_YTDLP_COOKIES_BROWSER);
    } catch {
        // ignore
    }
}

function loadHighlightScrapedSetting() {
    try {
        const raw = localStorage.getItem('wxp_tw_scraper_highlight_scraped');
        highlightScrapedEnabled = raw === 'true' || raw === '1';
    } catch {
        highlightScrapedEnabled = false;
    }
}

function saveHighlightScrapedSetting() {
    try {
        localStorage.setItem('wxp_tw_scraper_highlight_scraped', highlightScrapedEnabled ? '1' : '0');
    } catch {
        // ignore
    }
}

function loadRememberScrapedIdsEnabledSetting() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.rememberScrapedIdsEnabled);
        if (raw == null || raw === '') return;
        rememberScrapedIdsEnabled = raw === '1' || raw === 'true';
    } catch {
        // ignore
    }
}

function saveRememberScrapedIdsEnabledSetting() {
    try {
        localStorage.setItem(STORAGE_KEYS.rememberScrapedIdsEnabled, rememberScrapedIdsEnabled ? '1' : '0');
    } catch {
        // ignore
    }
}

function loadRememberedScrapedIds() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.rememberedScrapedIds);
        const ids = parseRememberedIdsPayload(raw);
        rememberedScrapedIdSet = new Set(ids);
        // Seed the runtime dedupe set so helper waits (translation polling etc) already skip remembered IDs.
        scrapedIdSet = rememberScrapedIdsEnabled ? new Set(rememberedScrapedIdSet) : new Set();
    } catch {
        rememberedScrapedIdSet = new Set();
    }
}

function saveRememberedScrapedIdsNow() {
    if (!rememberScrapedIdsEnabled) return;
    try {
        // Store as newline-separated text to minimize JSON overhead.
        const payload = Array.from(rememberedScrapedIdSet).join('\n');
        localStorage.setItem(STORAGE_KEYS.rememberedScrapedIds, payload);
    } catch {
        // ignore (quota, etc.)
    }
}

function clearRememberedScrapedIds() {
    rememberedScrapedIdSet = new Set();
    try { localStorage.removeItem(STORAGE_KEYS.rememberedScrapedIds); } catch { /* ignore */ }
    if (highlightScrapedEnabled) {
        highlightAllScrapedTweets();
    }
}

function loadSearchRunSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.searchRunMaxStatusPosts);
        if (raw == null || raw === '') return;
        searchRunMaxStatusPosts = clampNumber(
            parseInt(raw, 10),
            MIN_SEARCH_RUN_MAX_STATUS_POSTS,
            MAX_SEARCH_RUN_MAX_STATUS_POSTS
        );
    } catch {
        // ignore
    }
}

function saveSearchRunSettings() {
    try {
        localStorage.setItem(
            STORAGE_KEYS.searchRunMaxStatusPosts,
            String(
                clampNumber(searchRunMaxStatusPosts, MIN_SEARCH_RUN_MAX_STATUS_POSTS, MAX_SEARCH_RUN_MAX_STATUS_POSTS) |
                    0
            )
        );
    } catch {
        // ignore
    }
}

function loadScrollStepSetting() {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.scrollStepPx);
        if (raw == null || raw === '') return;
        scrollStepPx = clampNumber(parseInt(raw, 10), MIN_SCROLL_STEP_PX, MAX_SCROLL_STEP_PX);
    } catch {
        // ignore
    }
}

function saveScrollStepSetting() {
    try {
        localStorage.setItem(STORAGE_KEYS.scrollStepPx, String(scrollStepPx));
    } catch {
        // ignore
    }
}

function loadTranslationSettings() {
    try {
        const rawEnabled = localStorage.getItem(STORAGE_KEYS.waitForImmersiveTranslate);
        if (rawEnabled != null) waitForImmersiveTranslate = rawEnabled === 'true';

        const rawWait = localStorage.getItem(STORAGE_KEYS.translationWaitMs);
        if (rawWait != null && rawWait !== '') {
            translationWaitMs = clampNumber(parseInt(rawWait, 10), MIN_TRANSLATION_WAIT_MS, MAX_TRANSLATION_WAIT_MS);
        }
    } catch {
        // ignore
    }
}

function saveTranslationSettings() {
    try {
        localStorage.setItem(STORAGE_KEYS.waitForImmersiveTranslate, String(!!waitForImmersiveTranslate));
        localStorage.setItem(STORAGE_KEYS.translationWaitMs, String(translationWaitMs | 0));
    } catch {
        // ignore
    }
}

function loadStartTweetCheckpoint() {
    try {
        const savedId = localStorage.getItem(STORAGE_KEYS.startTweetId);
        const savedExclusive = localStorage.getItem(STORAGE_KEYS.startTweetExclusive);
        if (savedId) {
            startFromTweetId = savedId;
            startFromTweetExclusive = savedExclusive === 'true';
        }
    } catch {
        // ignore
    }
}

function saveStartTweetCheckpoint() {
    try {
        if (!startFromTweetId) {
            localStorage.removeItem(STORAGE_KEYS.startTweetId);
            localStorage.removeItem(STORAGE_KEYS.startTweetExclusive);
            return;
        }
        localStorage.setItem(STORAGE_KEYS.startTweetId, startFromTweetId);
        localStorage.setItem(STORAGE_KEYS.startTweetExclusive, String(!!startFromTweetExclusive));
    } catch {
        // ignore
    }
}

