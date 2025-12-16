// ==UserScript==
// @name         Twitter Scraper (with_replies + status pages)
// @namespace    http://tampermonkey.net/
// @version      0.1.9
// @description  Scrapes X/Twitter: profile /with_replies AND individual tweet /status/<id> pages. Make sure to install the MediaHarvest extension to download videos. Disable “Ask where to save each file” in your browser settings.
// @author       WXP
// @match        https://*.twitter.com/*/with_replies
// @match        https://*.x.com/*/with_replies
// @match        https://*.twitter.com/*/status/*
// @match        https://*.twitter.com/i/web/status/*
// @match        https://*.x.com/*/status/*
// @match        https://*.x.com/i/web/status/*
// @run-at       document-start
// ==/UserScript==

// this script was originally made for tampermonkey, but i'm using it in a chrome extension now.
// note, twitter's /with_replies page does not show entire conversations. If a root tweet is placed between tweets within a comment section, 
// the script will break up the comment section and attriute comments to the wrong root tweet.
// this is a issue we cannot work around due to how twitter's /with_replies page chronologically displays tweets. 
// This is only a issue if comments that are supposed to be part of a root tweet are made on the same day as another root tweet is made. 
    'use strict';

    let scrapedData = [];
    let scrapedIdSet = new Set();
    let scrollInterval;

    // Persisted "already scraped" IDs so future runs can skip them.
    // Stored in localStorage (page storage), exportable/importable via JSON file.
    let rememberScrapedIdsEnabled = true;
    let rememberedScrapedIdSet = new Set(); // normalized status URL strings
    let rememberedIdsSaveTimer = null;

    // Run context (computed when you click "Start Scraping" so it works on SPA navigations too).
    let currentRunMode = 'unknown'; // 'with_replies' | 'status' | 'other'
    let currentRunProfileHandle = ''; // '@user' (with_replies only)
    let currentRunExportKey = 'account'; // used for filenames / exports
    let currentRunRootStatusRestId = ''; // for status mode


    // --- Video interception (stable IDs; avoid blob URLs) ---
    // Map tweet rest_id -> Set<filename.mp4>
    const videoFilesByRestId = new Map();
    // Map tweet rest_id -> Set<tweetUrl> (voice posts are best downloaded via yt-dlp using the tweet URL)
    const voiceTweetUrlsByRestId = new Map();
    // Map tweet rest_id -> boolean (detected voice media)
    const voiceDetectedByRestId = new Map();

    function extractRestIdFromStatusUrl(statusUrl) {
        // Works for:
        // - https://x.com/user/status/123...
        // - https://x.com/i/web/status/123...
        if (!statusUrl) return '';
        try {
            const u = new URL(statusUrl, window.location.origin);
            const m = u.pathname.match(/\/status\/(\d+)/);
            return m?.[1] || '';
        } catch {
            const m = String(statusUrl).match(/\/status\/(\d+)/);
            return m?.[1] || '';
        }
    }

    function getPageModeFromLocation() {
        const path = String(window.location?.pathname || '');
        if (/\/with_replies\/?$/i.test(path)) return 'with_replies';
        // Search results and advanced search builder
        if (/^\/search-advanced\/?/i.test(path)) return 'search_advanced';
        if (/^\/search\/?/i.test(path)) return 'search';
        // For tweet pages, URL patterns can be:
        // - /<user>/status/<id>
        // - /i/web/status/<id>
        // - /<user>/status/<id>/photo/1
        const restId = extractRestIdFromStatusUrl(window.location?.href || '');
        if (restId && /\/status\//i.test(path)) return 'status';
        return 'other';
    }

    function getWithRepliesProfileHandleFromPathname() {
        // /<account>/with_replies
        const parts = String(window.location?.pathname || '').split('/').filter(Boolean);
        const account = parts[0] || '';
        return account ? `@${account}` : '';
    }

    function handleToExportKey(handle) {
        const h = String(handle || '').trim().replace(/^@/, '');
        return h ? h.replace(/[^a-z0-9_-]/gi, '_') : 'account';
    }

    function inferSearchOwnerHandleFromUrlOrDom() {
        // Try to infer the profile handle from the search query (?q=from:handle …).
        try {
            const href = window.location?.href || '';
            const u = new URL(href, window.location.origin);
            const rawQ = u.searchParams.get('q') || '';
            const decoded = decodeURIComponent(rawQ);
            const m = decoded.match(/from(?::|%3A)([A-Za-z0-9_]{1,15})/i);
            if (m && m[1]) {
                return '@' + m[1];
            }
        } catch {
            // ignore and fall back to DOM
        }

        // Fallback: first tweet's handle in the results list.
        try {
            const handleSpan = document.querySelector('article[data-testid="tweet"] div[data-testid="User-Name"] a[tabindex="-1"] span');
            const txt = handleSpan?.innerText || handleSpan?.textContent || '';
            if (txt.trim()) return txt.trim();
        } catch {
            // ignore
        }

        return '';
    }

    function computeRunContextFromCurrentPage() {
        const mode = getPageModeFromLocation();
        if (mode === 'with_replies') {
            const ph = getWithRepliesProfileHandleFromPathname();
            return {
                mode,
                profileHandle: ph,
                exportKey: handleToExportKey(ph),
                rootRestId: ''
            };
        }

        if (mode === 'status') {
            const restId = extractRestIdFromStatusUrl(window.location?.href || '');
            return {
                mode,
                profileHandle: '',
                exportKey: 'status',
                rootRestId: restId
            };
        }

        if (mode === 'search' || mode === 'search_advanced') {
            const ph = inferSearchOwnerHandleFromUrlOrDom();
            return {
                mode,
                profileHandle: ph,
                exportKey: handleToExportKey(ph),
                rootRestId: ''
            };
        }

        return {
            mode,
            profileHandle: '',
            exportKey: 'account',
            rootRestId: ''
        };
    }

    function stripUrlQuery(urlString) {
        try {
            const u = new URL(urlString);
            u.search = '';
            u.hash = '';
            return u.toString();
        } catch {
            return String(urlString || '').split('#')[0].split('?')[0];
        }
    }

    function filenameFromUrl(urlString) {
        const cleaned = stripUrlQuery(urlString);
        try {
            const u = new URL(cleaned);
            const parts = (u.pathname || '').split('/').filter(Boolean);
            return parts[parts.length - 1] || '';
        } catch {
            const parts = String(cleaned || '').split('/').filter(Boolean);
            return parts[parts.length - 1] || '';
        }
    }

    function pickBestMp4Variant(variants) {
        if (!Array.isArray(variants)) return '';
        let bestUrl = '';
        let bestBitrate = -1;
        for (const v of variants) {
            if (!v || typeof v !== 'object') continue;
            const ct = String(v.content_type || v.contentType || '').toLowerCase();
            const url = String(v.url || '');
            if (!url) continue;
            if (ct && ct !== 'video/mp4') continue;
            if (!/\.mp4(\?|$)/i.test(url)) continue;
            const bitrate = Number(v.bitrate);
            const score = Number.isFinite(bitrate) ? bitrate : 0;
            if (score >= bestBitrate) {
                bestBitrate = score;
                bestUrl = url;
            }
        }
        return bestUrl;
    }

    function harvestVoiceSignalsFromMediaObject(mediaObj) {
        // Best-effort detection for "voice posts" (audio notes) in GraphQL tweet media.
        // We mark voice if we see:
        // - explicit media type "audio"
        // - any variant content_type starting with "audio/"
        // - fields like audio_info / voice_info (names may change, so be permissive)
        const t = String(mediaObj?.type || '').toLowerCase();
        if (t === 'audio' || t === 'voice') return true;

        if (mediaObj?.audio_info || mediaObj?.audioInfo || mediaObj?.voice_info || mediaObj?.voiceInfo) return true;

        const vi = mediaObj?.video_info || mediaObj?.videoInfo;
        const variants = vi?.variants;
        if (Array.isArray(variants)) {
            for (const v of variants) {
                const ct = String(v?.content_type || v?.contentType || '').toLowerCase();
                if (ct.startsWith('audio/')) return true;
            }
        }
        return false;
    }

    function harvestVideosFromTweetLikeObject(tweetObj) {
        // Returns array of stable mp4 filenames for this tweet object, if present.
        // X typically stores media under tweet.legacy.extended_entities.media[*].video_info.variants[*].url
        const legacy = tweetObj?.legacy;
        const medias =
            legacy?.extended_entities?.media ||
            legacy?.entities?.media ||
            tweetObj?.extended_entities?.media ||
            tweetObj?.entities?.media ||
            null;

        if (!Array.isArray(medias)) return [];

        const out = new Set();
        let sawVoice = false;
        for (const m of medias) {
            if (!sawVoice && harvestVoiceSignalsFromMediaObject(m)) sawVoice = true;
            const vi = m?.video_info || m?.videoInfo;
            const bestUrl = pickBestMp4Variant(vi?.variants);
            if (!bestUrl) continue;
            // Prefer truly stable CDN URLs.
            if (!/https?:\/\/video\.twimg\.com\//i.test(bestUrl)) continue;
            const name = filenameFromUrl(bestUrl);
            if (name && /\.mp4$/i.test(name)) out.add(name);
        }
        // Stash a voice-detected flag (merged by rest_id in the caller).
        // (We cannot reliably download voice posts in-browser, but we can export tweet URLs for yt-dlp.)
        if (tweetObj?.rest_id && typeof tweetObj.rest_id === 'string' && sawVoice) {
            voiceDetectedByRestId.set(tweetObj.rest_id, true);
        }
        return Array.from(out);
    }

    function mergeVideoFiles(restId, filenames) {
        if (!restId || !Array.isArray(filenames) || filenames.length === 0) return;
        let set = videoFilesByRestId.get(restId);
        if (!set) {
            set = new Set();
            videoFilesByRestId.set(restId, set);
        }
        for (const f of filenames) {
            if (f) set.add(f);
        }
    }

    function scanGraphqlJsonForTweetVideos(json) {
        // Walk the parsed JSON and find any objects shaped like a Tweet (has rest_id + legacy),
        // then extract best MP4 variants and store them by rest_id.
        const stack = [json];
        let steps = 0;
        const MAX_STEPS = 250000; // safety to avoid pathological payloads

        while (stack.length > 0 && steps++ < MAX_STEPS) {
            const node = stack.pop();
            if (!node) continue;

            if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) stack.push(node[i]);
                continue;
            }

            if (typeof node === 'object') {
                const restId = typeof node.rest_id === 'string' ? node.rest_id : '';
                if (restId) {
                    const videos = harvestVideosFromTweetLikeObject(node);
                    if (videos.length > 0) mergeVideoFiles(restId, videos);
                }

                // Recurse into object props
                for (const k of Object.keys(node)) {
                    stack.push(node[k]);
                }
            }
        }
    }

    function isLikelyTwitterGraphqlApiUrl(urlString) {
        const u = String(urlString || '');
        // Matches both:
        // - https://x.com/i/api/graphql/<queryId>/<queryName>
        // - https://x.com/graphql/<queryId>/<queryName>
        return /\/(?:i\/api\/)?graphql\//i.test(u);
    }

    function tryProcessApiResponseText(urlString, responseText) {
        try {
            if (!isLikelyTwitterGraphqlApiUrl(urlString)) return;
            if (!responseText || typeof responseText !== 'string') return;
            // Fast reject to avoid parsing non-tweet payloads.
            if (!responseText.includes('"rest_id"') || !responseText.includes('"video_info"')) return;
            const json = JSON.parse(responseText);
            scanGraphqlJsonForTweetVideos(json);
        } catch {
            // swallow: never break X UI if parsing fails
        }
    }

    function installNetworkInterceptors() {
        // XHR interception
        try {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function(method, url) {
                try {
                    this.__wxp_url = url;
                } catch {
                    // ignore
                }
                return origOpen.apply(this, arguments);
            };

            XMLHttpRequest.prototype.send = function() {
                try {
                    this.addEventListener('load', function() {
                        try {
                            if (this.status !== 200) return;
                            const urlString = this.responseURL || this.__wxp_url || '';
                            if (!isLikelyTwitterGraphqlApiUrl(urlString)) return;
                            // responseType '' (text) and 'text' both expose responseText.
                            const text = this.responseText;
                            if (typeof text === 'string' && text) {
                                tryProcessApiResponseText(urlString, text);
                            }
                        } catch {
                            // ignore
                        }
                    });
                } catch {
                    // ignore
                }
                return origSend.apply(this, arguments);
            };
        } catch {
            // ignore
        }

        // fetch interception
        try {
            const origFetch = window.fetch;
            if (typeof origFetch === 'function') {
                window.fetch = function(input, init) {
                    const p = origFetch.apply(this, arguments);
                    try {
                        p.then(resp => {
                            try {
                                const urlString = resp?.url || (typeof input === 'string' ? input : input?.url) || '';
                                if (!isLikelyTwitterGraphqlApiUrl(urlString)) return;
                                if (!resp || !resp.ok) return;
                                // Clone so we don't consume body.
                                resp.clone().text().then(text => {
                                    tryProcessApiResponseText(urlString, text);
                                }).catch(() => {});
                            } catch {
                                // ignore
                            }
                        }).catch(() => {});
                    } catch {
                        // ignore
                    }
                    return p;
                };
            }
        } catch {
            // ignore
        }
    }

    // Install interceptors ASAP (we also set @run-at document-start).
    installNetworkInterceptors();

    // Scroll step (constant; avoids zoom-dependent viewport math)
    const DEFAULT_SCROLL_STEP_PX = 500;
    const MIN_SCROLL_STEP_PX = 200;
    const MAX_SCROLL_STEP_PX = 6000;
    let scrollStepPx = DEFAULT_SCROLL_STEP_PX;

    // Page "zoom" (CSS zoom) to load more content per viewport during scraping.
    // Note: JS cannot change the browser's UI zoom level; this applies a CSS zoom to the page instead.
    const SCRAPE_PAGE_ZOOM_PERCENT = 100;
    const RESET_PAGE_ZOOM_PERCENT = 100;
    let appliedPageZoomTarget = null; // 'body' | 'root' | null

    // Smoother scrolling: tick more often, but scroll less per tick (preserve px/sec feel).
    // These are intentionally separate so UI "Scroll step" can remain a simple single value.
    const SCRAPE_TICK_MS = 750; // was 1500
    const SCRAPE_SCROLL_BASE_TICK_MS = 1500;
    const AUTO_SCROLL_TICK_MS = 200; // was 850
    const AUTO_SCROLL_BASE_TICK_MS = 850;
    const MIN_EFFECTIVE_SCROLL_STEP_PX = 80; // allows smaller increments even if UI min is higher

    // Optional: wait for translation plugins (e.g. Immersive Translate) to inject translated DOM.
    const DEFAULT_WAIT_FOR_IMMERSIVE_TRANSLATE = false;
    const DEFAULT_TRANSLATION_WAIT_MS = 6000;
    const MIN_TRANSLATION_WAIT_MS = 0;
    const MAX_TRANSLATION_WAIT_MS = 15000;
    const TRANSLATION_POLL_MS = 100;
    let waitForImmersiveTranslate = DEFAULT_WAIT_FOR_IMMERSIVE_TRANSLATE;
    let translationWaitMs = DEFAULT_TRANSLATION_WAIT_MS;
    // Per-tweet deferral tracking so we don't permanently capture the original before translation arrives.
    // tweetId -> { firstSeenMs: number, defers: number }
    let translationDeferById = new Map();

    // Optional "start from this tweet" gating
    let startFromTweetId = null; // full status URL (as used by tweet.id)
    let startFromTweetExclusive = false; // if true: resume *after* this tweet (skip the match)
    let hasReachedStartTweet = false;

    // Auto-stop detection
    let autoStopEnabled = true;
    let autoDownloadOnAutoStop = true;
    let consecutiveNoNewTicks = 0;
    let lastScrollY = 0;
    let lastScrollHeight = 0;
    const MAX_NO_NEW_TICKS = 16; // ~12s with 750ms interval
    // Extra guard: if Twitter stops loading new timeline elements, stop quickly instead of "busy scrolling".
    const TIMELINE_NO_NEW_ELEMENT_PAUSE_MS = 1100; // ~1s
    const TIMELINE_LOAD_WAIT_MS = 10000; // wait up to 10s for Twitter to append more elements
    let timelineObserver = null;
    let lastTimelineNewElementMs = 0;
    let lastTweetDomCount = 0;

    // Ensure "Stop and Download" only runs once per scraping run (prevents double downloads
    // when both manual stop and auto-stop try to trigger a download).
    let downloadAlreadyTriggered = false;

    // Picker-mode state
    let isPickingStartTweet = false;
    let lastHighlightedTweet = null;
    const PICK_HIGHLIGHT_STYLE = '3px solid #1da1f2';
    let priorOutline = '';
    let priorOutlineOffset = '';

    // Auto-scroll-to-text state (QoL tool; independent from scraping)
    let autoScrollToTextInterval = null;
    let autoScrollNeedle = '';
    let autoScrollTicks = 0;
    let autoScrollStartMs = 0;
    let autoScrollStalledTicks = 0;
    let autoScrollLastScrollY = 0;
    let autoScrollLastScrollH = 0;
    let autoScrollLastHighlightedTweet = null;
    let autoScrollPriorOutline = '';
    let autoScrollPriorOutlineOffset = '';
    const AUTO_SCROLL_HIGHLIGHT_STYLE = '3px solid #f59e0b';
    const AUTO_SCROLL_MAX_TICKS = 12000; // safety limit (~85 minutes at 425ms)

    const STORAGE_KEYS = {
        startTweetId: 'wxp_tw_scraper_start_tweet_id',
        startTweetExclusive: 'wxp_tw_scraper_start_tweet_exclusive',
        scrollStepPx: 'wxp_tw_scraper_scroll_step_px',
        waitForImmersiveTranslate: 'wxp_tw_scraper_wait_for_immersive_translate',
        translationWaitMs: 'wxp_tw_scraper_translation_wait_ms',
        autoHarvestWithExtension: 'wxp_tw_scraper_auto_harvest_with_extension',
        exportVoiceYtDlp: 'wxp_tw_scraper_export_voice_ytdlp',
        ytDlpCookiesBrowser: 'wxp_tw_scraper_ytdlp_cookies_browser',
        rememberScrapedIdsEnabled: 'wxp_tw_scraper_remember_scraped_ids_enabled',
        rememberedScrapedIds: 'wxp_tw_scraper_remembered_scraped_ids_v1',
        searchRunState: 'wxp_tw_scraper_search_run_state_v1',
        searchAggregate: 'wxp_tw_scraper_search_aggregate_v1'
    };

    // Cross-page search run coordination (search results -> status pages -> back)
    function loadSearchRunState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEYS.searchRunState);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            if (!Array.isArray(parsed.tweetQueue)) parsed.tweetQueue = [];
            parsed.currentIndex = Number.isFinite(parsed.currentIndex) ? parsed.currentIndex | 0 : 0;
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
                done: !!state.done
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
            if (!Array.isArray(parsed.tweets)) parsed.tweets = [];
            return parsed;
        } catch {
            return { exportKey: '', ownerHandle: '', tweets: [] };
        }
    }

    function saveSearchAggregate(agg) {
        if (!agg) return;
        try {
            const payload = {
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

    function getNormalizedCurrentStatusUrl() {
        return normalizeStatusUrl(window.location?.href || '');
    }

    function collectSearchResultTweetUrls(max = 5000) {
        const urls = [];
        const seen = new Set();
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        for (let i = 0; i < articles.length && urls.length < max; i++) {
            const a = articles[i].querySelector('a[href*="/status/"]');
            const id = normalizeStatusUrl(a?.href || '');
            if (!id) continue;
            if (scrapedIdSet.has(id) || rememberedScrapedIdSet.has(id)) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            urls.push(id);
        }
        return urls;
    }

    async function collectAllSearchResultTweetUrlsWithScroll() {
        const all = new Set();
        let lastSize = 0;
        let stalledTicks = 0;
        const maxTicks = 200;

        for (let tick = 0; tick < maxTicks; tick++) {
            const batch = collectSearchResultTweetUrls();
            for (const id of batch) {
                all.add(id);
            }

            if (all.size > lastSize) {
                lastSize = all.size;
                stalledTicks = 0;
            } else {
                stalledTicks++;
            }

            if (isEndOfTimelineVisible()) break;
            if (stalledTicks >= 5) break;

            const beforeY = window.scrollY;
            window.scrollBy(0, getScrapeScrollStepPx());
            const afterY = window.scrollY;
            if (afterY === beforeY) {
                stalledTicks++;
            }

            await sleep(SCRAPE_TICK_MS);
        }

        return Array.from(all);
    }

    // Optional: drive the TwitterMediaHarvest extension by auto-clicking its injected button.
    // This avoids re-implementing downloads in this userscript and lets the extension manage history/filenames.
    const DEFAULT_AUTO_HARVEST_WITH_EXTENSION = false;
    let autoHarvestWithExtension = DEFAULT_AUTO_HARVEST_WITH_EXTENSION;
    const harvestedTweetIdSet = new Set(); // tweet URL (normalized) -> already clicked by this script
    const harvestQueue = []; // tweet URL (normalized)
    let harvestPumpInterval = null;
    let lastHarvestClickMs = 0;
    const HARVEST_PUMP_MS = 500;
    const HARVEST_MIN_INTERVAL_MS = 900; // throttle clicks to avoid hammering UI

    // Voice download export (yt-dlp batch)
    const DEFAULT_EXPORT_VOICE_YTDLP = true;
    let exportVoiceYtDlp = DEFAULT_EXPORT_VOICE_YTDLP;
    const DEFAULT_YTDLP_COOKIES_BROWSER = 'firefox';
    let ytDlpCookiesBrowser = DEFAULT_YTDLP_COOKIES_BROWSER;

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

    const SCRAPED_HIGHLIGHT_STYLE = '2px solid #10b981';
    const SCRAPED_HIGHLIGHT_CLASS = 'wxp-scraper-scraped-highlight';
    let highlightScrapedEnabled = false;
    let scrapedHighlightObserver = null;

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

    function applyScrapedHighlight(tweetEl) {
        if (!tweetEl || tweetEl.classList.contains(SCRAPED_HIGHLIGHT_CLASS)) return;
        tweetEl.classList.add(SCRAPED_HIGHLIGHT_CLASS);
        tweetEl.style.outline = SCRAPED_HIGHLIGHT_STYLE;
        tweetEl.style.outlineOffset = '2px';
    }

    function removeScrapedHighlight(tweetEl) {
        if (!tweetEl || !tweetEl.classList.contains(SCRAPED_HIGHLIGHT_CLASS)) return;
        tweetEl.classList.remove(SCRAPED_HIGHLIGHT_CLASS);
        if (tweetEl.style.outline === SCRAPED_HIGHLIGHT_STYLE) {
            tweetEl.style.outline = '';
            tweetEl.style.outlineOffset = '';
        }
    }

    function highlightAllScrapedTweets() {
        document.querySelectorAll(`.${SCRAPED_HIGHLIGHT_CLASS}`).forEach(removeScrapedHighlight);

        if (!highlightScrapedEnabled) return;

        const tweetEls = document.querySelectorAll('article[data-testid="tweet"]');
        for (const tweetEl of tweetEls) {
            const tweetLinkElement = tweetEl.querySelector('a[href*="/status/"]');
            const tweetId = normalizeStatusUrl(tweetLinkElement?.href);
            if (tweetId && (scrapedIdSet.has(tweetId) || rememberedScrapedIdSet.has(tweetId))) {
                applyScrapedHighlight(tweetEl);
            }
        }
    }

    function startScrapedHighlightObserver() {
        if (scrapedHighlightObserver) return;

        scrapedHighlightObserver = new MutationObserver(() => {
            if (!highlightScrapedEnabled) return;
            if (window.__wxp_highlight_timeout) clearTimeout(window.__wxp_highlight_timeout);
            window.__wxp_highlight_timeout = setTimeout(() => {
                highlightAllScrapedTweets();
            }, 150);
        });

        try {
            scrapedHighlightObserver.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true
            });
        } catch {
            // ignore
        }
    }

    function stopScrapedHighlightObserver() {
        if (!scrapedHighlightObserver) return;
        try {
            scrapedHighlightObserver.disconnect();
        } catch {
            // ignore
        }
        scrapedHighlightObserver = null;
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

    function parseRememberedIdsPayload(raw) {
        // Accept:
        // - newline-separated IDs
        // - JSON array of IDs
        // - JSON object: { ids: [...] }
        if (raw == null) return [];
        const text = String(raw);
        const trimmed = text.trim();
        if (!trimmed) return [];

        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
                const parsed = JSON.parse(trimmed);
                const ids = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.ids) ? parsed.ids : []);
                return ids.map(v => normalizeStatusUrl(String(v || ''))).filter(Boolean);
            } catch {
                // fall through to newline parsing
            }
        }

        return text
            .split(/\r?\n/g)
            .map(s => normalizeStatusUrl(String(s || '').trim()))
            .filter(Boolean);
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

    function scheduleSaveRememberedScrapedIds() {
        if (!rememberScrapedIdsEnabled) return;
        if (rememberedIdsSaveTimer) return;
        rememberedIdsSaveTimer = setTimeout(() => {
            rememberedIdsSaveTimer = null;
            saveRememberedScrapedIdsNow();
        }, 900);
    }

    function rememberScrapedTweetId(tweetId) {
        if (!rememberScrapedIdsEnabled) return;
        const id = normalizeStatusUrl(tweetId);
        if (!id) return;
        if (rememberedScrapedIdSet.has(id)) return;
        rememberedScrapedIdSet.add(id);
        scheduleSaveRememberedScrapedIds();
    }

    function clearRememberedScrapedIds() {
        rememberedScrapedIdSet = new Set();
        try { localStorage.removeItem(STORAGE_KEYS.rememberedScrapedIds); } catch { /* ignore */ }
        if (highlightScrapedEnabled) {
            highlightAllScrapedTweets();
        }
    }

    function exportRememberedScrapedIdsToJsonFile(exportKey) {
        const safeKey = String(exportKey || 'account').replace(/[^a-z0-9_-]/gi, '_') || 'account';
        const filename = `${safeKey}_scraped_ids.json`;
        const payload = {
            version: 1,
            exportedAt: new Date().toISOString(),
            ids: Array.from(rememberedScrapedIdSet)
        };
        downloadTextFile(JSON.stringify(payload, null, 2), filename);
    }

    async function importRememberedScrapedIdsFromFile(file) {
        if (!file) return { added: 0, total: rememberedScrapedIdSet.size };
        const text = await file.text();
        const ids = parseRememberedIdsPayload(text);
        let added = 0;
        for (const id of ids) {
            if (!id) continue;
            if (rememberedScrapedIdSet.has(id)) continue;
            rememberedScrapedIdSet.add(id);
            added++;
            // If a run is currently active, also prevent re-scraping in this run.
            scrapedIdSet.add(id);
        }
        saveRememberedScrapedIdsNow();
        if (highlightScrapedEnabled) {
            highlightAllScrapedTweets();
        }
        return { added, total: rememberedScrapedIdSet.size };
    }

    function findTweetElByTweetUrl(tweetUrl) {
        const restId = extractRestIdFromStatusUrl(tweetUrl);
        if (!restId) return null;
        const a = document.querySelector(`article[data-testid="tweet"] a[href*="/status/${restId}"]`);
        return a?.closest?.('article[data-testid="tweet"]') || null;
    }

    function findHarvesterWrapper(tweetEl) {
        if (!tweetEl) return null;
        return tweetEl.querySelector('.harvester[data-testid="harvester-button"]') || null;
    }

    function findMediaHarvestButton(tweetEl) {
        if (!tweetEl) return null;
        // The extension injects:
        // <div class="harvester ..." data-testid="harvester-button"><div aria-label="Media Harvest" role="button" ...>
        return (
            tweetEl.querySelector('[data-testid="harvester-button"] [aria-label="Media Harvest"][role="button"]') ||
            tweetEl.querySelector('.harvester[data-testid="harvester-button"] [role="button"][aria-label*="Harvest"]') ||
            tweetEl.querySelector('.harvester[data-testid="harvester-button"] [role="button"]') ||
            null
        );
    }

    function isTweetHarvestedByExtension(tweetEl) {
        const wrapper = findHarvesterWrapper(tweetEl);
        return !!wrapper?.classList?.contains('downloaded');
    }

    function tweetHasHarvestableMedia(tweetEl) {
        if (!tweetEl) return false;
        // Heuristic: tweetPhoto contains photos *and* video containers in current X DOM.
        // Also check for video player markers.
        return !!tweetEl.querySelector(
            'img[src*="pbs.twimg.com/media/"], [data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], video, [data-testid*="audio"], audio, [aria-label*="voice"], [aria-label*="audio"]'
        );
    }

    function enqueueHarvestTweet(tweetUrl) {
        if (!tweetUrl) return;
        if (harvestedTweetIdSet.has(tweetUrl)) return;
        if (harvestQueue.includes(tweetUrl)) return;
        harvestQueue.push(tweetUrl);
    }

    function startHarvestPump() {
        if (harvestPumpInterval) return;
        harvestPumpInterval = setInterval(processHarvestQueue, HARVEST_PUMP_MS);
    }

    function stopHarvestPump() {
        if (!harvestPumpInterval) return;
        try { clearInterval(harvestPumpInterval); } catch { /* ignore */ }
        harvestPumpInterval = null;
    }

    function processHarvestQueue() {
        if (!autoHarvestWithExtension) return;
        if (harvestQueue.length === 0) return;
        const now = Date.now();
        if (now - lastHarvestClickMs < HARVEST_MIN_INTERVAL_MS) return;

        const tweetUrl = harvestQueue.shift();
        if (!tweetUrl || harvestedTweetIdSet.has(tweetUrl)) return;

        const tweetEl = findTweetElByTweetUrl(tweetUrl);
        if (!tweetEl) {
            harvestQueue.push(tweetUrl);
            return;
        }

        // If the extension already recorded it, don't click.
        if (isTweetHarvestedByExtension(tweetEl)) {
            harvestedTweetIdSet.add(tweetUrl);
            return;
        }

        // Only click when the tweet actually has media.
        if (!tweetHasHarvestableMedia(tweetEl)) {
            harvestedTweetIdSet.add(tweetUrl);
            return;
        }

        const btn = findMediaHarvestButton(tweetEl);
        if (!btn) {
            // Extension button not present yet; re-queue and try later
            harvestQueue.push(tweetUrl);
            return;
        }

        try {
            btn.click();
            harvestedTweetIdSet.add(tweetUrl);
            lastHarvestClickMs = now;
        } catch {
            harvestQueue.push(tweetUrl);
        }
    }

    function clampNumber(n, min, max) {
        const x = Number(n);
        if (!Number.isFinite(x)) return min;
        return Math.min(max, Math.max(min, x));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms | 0)));
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

    function getScrollStepPx() {
        return clampNumber(scrollStepPx, MIN_SCROLL_STEP_PX, MAX_SCROLL_STEP_PX);
    }

    function setPageZoomPercent(percent) {
        const pct = clampNumber(percent, 10, 300);
        const body = document.body;
        const root = document.documentElement;
        if (body) {
            body.style.zoom = `${pct}%`;
            appliedPageZoomTarget = 'body';
        } else if (root) {
            root.style.zoom = `${pct}%`;
            appliedPageZoomTarget = 'root';
        }
    }

    function applyScrapePageZoom() {
        setPageZoomPercent(SCRAPE_PAGE_ZOOM_PERCENT);
    }

    function resetPageZoomTo100() {
        const body = document.body;
        const root = document.documentElement;
        if (appliedPageZoomTarget === 'body' && body) {
            body.style.zoom = `${RESET_PAGE_ZOOM_PERCENT}%`;
        } else if (appliedPageZoomTarget === 'root' && root) {
            root.style.zoom = `${RESET_PAGE_ZOOM_PERCENT}%`;
        } else {
            // Best-effort: reset both if we don't know which one was used.
            if (body) body.style.zoom = `${RESET_PAGE_ZOOM_PERCENT}%`;
            if (root) root.style.zoom = `${RESET_PAGE_ZOOM_PERCENT}%`;
        }
        appliedPageZoomTarget = null;
    }

    function getEffectiveScrollStepPxForTick(tickMs, baseTickMs) {
        const base = getScrollStepPx();
        const scaled = Math.round(base * (tickMs / baseTickMs));
        return clampNumber(scaled, MIN_EFFECTIVE_SCROLL_STEP_PX, MAX_SCROLL_STEP_PX);
    }

    function getScrapeScrollStepPx() {
        return getEffectiveScrollStepPxForTick(SCRAPE_TICK_MS, SCRAPE_SCROLL_BASE_TICK_MS);
    }

    function getAutoScrollStepPx() {
        return getEffectiveScrollStepPxForTick(AUTO_SCROLL_TICK_MS, AUTO_SCROLL_BASE_TICK_MS);
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

    function getTranslationWaitMs() {
        return clampNumber(translationWaitMs, MIN_TRANSLATION_WAIT_MS, MAX_TRANSLATION_WAIT_MS) | 0;
    }

    function shouldDeferTweetUntilTranslated(tweetId, tweetTextElement) {
        if (!waitForImmersiveTranslate) return false;
        if (!tweetId || !tweetTextElement) return false;
        if (!isImmersiveTranslateActiveOnPage()) return false;

        // If translated content exists, do not defer.
        if (getImmersiveTranslateContentNode(tweetTextElement)) return false;

        const now = Date.now();
        const entry = translationDeferById.get(tweetId) || { firstSeenMs: now, defers: 0 };
        entry.defers++;
        translationDeferById.set(tweetId, entry);

        // Wait up to ~translationWaitMs per tweet (minimum floor so fast settings still work).
        const maxPerTweetWait = Math.max(1200, getTranslationWaitMs());

        // Defer while within the per-tweet window and for a limited number of attempts.
        // After that, fall back to scraping the original so we don't stall forever.
        if ((now - entry.firstSeenMs) <= maxPerTweetWait && entry.defers <= 25) return true;
        return false;
    }

    function setUiStatus(text) {
        const el = document.getElementById('wxp-scraper-status');
        if (el) el.textContent = text || '';
    }

    function setAutoScrollStatus(text) {
        const el = document.getElementById('wxp-autoscroll-status');
        if (el) el.textContent = text || '';
    }

    function findFirstTweetContainingText(needle) {
        const n = String(needle || '');
        if (!n) return null;

        const tweetEls = document.querySelectorAll('article[data-testid="tweet"]');
        for (let i = 0; i < tweetEls.length; i++) {
            const tweet = tweetEls[i];
            const tweetTextEl = tweet.querySelector?.('[data-testid="tweetText"]');
            const hay = (extractTweetTextWithEmojis(tweetTextEl) || tweetTextEl?.innerText || tweet?.innerText || '').trim();
            if (hay && hay.includes(n)) return tweet;
        }
        return null;
    }

    function applyAutoScrollHighlight(tweetEl) {
        if (!tweetEl) return;
        if (autoScrollLastHighlightedTweet === tweetEl) return;

        if (autoScrollLastHighlightedTweet && autoScrollLastHighlightedTweet !== tweetEl) {
            autoScrollLastHighlightedTweet.style.outline = autoScrollPriorOutline || '';
            autoScrollLastHighlightedTweet.style.outlineOffset = autoScrollPriorOutlineOffset || '';
        }

        autoScrollPriorOutline = tweetEl.style.outline;
        autoScrollPriorOutlineOffset = tweetEl.style.outlineOffset;
        tweetEl.style.outline = AUTO_SCROLL_HIGHLIGHT_STYLE;
        tweetEl.style.outlineOffset = '2px';
        autoScrollLastHighlightedTweet = tweetEl;
    }

    function clearAutoScrollHighlight() {
        if (!autoScrollLastHighlightedTweet) return;
        autoScrollLastHighlightedTweet.style.outline = autoScrollPriorOutline || '';
        autoScrollLastHighlightedTweet.style.outlineOffset = autoScrollPriorOutlineOffset || '';
        autoScrollLastHighlightedTweet = null;
        autoScrollPriorOutline = '';
        autoScrollPriorOutlineOffset = '';
    }

    function stopAutoScrollToText(reason) {
        if (autoScrollToTextInterval) {
            clearInterval(autoScrollToTextInterval);
            autoScrollToTextInterval = null;
        }
        autoScrollNeedle = '';
        autoScrollTicks = 0;
        autoScrollStartMs = 0;
        autoScrollStalledTicks = 0;
        autoScrollLastScrollY = 0;
        autoScrollLastScrollH = 0;

        const btn = document.getElementById('wxp-autoscroll-btn');
        if (btn) btn.textContent = 'Scroll to text';

        if (reason) setAutoScrollStatus(reason);
    }

    function startAutoScrollToText(needle) {
        const n = String(needle || '').trim();
        if (!n) {
            setAutoScrollStatus('Auto-scroll: enter a target string first.');
            return;
        }

        if (autoScrollToTextInterval) {
            stopAutoScrollToText('Auto-scroll: stopped.');
            return;
        }

        autoScrollNeedle = n;
        autoScrollTicks = 0;
        autoScrollStartMs = Date.now();
        autoScrollStalledTicks = 0;
        autoScrollLastScrollY = window.scrollY;
        autoScrollLastScrollH = document.documentElement.scrollHeight;

        const btn = document.getElementById('wxp-autoscroll-btn');
        if (btn) btn.textContent = 'Stop scrolling';

        setAutoScrollStatus(`Auto-scroll: searching for “${n}” …`);

        autoScrollToTextInterval = setInterval(() => {
            autoScrollTicks++;

            const matchTweet = findFirstTweetContainingText(autoScrollNeedle);
            if (matchTweet) {
                applyAutoScrollHighlight(matchTweet);
                try {
                    matchTweet.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } catch {
                    // ignore
                }
                const secs = Math.max(0, Math.round((Date.now() - autoScrollStartMs) / 1000));
                stopAutoScrollToText(`Auto-scroll: found match after ${secs}s.`);
                return;
            }

            // Scroll down to load more
            const beforeY = window.scrollY;
            const beforeH = document.documentElement.scrollHeight;
            window.scrollBy(0, getAutoScrollStepPx());
            const afterY = window.scrollY;
            const afterH = document.documentElement.scrollHeight;

            const didScroll = afterY !== beforeY;
            const didGrow = afterH !== beforeH;
            if (!didScroll && !didGrow && afterY === autoScrollLastScrollY && afterH === autoScrollLastScrollH) {
                autoScrollStalledTicks++;
            } else {
                autoScrollStalledTicks = 0;
            }
            autoScrollLastScrollY = afterY;
            autoScrollLastScrollH = afterH;

            if (autoScrollTicks % 20 === 0) {
                const secs = Math.max(0, Math.round((Date.now() - autoScrollStartMs) / 1000));
                setAutoScrollStatus(`Auto-scroll: searching (${secs}s) …`);
            }

            if (isEndOfTimelineVisible() && autoScrollStalledTicks >= 6) {
                stopAutoScrollToText('Auto-scroll: reached end of timeline (no match found).');
                return;
            }

            if (autoScrollStalledTicks >= 24) {
                stopAutoScrollToText('Auto-scroll: stalled (no new content). Try again or scroll manually a bit.');
                return;
            }

            if (autoScrollTicks >= AUTO_SCROLL_MAX_TICKS) {
                stopAutoScrollToText('Auto-scroll: stopped (safety limit reached).');
            }
        }, AUTO_SCROLL_TICK_MS);
    }

    function formatStartTweetStatus() {
        if (!startFromTweetId) return 'Start tweet: (none)';
        return startFromTweetExclusive
            ? `Resume after: ${startFromTweetId}`
            : `Start tweet: ${startFromTweetId}`;
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

    function isEndOfTimelineVisible() {
        // Best-effort: detect "end" messaging Twitter/X sometimes shows.
        const endTexts = [
            "you’re all caught up",
            "you're all caught up",
            "you have caught up",
            "you’ve reached the end",
            "you've reached the end",
            "nothing to see here",
            "no more posts",
            "no more tweets",
            "end of results",
            "end of the results"
        ];

        const candidates = document.querySelectorAll('div[role="status"], div[aria-live], span, div');
        for (let i = 0; i < candidates.length; i++) {
            const t = (candidates[i]?.textContent || '').trim().toLowerCase();
            if (!t) continue;
            for (const endText of endTexts) {
                if (t.includes(endText)) return true;
            }
        }
        return false;
    }

    function stopScrapingInterval(reason) {
        if (scrollInterval) {
            clearInterval(scrollInterval);
            scrollInterval = null;
        }
        if (timelineObserver) {
            try { timelineObserver.disconnect(); } catch { /* ignore */ }
            timelineObserver = null;
        }
        if (reason) console.log(reason);
        setUiStatus(reason || 'Stopped.');
    }

    function markTimelineActivityNow() {
        lastTimelineNewElementMs = Date.now();
    }

    function startTimelineObserver() {
        if (timelineObserver) return;
        // Initialize baseline
        lastTweetDomCount = document.querySelectorAll('article[data-testid="tweet"]').length;
        markTimelineActivityNow();

        timelineObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                const added = m.addedNodes;
                if (!added || added.length === 0) continue;
                for (let i = 0; i < added.length; i++) {
                    const node = added[i];
                    if (!node || node.nodeType !== 1) continue;
                    const el = /** @type {Element} */ (node);
                    // Fast path: the node itself is a tweet
                    if (el.matches?.('article[data-testid="tweet"]')) {
                        markTimelineActivityNow();
                        return;
                    }
                    // Common path: tweet(s) inside a newly added subtree
                    if (el.querySelector?.('article[data-testid="tweet"]')) {
                        markTimelineActivityNow();
                        return;
                    }
                }
            }
        });

        try {
            // Observe broadly; Twitter's container structure changes often.
            timelineObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
        } catch {
            // ignore
        }
    }

    async function waitForTimelineActivity(timeoutMs) {
        const start = Date.now();
        const baseline = lastTimelineNewElementMs;
        while (Date.now() - start < Math.max(0, timeoutMs | 0)) {
            if (lastTimelineNewElementMs !== baseline) return true;
            await sleep(100);
        }
        return lastTimelineNewElementMs !== baseline;
    }

    function normalizeStatusUrl(url) {
        if (!url) return '';
        try {
            const u = new URL(url, window.location.origin);
            // Strip query/hash to make matching stable
            u.search = '';
            u.hash = '';
            return u.toString();
        } catch {
            return url;
        }
    }

    function escapeMarkdownInlineText(text) {
        // Prevent Obsidian/CommonMark from treating usernames like @h____n900 as emphasis.
        // Escape the most common inline-markdown control chars.
        return String(text || '')
            .replace(/\\/g, '\\\\')
            .replace(/\*/g, '\\*')
            .replace(/_/g, '\\_')
            .replace(/`/g, '\\`')
            .replace(/\[/g, '\\[')
            .replace(/]/g, '\\]');
    }

    function escapeMarkdownInlineTextPreservingUrls(line) {
        // Escape inline markdown controls, but keep URLs intact (URLs often contain "_" etc).
        const urls = [];
        const withTokens = String(line || '').replace(/\bhttps?:\/\/[^\s)]+/gi, (url) => {
            const token = `\u001AURL${urls.length}\u001A`;
            urls.push(url);
            return token;
        });

        const escaped = escapeMarkdownInlineText(withTokens);
        return escaped.replace(/\u001AURL(\d+)\u001A/g, (_, i) => urls[Number(i)] || '');
    }

    function getTweetIdFromTweetEl(tweetEl) {
        const a = tweetEl?.querySelector?.('a[href*="/status/"]');
        return normalizeStatusUrl(a?.href || '');
    }

    function clearStartTweetSelection() {
        startFromTweetId = null;
        startFromTweetExclusive = false;
        hasReachedStartTweet = true; // no gate
        saveStartTweetCheckpoint();
        setUiStatus(formatStartTweetStatus());
    }

    function applyHighlight(tweetEl) {
        if (!tweetEl) return;
        // If we're still on the same tweet, don't re-apply styles (avoids clobbering priorOutline).
        if (lastHighlightedTweet === tweetEl) return;
        // Restore previous highlight
        if (lastHighlightedTweet && lastHighlightedTweet !== tweetEl) {
            lastHighlightedTweet.style.outline = priorOutline || '';
            lastHighlightedTweet.style.outlineOffset = priorOutlineOffset || '';
        }
        // Save current tweet's prior styles (only once per element swap)
        priorOutline = tweetEl.style.outline;
        priorOutlineOffset = tweetEl.style.outlineOffset;
        tweetEl.style.outline = PICK_HIGHLIGHT_STYLE;
        tweetEl.style.outlineOffset = '2px';
        lastHighlightedTweet = tweetEl;
    }

    function clearHighlight() {
        if (!lastHighlightedTweet) return;
        lastHighlightedTweet.style.outline = priorOutline || '';
        lastHighlightedTweet.style.outlineOffset = priorOutlineOffset || '';
        lastHighlightedTweet = null;
        priorOutline = '';
        priorOutlineOffset = '';
    }

    function stopPickingMode() {
        if (!isPickingStartTweet) return;
        isPickingStartTweet = false;
        clearHighlight();
        setUiStatus(formatStartTweetStatus());
    }

    function startPickingMode() {
        isPickingStartTweet = true;
        setUiStatus('Picker mode: hover a tweet to highlight, click to select. Press Esc to cancel.');
    }

    function onPickerMouseMove(e) {
        if (!isPickingStartTweet) return;
        const tweet = e.target?.closest?.('article[data-testid="tweet"]');
        if (tweet) {
            applyHighlight(tweet);
        } else {
            clearHighlight();
        }
    }

    function onPickerClick(e) {
        if (!isPickingStartTweet) return;

        const tweet = e.target?.closest?.('article[data-testid="tweet"]');
        if (!tweet) return;

        e.preventDefault();
        e.stopPropagation();

        const pickedId = getTweetIdFromTweetEl(tweet);
        if (!pickedId) {
            setUiStatus('Could not read tweet URL from that element. Try clicking the timestamp/link area.');
            return;
        }

        startFromTweetId = pickedId;
        startFromTweetExclusive = false; // picker means "include this tweet"
        saveStartTweetCheckpoint();
        hasReachedStartTweet = false;
        stopPickingMode();
    }

    function onPickerKeyDown(e) {
        if (!isPickingStartTweet) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            stopPickingMode();
        }
    }

    function extractAvatarUrl(tweetEl) {
        if (!tweetEl) return '';

        // Prefer the explicit avatar container (stable testid).
        const img =
            tweetEl.querySelector('[data-testid="Tweet-User-Avatar"] img[src^="http"]') ||
            tweetEl.querySelector('[data-testid^="UserAvatar-Container"] img[src^="http"]') ||
            tweetEl.querySelector('img[src*="pbs.twimg.com/profile_images/"]');

        const directSrc = img?.getAttribute?.('src') || '';
        if (directSrc) return directSrc;

        // Fallback: some avatars may be set as background-image on a nested div.
        const bgEl =
            tweetEl.querySelector('[data-testid="Tweet-User-Avatar"] div[style*="background-image"]') ||
            tweetEl.querySelector('div[style*="background-image"][style*="profile_images"]');

        const style = bgEl?.getAttribute?.('style') || '';
        const match = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
        return match?.[1] || '';
    }

    function normalizeAvatarUrlTo200x200(urlString) {
        // X often renders e.g. ".../P__Vdz3r_bigger.jpg" in the DOM.
        // A 200x200 variant typically exists at ".../P__Vdz3r_200x200.jpg".
        // This keeps the same path/extension/query but swaps the size suffix.
        const raw = String(urlString || '').trim();
        if (!raw) return '';
        try {
            const u = new URL(raw);
            const path = u.pathname || '';
            const newPath = path.replace(
                /\/([^\/]+?)(?:_(?:normal|bigger|mini|400x400|200x200))?(\.[a-z0-9]+)$/i,
                (_m, base, ext) => `/${base}_200x200${ext}`
            );
            u.pathname = newPath;
            return u.toString();
        } catch {
            return raw.replace(
                /\/([^\/]+?)(?:_(?:normal|bigger|mini|400x400|200x200))?(\.[a-z0-9]+)(\?.*)?$/i,
                (_m, base, ext, q) => `/${base}_200x200${ext}${q || ''}`
            );
        }
    }

    function sanitizeFilenameComponent(s) {
        // Windows-safe filename component: remove reserved characters and trim.
        return String(s || '')
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180);
    }

    function avatarFilenameFromUrlAndHandle(avatarUrl, authorHandle) {
        // Example avatar URL:
        // https://pbs.twimg.com/profile_images/1950538056639094785/P__Vdz3r_200x200.jpg
        // -> avatar_ayamehtbt_P__Vdz3r_200x200.jpg
        if (!avatarUrl) return '';
        const handleRaw = String(authorHandle || '').replace(/^@/, '');
        const handle = sanitizeFilenameComponent(handleRaw || 'user');

        let baseName = '';
        let ext = 'jpg';
        try {
            const u = new URL(avatarUrl);
            const parts = (u.pathname || '').split('/').filter(Boolean);
            baseName = parts[parts.length - 1] || '';
        } catch {
            const parts = String(avatarUrl).split('/').filter(Boolean);
            baseName = parts[parts.length - 1] || '';
        }

        // Strip query/hash and extract extension.
        baseName = baseName.split('?')[0].split('#')[0];
        const dot = baseName.lastIndexOf('.');
        if (dot > 0 && dot < baseName.length - 1) {
            ext = baseName.slice(dot + 1).toLowerCase() || 'jpg';
            baseName = baseName.slice(0, dot);
        }
        if (ext === 'jpeg') ext = 'jpg';
        if (!['jpg', 'png', 'webp', 'gif'].includes(ext)) ext = 'jpg';

        // If this is a default profile image, use a shared filename (no handle) to de-duplicate.
        if (/default_profile/i.test(baseName)) {
            return 'avatar_default_profile_200x200.png';
        }

        const safeBase = sanitizeFilenameComponent(baseName || 'avatar');
        const filename = `avatar_${handle}_${safeBase}.${ext}`;
        return filename;
    }

    function normalizeTwitterMediaFilenameFromUrl(urlString) {
        // Accepts URLs like:
        // - https://pbs.twimg.com/media/G74vDW1bEAAT6aD?format=jpg&name=small
        // - https://pbs.twimg.com/media/G74vDW1bEAAT6aD.jpg
        // Returns: "G74vDW1bEAAT6aD.jpg" (or png/webp/gif when detectable)
        if (!urlString || typeof urlString !== 'string') return '';
        if (!urlString.includes('pbs.twimg.com/media/')) return '';

        try {
            const u = new URL(urlString);
            const pathParts = (u.pathname || '').split('/').filter(Boolean);
            const last = pathParts[pathParts.length - 1] || '';
            if (!last) return '';

            let base = last;
            let extFromPath = '';
            const dotIdx = last.lastIndexOf('.');
            if (dotIdx > 0 && dotIdx < last.length - 1) {
                base = last.slice(0, dotIdx);
                extFromPath = last.slice(dotIdx + 1);
            }

            // Twitter uses ?format=jpg|png|webp|gif on /media/ URLs.
            let ext = (u.searchParams.get('format') || extFromPath || 'jpg').toLowerCase();
            if (ext === 'jpeg') ext = 'jpg';
            if (!['jpg', 'png', 'gif', 'webp'].includes(ext)) ext = 'jpg';

            // Media IDs are usually URL-safe base64-ish / snowflake-ish strings, keep conservative.
            if (!/^[a-z0-9_-]+$/i.test(base)) return '';

            return `${base}.${ext}`;
        } catch {
            // Non-URL strings: best-effort regex.
            const m = urlString.match(/pbs\.twimg\.com\/media\/([a-z0-9_-]+)(?:\.[a-z0-9]+)?(?:\?|$)/i);
            if (!m) return '';
            return `${m[1]}.jpg`;
        }
    }

    function extractTweetPhotoFilenames(tweetEl) {
        // Collect filenames that match how your downloader saves them (e.g. G74vDW1bEAAT6aD.jpg).
        if (!tweetEl) return [];

        const out = new Set();

        // 1) Direct <img> tags (common).
        tweetEl.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
            const src = img.getAttribute('src') || '';
            const filename = normalizeTwitterMediaFilenameFromUrl(src);
            if (filename) out.add(filename);
        });

        // 2) Background-image styles (some layouts use this for photos).
        tweetEl.querySelectorAll('[style*="pbs.twimg.com/media/"]').forEach(el => {
            const style = el.getAttribute('style') || '';
            const matches = style.match(/url\(["']?(https?:\/\/pbs\.twimg\.com\/media\/[^"')]+)["']?\)/gi) || [];
            matches.forEach(m => {
                const urlMatch = m.match(/url\(["']?([^"')]+)["']?\)/i);
                const urlString = urlMatch?.[1] || '';
                const filename = normalizeTwitterMediaFilenameFromUrl(urlString);
                if (filename) out.add(filename);
            });
        });

        return Array.from(out);
    }

    function emojiUnicodeFromTwitterUrl(src) {
        if (!src) return null;

        // 2) Parse codepoints from URL filename: .../emoji/v2/svg/1f9e0.svg or 1f3f3-fe0f-200d-1f308.svg
        const match = src.match(/\/emoji\/v2\/svg\/([0-9a-f-]+)\.svg/i);
        if (!match) return null;

        const codepoints = match[1]
            .toLowerCase()
            .split('-')
            .filter(Boolean)
            .map(hex => Number.parseInt(hex, 16));

        if (codepoints.length === 0 || codepoints.some(n => !Number.isFinite(n))) return null;

        try {
            return String.fromCodePoint(...codepoints);
        } catch {
            return null;
        }
    }

    function toEmojiTextOrMarkdown(imgEl) {
        const alt = imgEl?.getAttribute?.('alt') || imgEl?.getAttribute?.('title') || '';
        const src = imgEl?.getAttribute?.('src') || '';

        // Primary: generate Unicode directly from the Twitter emoji SVG URL.
        const unicode = emojiUnicodeFromTwitterUrl(src);
        if (unicode) return unicode;

        // Secondary: Twitter often already provides the Unicode in `alt`.
        if (alt) return alt;

        // Fallback: do NOT emit markdown image syntax here, because tweet body text
        // gets markdown-escaped for Obsidian/CommonMark (which would break it).
        // If we can't map the emoji, just keep a placeholder.
        return 'emoji';
    }

    function extractTweetTextWithEmojis(rootEl) {
        if (!rootEl) return '';

        const out = [];

        // Some translation extensions (e.g. Immersive Translate) inject wrapper <font> nodes like:
        // .immersive-translate-target-wrapper -> (hidden <br>) -> .immersive-translate-target-inner
        // Prefer scraping the translated "inner" content to avoid duplicated/malformed output.
        const translatedInner =
            rootEl.querySelector?.('.immersive-translate-target-inner') ||
            rootEl.querySelector?.('.immersive-translate-target-translation-block-wrapper') ||
            rootEl.querySelector?.('[data-immersive-translate-translation-element-mark]');
        const effectiveRoot = translatedInner || rootEl;

        const walk = (node) => {
            if (!node) return;

            // Text node
            if (node.nodeType === Node.TEXT_NODE) {
                out.push(node.textContent || '');
                return;
            }

            // Element node
            if (node.nodeType === Node.ELEMENT_NODE) {
                const el = /** @type {HTMLElement} */ (node);
                const tag = (el.tagName || '').toUpperCase();

                // Skip hidden/aria-hidden nodes (translation tools often inject hidden separators).
                if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
                    return;
                }

                if (tag === 'IMG') {
                    out.push(toEmojiTextOrMarkdown(el));
                    return;
                }

                if (tag === 'BR') {
                    // Ignore hidden <br> (common in injected translation wrappers).
                    if (el.hasAttribute('hidden')) return;
                    out.push('\n');
                    return;
                }

                // Recurse children
                el.childNodes.forEach(walk);
            }
        };

        walk(effectiveRoot);
        return out.join('');
    }

    function getImmersiveTranslateContentNode(rootEl) {
        if (!rootEl) return null;
        return (
            rootEl.querySelector?.('.immersive-translate-target-inner') ||
            rootEl.querySelector?.('.immersive-translate-target-translation-block-wrapper') ||
            rootEl.querySelector?.('[data-immersive-translate-translation-element-mark]') ||
            null
        );
    }

    function isImmersiveTranslateActiveOnPage() {
        // Best-effort: if the extension isn't installed/active, don't add unnecessary waits.
        return !!document.querySelector(
            '.immersive-translate-target-wrapper, .immersive-translate-target-inner, [data-immersive-translate-translation-element-mark]'
        );
    }

    function getUnscrapedTweetTextElements(limit = 12) {
        const out = [];
        const tweetEls = document.querySelectorAll('article[data-testid="tweet"]');
        for (let i = 0; i < tweetEls.length && out.length < limit; i++) {
            const tweet = tweetEls[i];
            const tweetLinkElement = tweet.querySelector('a[href*="/status/"]');
            const tweetId = normalizeStatusUrl(tweetLinkElement?.href);
            if (!tweetId || scrapedIdSet.has(tweetId)) continue;
            const tweetTextElement = tweet.querySelector('[data-testid="tweetText"]');
            if (!tweetTextElement) continue;
            out.push(tweetTextElement);
        }
        return out;
    }

    async function waitForImmersiveTranslateAfterScroll() {
        if (!waitForImmersiveTranslate) return;
        const waitMs = getTranslationWaitMs();
        if (waitMs <= 0) return;

        const start = Date.now();
        while (Date.now() - start < waitMs) {
            const sample = getUnscrapedTweetTextElements(10);
            if (sample.length === 0) return;

            // If any unsaved tweet already has translated content injected, we're good to extract.
            let anyTranslated = false;
            let anyWrapperPresent = false;
            let anyWrapperMissingContent = false;

            for (const el of sample) {
                if (getImmersiveTranslateContentNode(el)) {
                    anyTranslated = true;
                    break;
                }
                if (el.querySelector?.('.immersive-translate-target-wrapper')) {
                    anyWrapperPresent = true;
                    // wrapper exists but content node isn't found yet => likely mid-translation
                    anyWrapperMissingContent = true;
                }
            }

            // If the plugin isn't active at all, don't busy-wait.
            if (!isImmersiveTranslateActiveOnPage() && !anyWrapperPresent) return;

            if (anyTranslated) return;

            // If we see wrappers but not the translated content yet, keep polling a bit.
            if (!anyWrapperMissingContent) {
                // No signals yet; just wait out the remaining time with polling.
            }

            await sleep(TRANSLATION_POLL_MS);
        }
    }

    function getDeferredUnscrapedTweetTextElements(limit = 12) {
        // Tweets we *already* deferred (translationDeferById has entry), still unscraped, and still missing translated content.
        // We use this to decide whether to pause scrolling until the translation extension finishes injecting DOM.
        if (!waitForImmersiveTranslate) return [];
        if (!isImmersiveTranslateActiveOnPage()) return [];

        const out = [];
        const tweetEls = document.querySelectorAll('article[data-testid="tweet"]');
        for (let i = 0; i < tweetEls.length && out.length < limit; i++) {
            const tweet = tweetEls[i];
            const tweetLinkElement = tweet.querySelector('a[href*="/status/"]');
            const tweetId = normalizeStatusUrl(tweetLinkElement?.href);
            if (!tweetId || scrapedIdSet.has(tweetId)) continue;
            if (!translationDeferById.has(tweetId)) continue;
            const tweetTextElement = tweet.querySelector('[data-testid="tweetText"]');
            if (!tweetTextElement) continue;
            if (getImmersiveTranslateContentNode(tweetTextElement)) continue;
            out.push(tweetTextElement);
        }
        return out;
    }

    async function waitForDeferredTranslationsToSettle() {
        // If we deferred any tweets in extractTweets(), pause scrolling and poll until those tweets
        // either have translated DOM injected or have aged out of the per-tweet defer window.
        if (!waitForImmersiveTranslate) return;
        const waitMs = getTranslationWaitMs();
        if (waitMs <= 0) return;

        const maxWait = Math.max(1200, waitMs);
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            const pending = getDeferredUnscrapedTweetTextElements(12);
            if (pending.length === 0) return;
            await sleep(TRANSLATION_POLL_MS);
        }
    }

    async function startSearchRunFromSearchPage(ctx) {
        try {
            applyScrapePageZoom();
        } catch {
            // ignore
        }

        setUiStatus('Collecting tweets from search results…');
        const tweetQueue = await collectAllSearchResultTweetUrlsWithScroll();
        const filteredQueue = tweetQueue.filter(id => !scrapedIdSet.has(id) && !rememberedScrapedIdSet.has(id));

        if (!filteredQueue.length) {
            setUiStatus('Search run: no new tweets found (all already scraped or none visible).');
            resetPageZoomTo100();
            return;
        }

        // Fresh aggregate for this search run (previous data is discarded).
        clearSearchAggregate();

        const state = {
            mode: 'search',
            searchUrl: window.location?.href || '',
            exportKey: ctx.exportKey || 'account',
            ownerHandle: ctx.profileHandle || '',
            tweetQueue: filteredQueue,
            currentIndex: 0,
            startedAt: new Date().toISOString(),
            done: false
        };
        saveSearchRunState(state);

        const first = filteredQueue[0];
        setUiStatus(`Search run: ${filteredQueue.length} tweets queued. Opening 1/${filteredQueue.length}…`);
        window.location.href = first;
    }

    function startScraping() {
        // Compute context at start time (X is an SPA; pathname/URL can change without a reload).
        const ctx = computeRunContextFromCurrentPage();
        currentRunMode = ctx.mode;
        currentRunProfileHandle = ctx.profileHandle;
        currentRunExportKey = ctx.exportKey;
        currentRunRootStatusRestId = ctx.rootRestId;

        // Special handling: search results / advanced search acts as controller that walks each status page.
        if (currentRunMode === 'search' || currentRunMode === 'search_advanced') {
            // Avoid starting the legacy timeline-based scraper on search pages.
            startSearchRunFromSearchPage(ctx);
            return;
        }

        loadHighlightScrapedSetting();
        highlightAllScrapedTweets();

        applyScrapePageZoom();
        scrapedData = [];
        // Reset per-run "stop + download" guard so each new run can produce one download.
        downloadAlreadyTriggered = false;
        // Seed dedupe with remembered IDs (so we can skip tweets scraped in prior sessions).
        scrapedIdSet = rememberScrapedIdsEnabled ? new Set(rememberedScrapedIdSet) : new Set();
        translationDeferById = new Map();
        startTimelineObserver();
        if (currentRunMode === 'with_replies') {
            console.log(`Scraping started for ${currentRunProfileHandle}'s /with_replies page...`);
        } else if (currentRunMode === 'status') {
            console.log(`Scraping started for /status/${currentRunRootStatusRestId || '(unknown)'}...`);
        } else {
            console.log(`Scraping started (page mode: ${currentRunMode})...`);
        }
        // Reset per-run voice URL collection
        voiceTweetUrlsByRestId.clear();
        // Gate extraction until we hit the selected start tweet, if any.
        // NOTE: On /status pages, "start tweet" gating is not useful and can cause the root tweet to be skipped.
        hasReachedStartTweet = (currentRunMode === 'status') ? true : !startFromTweetId;
        setUiStatus(formatStartTweetStatus());

        consecutiveNoNewTicks = 0;
        lastScrollY = window.scrollY;
        lastScrollHeight = document.documentElement.scrollHeight;

        let tickInProgress = false;
        scrollInterval = setInterval(() => {
            if (tickInProgress) return;
            tickInProgress = true;

            (async () => {
                const beforeCount = scrapedData.length;
                const beforeY = window.scrollY;
                const beforeH = document.documentElement.scrollHeight;

                window.scrollBy(0, getScrapeScrollStepPx());

                // Give translation extensions a chance to inject translated DOM before scraping.
                await waitForImmersiveTranslateAfterScroll();

                const firstPass = extractTweets();
                if (firstPass.deferredCount > 0) {
                    setUiStatus(`Waiting for translation… (pending: ${firstPass.deferredCount})`);
                    await waitForDeferredTranslationsToSettle();
                    extractTweets(); // re-attempt after translations settle / time out
                }
                if (highlightScrapedEnabled) {
                    highlightAllScrapedTweets();
                }

                const afterCount = scrapedData.length;
                const afterY = window.scrollY;
                const afterH = document.documentElement.scrollHeight;
                const tweetDomCountNow = document.querySelectorAll('article[data-testid="tweet"]').length;

                const didAddAny = afterCount > beforeCount;
                const didScroll = afterY !== beforeY;
                const didGrow = afterH !== beforeH;

                if (didGrow) markTimelineActivityNow();
                if (tweetDomCountNow > lastTweetDomCount) {
                    lastTweetDomCount = tweetDomCountNow;
                    markTimelineActivityNow();
                }

                if (didAddAny) {
                    consecutiveNoNewTicks = 0;
                } else {
                    consecutiveNoNewTicks++;
                }

                // If we can no longer scroll AND no new tweets are being found, we are likely at the end.
                if (autoStopEnabled) {
                    // If we're still waiting to reach the start tweet checkpoint, do NOT auto-stop.
                    if (!hasReachedStartTweet && startFromTweetId) {
                        consecutiveNoNewTicks = 0;
                        lastScrollY = afterY;
                        lastScrollHeight = afterH;
                        setUiStatus(`Waiting for start tweet… ${formatStartTweetStatus()}`);
                        return;
                    }

                    const endVisible = isEndOfTimelineVisible();
                    const stalledScroll = !didScroll && !didGrow && afterY === lastScrollY && afterH === lastScrollHeight;
                    const noNewTimelineElsRecently = (Date.now() - lastTimelineNewElementMs) >= TIMELINE_NO_NEW_ELEMENT_PAUSE_MS;

                    if (endVisible && consecutiveNoNewTicks >= 4) {
                        stopScrapingInterval(`Auto-stopped: end of timeline detected (tweets: ${afterCount}).`);
                        if (autoDownloadOnAutoStop) stopAndDownload();
                        return;
                    }

                    // If Twitter isn't loading new tweet DOM nodes, PAUSE and give it a chance to load more.
                    // Only stop+download if it stays stuck for the full wait window.
                    // This heuristic is only useful on scrolling timelines (e.g. /with_replies), not on single /status pages.
                    if (currentRunMode === 'with_replies' && stalledScroll && consecutiveNoNewTicks >= 2 && noNewTimelineElsRecently) {
                        setUiStatus(`Paused: waiting for Twitter to load more… (up to ${Math.round(TIMELINE_LOAD_WAIT_MS / 1000)}s)`);
                        const didLoad = await waitForTimelineActivity(TIMELINE_LOAD_WAIT_MS);
                        if (didLoad) {
                            // Give the next tick a clean slate.
                            consecutiveNoNewTicks = 0;
                        } else {
                            stopScrapingInterval(`Auto-stopped: no new timeline elements loaded in ${Math.round(TIMELINE_LOAD_WAIT_MS / 1000)}s (tweets: ${afterCount}).`);
                            if (autoDownloadOnAutoStop) stopAndDownload();
                            return;
                        }
                    }

                    if (consecutiveNoNewTicks >= MAX_NO_NEW_TICKS && stalledScroll) {
                        stopScrapingInterval(`Auto-stopped: no new tweets detected (ticks: ${consecutiveNoNewTicks}, tweets: ${afterCount}).`);
                        if (autoDownloadOnAutoStop) stopAndDownload();
                        return;
                    }
                }

                lastScrollY = afterY;
                lastScrollHeight = afterH;
            })().finally(() => {
                tickInProgress = false;
            });
        }, SCRAPE_TICK_MS);
    }

    function extractTweets() {
        const tweetElements = document.querySelectorAll('article[data-testid="tweet"]');
        let deferredCount = 0;

        function tweetHasReplyingToBanner(tweetEl) {
            // Some replies (e.g. replying to a deleted/suspended account) do not show the usual
            // "vertical reply line" marker in the left gutter, but *do* render a banner like:
            //   "Replying to @suspendedaccount"
            // We treat that as a reliable reply signal.
            if (!tweetEl) return false;

            // Scan small-ish set of nodes; keep it cheap but robust to X DOM churn.
            const nodes = tweetEl.querySelectorAll('div, span');
            for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i];
                if (!el) continue;

                // Avoid matching inside the tweet body itself (someone could literally type "Replying to ...").
                if (el.closest?.('[data-testid="tweetText"]')) continue;

                const text = (el.textContent || '').trim();
                if (!text) continue;
                if (!/^replying to\b/i.test(text)) continue;

                // Ensure we actually see a handle somewhere in the banner (linked or plain text).
                const hasHandle =
                    /@[A-Za-z0-9_]{1,15}/.test(text) ||
                    /@[A-Za-z0-9_]{1,15}/.test((el.innerText || '').trim());
                if (!hasHandle) continue;

                return true;
            }
            return false;
        }

        tweetElements.forEach(tweet => {
            const socialContext = tweet.querySelector('[data-testid="socialContext"]');
            if (socialContext && /repost/i.test(socialContext.innerText)) {
                return;
            }

            const tweetLinkElement = tweet.querySelector('a[href*="/status/"]');
            const tweetId = normalizeStatusUrl(tweetLinkElement?.href);

            if (!tweetId || scrapedIdSet.has(tweetId)) return;

            // If a start tweet was selected, skip everything until we reach it.
            if (!hasReachedStartTweet && startFromTweetId) {
                if (tweetId !== startFromTweetId) return;
                hasReachedStartTweet = true;
                if (startFromTweetExclusive) return; // resume AFTER this tweet
            }

            const tweetTextElement = tweet.querySelector('[data-testid="tweetText"]');
            const timeElement = tweet.querySelector('time');

            // If we're trying to capture Immersive Translate output, avoid "locking in" the original text
            // before the extension injects its translated subtree.
            if (shouldDeferTweetUntilTranslated(tweetId, tweetTextElement)) {
                deferredCount++;
                return;
            }

            // Check for reply indicator (vertical line on left side)
            const hasVerticalReplyLine = !!tweet.querySelector(
                'div.css-175oi2r.r-18kxxzh.r-1wron08.r-onrtq4.r-15zivkp > ' +
                'div.css-175oi2r.r-1bnu78o.r-f8sm7e.r-m5arl1.r-1p0dtai.r-1d2f490.r-u8s1d.r-zchlnj.r-ipm5af'
            );
            // Fallback: banner text ("Replying to @...") which appears even when the replied-to tweet is missing.
            const isReply = hasVerticalReplyLine || tweetHasReplyingToBanner(tweet);

            const statsGroup = tweet.querySelector('div[role="group"][aria-label]');
            let hasReplies = false;
            if (statsGroup) {
                const ariaLabel = statsGroup.getAttribute('aria-label').toLowerCase();
                const replyMatch = ariaLabel.match(/(\d+)\s+repl/i);
                hasReplies = replyMatch && parseInt(replyMatch[1]) > 0;
            }

            const tweetData = {
                id: tweetId,
                authorName: tweet.querySelector('div[data-testid="User-Name"] a:not([tabindex="-1"]) span span')?.innerText || '',
                authorHandle: tweet.querySelector('div[data-testid="User-Name"] a[tabindex="-1"] span')?.innerText || '',
                authorAvatarUrl: normalizeAvatarUrlTo200x200(extractAvatarUrl(tweet) || ''),
                authorAvatarFile: '', // computed below
                photoFiles: extractTweetPhotoFilenames(tweet),
                videoFiles: (() => {
                    const restId = extractRestIdFromStatusUrl(tweetId);
                    if (!restId) return [];
                    const set = videoFilesByRestId.get(restId);
                    return set ? Array.from(set) : [];
                })(),
                isVoicePost: (() => {
                    const restId = extractRestIdFromStatusUrl(tweetId);
                    return !!(restId && voiceDetectedByRestId.get(restId));
                })(),
                // `innerText` drops emoji <img> nodes; walk the tweetText DOM to preserve them.
                text: extractTweetTextWithEmojis(tweetTextElement) || '',
                timestamp: timeElement?.getAttribute('datetime') || '',
                isReply: isReply,
                hasReplies: hasReplies,
                replies: [] // For compatibility; will be rebuilt during processing
            };

            // Determine a stable local avatar filename for markdown linking + export list.
            tweetData.authorAvatarFile = avatarFilenameFromUrlAndHandle(tweetData.authorAvatarUrl, tweetData.authorHandle);

            // If this tweet was detected as a voice post, store its URL for yt-dlp export.
            if (tweetData.isVoicePost) {
                const restId = extractRestIdFromStatusUrl(tweetId);
                if (restId) {
                    let set = voiceTweetUrlsByRestId.get(restId);
                    if (!set) { set = new Set(); voiceTweetUrlsByRestId.set(restId, set); }
                    set.add(tweetId);
                }
            }

            if (autoHarvestWithExtension) {
                // Let the extension do the actual download work; we just enqueue tweet URLs.
                enqueueHarvestTweet(tweetId);
                startHarvestPump();
            }

            scrapedData.push(tweetData);
            scrapedIdSet.add(tweetId);
            rememberScrapedTweetId(tweetId);
        });

        console.log(`Extracted ${scrapedData.length} tweets so far...`);
        return { deferredCount };
    }

    function mergeTweetsIntoSearchAggregate(scrapedTweets, searchState, exportKey) {
        if (!Array.isArray(scrapedTweets) || scrapedTweets.length === 0) return;
        const agg = loadSearchAggregate();
        if (!agg.tweets) agg.tweets = [];

        // Prefer explicit exportKey from search state when present.
        const key = (searchState?.exportKey || exportKey || agg.exportKey || 'account');
        const owner = searchState?.ownerHandle || agg.ownerHandle || '';

        agg.exportKey = key;
        agg.ownerHandle = owner;

        // We can simply append; the downstream avatar/voice exporters are already de-duplicated.
        for (const t of scrapedTweets) {
            if (t && t.id) {
                agg.tweets.push({
                    id: t.id,
                    authorHandle: t.authorHandle || '',
                    authorAvatarUrl: t.authorAvatarUrl || '',
                    authorAvatarFile: t.authorAvatarFile || '',
                    isVoicePost: !!t.isVoicePost
                });
            }
        }

        saveSearchAggregate(agg);
    }

    function advanceSearchRunAfterDownload() {
        const state = loadSearchRunState();
        if (!state || !Array.isArray(state.tweetQueue) || state.done) return;

        const currentUrl = getNormalizedCurrentStatusUrl();
        let idx = state.currentIndex | 0;
        if (idx < 0) idx = 0;

        // Ensure currentIndex at least points past the just-processed tweet.
        if (state.tweetQueue[idx] && normalizeStatusUrl(state.tweetQueue[idx]) === currentUrl) {
            idx++;
        } else {
            // Try to find currentUrl in the queue as a fallback.
            const found = state.tweetQueue.findIndex(u => normalizeStatusUrl(u) === currentUrl);
            if (found >= 0) idx = found + 1;
        }

        if (idx >= state.tweetQueue.length) {
            state.done = true;
            state.currentIndex = state.tweetQueue.length;
            saveSearchRunState(state);
            // When finished, navigate back to the original search page if we have it.
            if (state.searchUrl) {
                setUiStatus('Search run completed. Returning to search page…');
                window.location.href = state.searchUrl;
            } else {
                setUiStatus('Search run completed.');
            }
            return;
        }

        state.currentIndex = idx;
        saveSearchRunState(state);

        const next = state.tweetQueue[idx];
        if (next) {
            setUiStatus(`Search run: opening ${idx + 1}/${state.tweetQueue.length}…`);
            window.location.href = next;
        }
    }

    function stopAndDownload() {
        // If a download has already been triggered for this run (whether via auto-stop
        // or a previous manual click), do nothing. This prevents the "double download"
        // case where auto-stop fires shortly after a manual Stop+Download click.
        if (downloadAlreadyTriggered) {
            console.log('Stop+Download already triggered for this run; ignoring duplicate call.');
            return;
        }
        downloadAlreadyTriggered = true;

        stopScrapingInterval(`Scraping stopped. Processing ${scrapedData.length} tweets...`);
        console.log(`Scraping stopped. Processing ${scrapedData.length} tweets...`);

        // Save a resume checkpoint: pick up *after* the last scraped tweet next time.
        // This is intentionally based on raw scrapedData (not the processed sequence).
        let lastId = '';
        for (let i = scrapedData.length - 1; i >= 0; i--) {
            const id = scrapedData[i]?.id;
            if (id) { lastId = id; break; }
        }
        if (lastId) {
            startFromTweetId = normalizeStatusUrl(lastId);
            startFromTweetExclusive = true;
            saveStartTweetCheckpoint();
        }

        // Determine processing mode at download time (in case the user navigated before clicking Stop).
        const liveCtx = computeRunContextFromCurrentPage();
        const runMode = currentRunMode !== 'unknown' ? currentRunMode : liveCtx.mode;
        const ownerHandle = currentRunProfileHandle || liveCtx.profileHandle || '';
        const rootRestId = currentRunRootStatusRestId || liveCtx.rootRestId || '';

        // --- Mode A: Tweet permalink/status page ---
        if (runMode === 'status' && rootRestId) {
            // Find the root tweet we are viewing by rest_id.
            const rootIdx = scrapedData.findIndex(t => extractRestIdFromStatusUrl(t?.id) === rootRestId);
            const rootTweet = rootIdx >= 0 ? scrapedData[rootIdx] : (scrapedData[0] || null);

            const rootHandle = String(rootTweet?.authorHandle || '').trim();
            const exportKey = handleToExportKey(rootHandle) || currentRunExportKey || 'status';
            const safeRestId = String(rootRestId || '').replace(/[^0-9]/g, '') || 'unknown';
            const filename = `${exportKey}_status_${safeRestId}.md`;

            const finalSequence = [];
            if (rootTweet) finalSequence.push({ ...rootTweet, depth: 0 });

            const commentSection = scrapedData
                .filter((t, idx) => idx !== rootIdx && t);

            let threads = [];

            if (commentSection.length > 0 && rootHandle) {
                threads = groupCommentSectionIntoThreads(commentSection, rootHandle);

                threads.sort((threadA, threadB) => {
                    const firstTweetA = threadA.find(t => t.authorHandle !== rootHandle) || threadA[0];
                    const firstTweetB = threadB.find(t => t.authorHandle !== rootHandle) || threadB[0];
                    return (firstTweetA?.timestamp || '').localeCompare(firstTweetB?.timestamp || '');
                });

                threads.forEach((thread, threadIndex) => {
                    thread.forEach((tweet, commentIndex) => {
                        const depth = (commentIndex === 0) ? 1 : 2;
                        finalSequence.push({
                            ...tweet,
                            depth,
                            threadNumber: threadIndex + 1,
                            commentNumber: commentIndex + 1
                        });
                    });
                });
            } else {
                // Fallback: simple depth assignment if threading is unavailable.
                commentSection.forEach(tweet => finalSequence.push({ ...tweet, depth: 1 }));
            }

            console.log(`Processed status page (${safeRestId}). Tweets: ${scrapedData.length}, Threads: ${threads.length || 0}.`);
            generateMarkdown(finalSequence, filename);

            // If we are in the middle of a search run, aggregate media-only data into localStorage
            // and defer avatars/yt-dlp/export scripts to a single combined export later.
            const searchState = loadSearchRunState();
            const isPartOfSearchRun = !!(searchState && !searchState.done && searchState.mode === 'search');

            if (isPartOfSearchRun) {
                try {
                    mergeTweetsIntoSearchAggregate(scrapedData, searchState, exportKey);
                } catch {
                    // ignore aggregation errors; scraping result is still saved via markdown
                }
            } else {
                // Standalone status page: export avatars + voice media helpers immediately.
                if (exportVoiceYtDlp) {
                    try { exportVoiceTweetUrlListFile(scrapedData, exportKey); } catch { /* ignore */ }
                }
                try { exportAvatarDownloadFiles(scrapedData, exportKey); } catch { /* ignore */ }
                try { exportCombinedDownloadMediaRunner(exportKey); } catch { /* ignore */ }
            }

            if (highlightScrapedEnabled) {
                highlightAllScrapedTweets();
            }

            resetPageZoomTo100();
            setUiStatus(`Downloaded. ${formatStartTweetStatus()}`);

            if (isPartOfSearchRun) {
                // If this status page is part of an active search run, continue to the next tweet.
                advanceSearchRunAfterDownload();
            }
            return;
        }

        // --- Mode B: Profile /with_replies page (original behavior) ---
        const exportKey = currentRunExportKey || liveCtx.exportKey || 'account';

        // **Step 1 & 2: Identify root tweets and separate comment sections**
        // We loop through scrapedData (DOM order) and split it into sections.
        // Each section contains one root tweet + its comment section (replies between this root and the next).
        const rootTweetData = [];
        let currentCommentSection = [];
        let currentRoot = null;

        scrapedData.forEach(tweet => {
            const isRootTweet = ownerHandle && (tweet.authorHandle === ownerHandle) && !tweet.isReply;

            if (isRootTweet) {
                // Finalize previous section before starting new one
                if (currentRoot) {
                    rootTweetData.push({
                        rootTweet: currentRoot,
                        commentSection: currentCommentSection
                    });
                }
                // Start new section with this root tweet
                currentRoot = tweet;
                currentCommentSection = [];
            } else if (currentRoot) {
                // This tweet belongs to the current root's comment section
                currentCommentSection.push(tweet);
            }
        });

        // Process the last section
        if (currentRoot) {
            rootTweetData.push({
                rootTweet: currentRoot,
                commentSection: currentCommentSection
            });
        }

        // **Step 3, 4, 5, 6: Process each root tweet's comment section**
        const finalSequence = [];

        rootTweetData.forEach((section, sectionIdx) => {
            // Add the root tweet (always at depth 0, in DOM order)
            finalSequence.push({ ...section.rootTweet, depth: 0 });

            // **Step 4: Group comment section into threads by username**
            // Each thread is a conversation group: [userTweet, ownerReply, ...]
            const threads = groupCommentSectionIntoThreads(section.commentSection, ownerHandle);

            // **Step 5: Chronologically sort tweets within each thread**
            // We sort threads by the timestamp of the first tweet in each thread
            // (which is the tweet the owner replied to, not their reply)
            threads.sort((threadA, threadB) => {
                // Find the first tweet in each thread (will be by user, not owner)
                const firstTweetA = threadA.find(t => t.authorHandle !== ownerHandle) || threadA[0];
                const firstTweetB = threadB.find(t => t.authorHandle !== ownerHandle) || threadB[0];

                return firstTweetA.timestamp.localeCompare(firstTweetB.timestamp);
            });

            // **Step 6: Flatten threads into final sequence with numbering and depth**
            threads.forEach((thread, threadIndex) => {
                thread.forEach((tweet, commentIndex) => {
                    const depth = commentIndex === 0 ? 1 : 2;
                    finalSequence.push({
                        ...tweet,
                        depth: depth,
                        threadNumber: threadIndex + 1,
                        commentNumber: commentIndex + 1
                    });
                });
            });

            // Add blank line between root tweets (but not after the last one)
            if (sectionIdx < rootTweetData.length - 1) {
                finalSequence.push({ separator: true });
            }
        });

        console.log(`Processed ${rootTweetData.length} root tweet sections with conversation-aware sorting.`);
        generateMarkdown(finalSequence, `${exportKey}_with_replies.md`);

        // Export yt-dlp batch files for voice posts (tweet URL is the best input).
        // NOTE: A userscript cannot execute yt-dlp locally, so we export a URL list + a combined downloader script.
        if (exportVoiceYtDlp) {
            try { exportVoiceTweetUrlListFile(scrapedData, exportKey); } catch { /* ignore */ }
        }

        // Export avatar download lists so markdown can link avatars locally.
        try { exportAvatarDownloadFiles(scrapedData, exportKey); } catch { /* ignore */ }

        // Single combined downloader for avatars + voice (replaces separate *_download.cmd/ps1 files).
        try { exportCombinedDownloadMediaRunner(exportKey); } catch { /* ignore */ }

        // Restore zoom after we're done (especially helpful if you keep browsing after download).
        resetPageZoomTo100();

        // Update status after download to show the saved checkpoint.
        setUiStatus(`Downloaded. ${formatStartTweetStatus()}`);
    }

    /**
     * **Step 4 Helper: Group comment section into "threads" (per commenter) with explicit pairing**
     *
     * Goal:
     * - Twitter's `/with_replies` timeline does not render full threads. It tends to show:
     *   - A commenter tweet (replying to the root OR replying to the owner's reply)
     *   - The profile owner's reply to that commenter tweet
     *
     * Approach:
     * - Use DOM adjacency to pair owner replies to the immediately preceding non-owner tweet.
     * - Group all non-owner tweets by the same commenter into a single thread for this root section.
     * - Within each thread, sort chronologically so the back-and-forth reads as a chain.
     *
     * Metadata:
     * - Non-owner tweets are treated as "parent" tweets for pairing purposes:
     *   - isParent: true
     *   - hasReply: boolean
     *   - replyIds: string[]
     * - Owner replies get:
     *   - isReply: true
     *   - parentId: <id of the non-owner tweet they reply to>
     */
    function groupCommentSectionIntoThreads(commentSection, ownerHandle) {
        const threadsByHandle = new Map(); // handle -> tweet[]
        const firstSeenHandles = []; // stable ordering of threads

        let lastNonOwnerHandle = null;
        let lastNonOwnerTweetId = null;

        commentSection.forEach(tweet => {
            const isOwner = ownerHandle && (tweet.authorHandle === ownerHandle);
            const isOwnerReply = isOwner && tweet.isReply;

            // Non-owner tweets are the anchor points ("parents") we can reliably see in /with_replies.
            if (!isOwner) {
                const handle = tweet.authorHandle || '';

                if (!threadsByHandle.has(handle)) {
                    threadsByHandle.set(handle, []);
                    firstSeenHandles.push(handle);
                }

                const parentTweet = {
                    ...tweet,
                    isParent: true,
                    hasReply: false,
                    replyIds: []
                };

                threadsByHandle.get(handle).push(parentTweet);
                lastNonOwnerHandle = handle;
                lastNonOwnerTweetId = tweet.id;
                return;
            }

            // Owner replies: pair to the immediately previous non-owner tweet (DOM adjacency assumption).
            if (isOwnerReply && lastNonOwnerHandle && threadsByHandle.has(lastNonOwnerHandle)) {
                const replyTweet = {
                    ...tweet,
                    isReply: true,
                    parentId: lastNonOwnerTweetId
                };

                const thread = threadsByHandle.get(lastNonOwnerHandle);
                thread.push(replyTweet);

                // Update the matching parent tweet (most recent one with lastNonOwnerTweetId).
                for (let i = thread.length - 1; i >= 0; i--) {
                    const t = thread[i];
                    if (t.isParent && t.id === lastNonOwnerTweetId) {
                        t.hasReply = true;
                        t.replyIds.push(tweet.id);
                        break;
                    }
                }
            }
        });

        // Convert to threads and sort chronologically within each thread.
        const threads = firstSeenHandles
            .map(handle => threadsByHandle.get(handle))
            .filter(thread => thread && thread.length > 0);

        threads.forEach(thread => {
            thread.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        });

        // Sort threads by when the conversation started (timestamp of first tweet in that thread).
        threads.sort((a, b) => (a[0]?.timestamp || '').localeCompare(b[0]?.timestamp || ''));

        return threads;
    }

    function isYouTubeUrl(urlString) {
        try {
            const u = new URL(urlString);
            const host = u.hostname.toLowerCase().replace(/^www\./, '');
            return (
                host === 'youtu.be' ||
                host === 'youtube.com' ||
                host === 'm.youtube.com' ||
                host === 'music.youtube.com'
            );
        } catch {
            return false;
        }
    }

    function stripYouTubeUrlsFromLine(line) {
        // Remove YouTube URLs entirely (e.g. https://youtu.be/... or https://www.youtube.com/watch?...).
        // Also normalizes leftover whitespace.
        const withoutYoutube = line.replace(/\bhttps?:\/\/[^\s)]+/gi, (url) => {
            return isYouTubeUrl(url) ? '' : url;
        });

        return withoutYoutube
            .replace(/\s{2,}/g, ' ')
            .replace(/\(\s*\)/g, '') // just in case we removed a url already wrapped by older output
            .trimEnd();
    }

    function looksLikeUrlContinuation(line) {
        const t = (line || '').trim();
        if (!t) return false;
        // Conservative "URL-ish" charset (no spaces). This matches pieces like:
        // - youtu.be/abc?si
        // - =K5JB73AM...
        // - &t=12s
        return /^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(t);
    }

    function stripYouTubeUrlsFromLines(lines) {
        // Twitter's tweetText innerText can split links across lines, e.g.:
        //   https://
        //   youtu.be/ID?si
        //   =XYZ
        //   …
        //
        // This removes such multi-line YouTube link blocks entirely.
        const out = [];

        for (let i = 0; i < lines.length; ) {
            const line = lines[i] ?? '';
            const trimmed = line.trim();

            const isBareScheme = /^https?:\/\/$/i.test(trimmed);
            if (isBareScheme && i + 1 < lines.length) {
                let j = i;
                const parts = [];

                // Collect the bare scheme + subsequent "URL-ish" fragments.
                while (j < lines.length) {
                    const part = (lines[j] ?? '').trim();
                    if (!part) break;

                    // Consume a trailing ellipsis line if it immediately follows the URL fragments.
                    if (part === '…' || part === '...') {
                        parts.push(part);
                        j++;
                        break;
                    }

                    if (!looksLikeUrlContinuation(part)) break;
                    parts.push(part);
                    j++;
                }

                const candidateWithEllipsis = parts.join('');
                const candidate = candidateWithEllipsis.replace(/[.…]+$/g, '');

                // If this reconstructed candidate is a YouTube URL, drop all consumed lines.
                if (isYouTubeUrl(candidate)) {
                    i = j;
                    continue;
                }
            }

            out.push(line);
            i++;
        }

        return out;
    }

    function wrapBareUrlsForMarkdown(line) {
        // Wrap plain URLs as "(url)" (your original output style),
        // but avoid touching URLs that are already inside markdown link/image syntax.
        //
        // Examples to NOT rewrite:
        // - ![Alt|18](https://abs-0.twimg.com/emoji/v2/svg/xxxx.svg)
        // - [text](https://example.com)
        return (line || '').replace(/(?<!\]\()(?<!\)\()(?<!\()https?:\/\/[^\s)]+/g, '($&)');
    }

    function formatTimestamp(timestamp) {
        if (!timestamp) return '';
        const parsed = new Date(timestamp);
        if (!Number.isFinite(parsed.getTime())) return timestamp;
        const formatted = new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'UTC',
            timeZoneName: 'short'
        }).format(parsed);
        return formatted.replace(/,/g, '');
    }

    function formatTweet(tweet) {
        const indent = "\t".repeat(tweet.depth);
        const formattedTimestamp = formatTimestamp(tweet.timestamp) || 'unknown date';
        
        const hasRootLink = tweet.depth === 0;
        const dateLink = hasRootLink ? `[${formattedTimestamp}](${tweet.id})` : `[${formattedTimestamp}]`;
        // Prefer local avatar embeds (portable vault). If the file isn't downloaded yet, Obsidian will show a missing embed.
        // We still fall back to remote URL if local filename isn't available for any reason.
        const avatarMd = tweet.authorAvatarFile ? `![[${tweet.authorAvatarFile}|18]]` : (tweet.authorAvatarUrl ? `![|18](${tweet.authorAvatarUrl})` : '');
        const safeHandle = escapeMarkdownInlineText(tweet.authorHandle);
        let content = `${indent}${avatarMd}**${safeHandle}** ${dateLink}`;

        const textLines = stripYouTubeUrlsFromLines(tweet.text.split("\n"));
        if (textLines.length > 0 && textLines[0].trim()) {
            const textIndent = indent;
            const renderedLines = textLines
                .map(stripYouTubeUrlsFromLine)
                // NOTE: This intentionally removes *blank lines* from tweet text.
                // Twitter often includes empty lines in `innerText` (double newlines) for spacing.
                // Filtering them makes the exported markdown compact and (effectively) "removes line breaks"
                // between paragraphs by collapsing multiple consecutive newlines.
                .filter(line => line.trim().length > 0)
                .map(line => {
                    const formattedLine = wrapBareUrlsForMarkdown(line);
                    const safeLine = escapeMarkdownInlineTextPreservingUrls(formattedLine);
                    return `${textIndent}${safeLine}`;
                });

            if (renderedLines.length > 0) {
                content += "\n" + renderedLines.join("\n");
            }
        }

        // Append Obsidian image embeds for downloaded media filenames (safe even if file isn't present yet).
        // Example: ![[G74vDW1bEAAT6aD.jpg|400]]
        if (Array.isArray(tweet.photoFiles) && tweet.photoFiles.length > 0) {
            const width = 400;
            const embeds = tweet.photoFiles
                .filter(Boolean)
                .map(name => `${indent}![[${name}|${width}]]`);
            if (embeds.length > 0) {
                content += "\n" + embeds.join("\n");
            }
        }

        // Append Obsidian video embeds (stable filenames derived from video.twimg.com URLs).
        // Example: ![[Uh8iwW-Dw2JmvwBF.mp4|vid-20]]
        if (Array.isArray(tweet.videoFiles) && tweet.videoFiles.length > 0) {
            const embeds = tweet.videoFiles
                .filter(Boolean)
                .map(name => `${indent}![[${name}|vid-20]]`);
            if (embeds.length > 0) {
                content += "\n" + embeds.join("\n");
            }
        }

        // Voice posts: the download is handled via yt-dlp (exported as *_voice_ytdlp.ps1).
        // We embed a deterministic filename that the PS1 script will produce: voice_<tweetId>.m4a
        if (tweet.isVoicePost && tweet.id) {
            const restId = extractRestIdFromStatusUrl(tweet.id);
            if (restId) {
                content += `\n${indent}![[voice_${restId}.m4a|aud]]`;
            }
        }

        return content + "\n";
    }
