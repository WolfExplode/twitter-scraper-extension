'use strict';

// Central configuration and constants shared by scraper, UI, and exporter.
// NOTE:
// - This file is loaded before `scraper.js` (see `manifest.json`).
// - We keep backwards-compatible global constant names so existing code
//   can continue to reference e.g. `SCRAPE_TICK_MS` directly.

const CONSTANTS = Object.freeze({
    STORAGE_KEYS: Object.freeze({
        startTweetId: 'wxp_tw_scraper_start_tweet_id',
        startTweetExclusive: 'wxp_tw_scraper_start_tweet_exclusive',
        scrollStepPx: 'wxp_tw_scraper_scroll_step_px',
        searchRunMaxStatusPosts: 'wxp_tw_scraper_search_run_max_status_posts',
        waitForImmersiveTranslate: 'wxp_tw_scraper_wait_for_immersive_translate',
        translationWaitMs: 'wxp_tw_scraper_translation_wait_ms',
        autoHarvestWithExtension: 'wxp_tw_scraper_auto_harvest_with_extension',
        exportVoiceYtDlp: 'wxp_tw_scraper_export_voice_ytdlp',
        ytDlpCookiesBrowser: 'wxp_tw_scraper_ytdlp_cookies_browser',
        rememberScrapedIdsEnabled: 'wxp_tw_scraper_remember_scraped_ids_enabled',
        rememberedScrapedIds: 'wxp_tw_scraper_remembered_scraped_ids_v1',
        searchRunState: 'wxp_tw_scraper_search_run_state_v1',
        searchAggregate: 'wxp_tw_scraper_search_aggregate_v1'
    }),

    TIMING: Object.freeze({
        // Smoother scraping tick timing.
        SCRAPE_TICK_MS: 600,           // was 1500
        SCRAPE_SCROLL_BASE_TICK_MS: 1500,

        // Auto-scroll helper timing.
        AUTO_SCROLL_TICK_MS: 200,      // was 850
        AUTO_SCROLL_BASE_TICK_MS: 850,

        // Translation polling interval.
        TRANSLATION_POLL_MS: 50
    }),

    LIMITS: Object.freeze({
        // Scroll step clamping.
        MIN_SCROLL_STEP_PX: 200,
        MAX_SCROLL_STEP_PX: 6000,
        MIN_EFFECTIVE_SCROLL_STEP_PX: 80,

        // Translation wait bounds.
        DEFAULT_TRANSLATION_WAIT_MS: 15000,
        MIN_TRANSLATION_WAIT_MS: 10000,
        MAX_TRANSLATION_WAIT_MS: 15000,

        // Search-run safety limit (multi-page).
        DEFAULT_SEARCH_RUN_MAX_STATUS_POSTS: 50,
        MIN_SEARCH_RUN_MAX_STATUS_POSTS: 15,
        MAX_SEARCH_RUN_MAX_STATUS_POSTS: 20,

        // Auto-stop / stall detection.
        MAX_NO_NEW_TICKS: 12,
        TIMELINE_NO_NEW_ELEMENT_PAUSE_MS: 1100,
        TIMELINE_LOAD_WAIT_MS: 10000,

        // Auto-scroll safeguard.
        AUTO_SCROLL_MAX_TICKS: 12000,

        // Translation stall detection on status pages.
        MAX_CONSECUTIVE_UNTRANSLATED_STATUS_TWEETS: 8
    }),

    DEFAULTS: Object.freeze({
        // Scroll step (constant; avoids zoom-dependent viewport math)
        DEFAULT_SCROLL_STEP_PX: 500,

        // Page "zoom" (CSS zoom) to load more content per viewport during scraping.
        SCRAPE_PAGE_ZOOM_PERCENT: 100,
        RESET_PAGE_ZOOM_PERCENT: 100,

        // Translation behaviour.
        DEFAULT_WAIT_FOR_IMMERSIVE_TRANSLATE: false,

        // Auto-stop behaviour.
        AUTO_STOP_ENABLED: true,
        AUTO_DOWNLOAD_ON_AUTO_STOP: true
    })
});

// Backwards-compatible globals for existing code paths.

// Storage
const STORAGE_KEYS = CONSTANTS.STORAGE_KEYS;

// Scroll and timing
const DEFAULT_SCROLL_STEP_PX = CONSTANTS.DEFAULTS.DEFAULT_SCROLL_STEP_PX;
const MIN_SCROLL_STEP_PX = CONSTANTS.LIMITS.MIN_SCROLL_STEP_PX;
const MAX_SCROLL_STEP_PX = CONSTANTS.LIMITS.MAX_SCROLL_STEP_PX;

const SCRAPE_TICK_MS = CONSTANTS.TIMING.SCRAPE_TICK_MS;
const SCRAPE_SCROLL_BASE_TICK_MS = CONSTANTS.TIMING.SCRAPE_SCROLL_BASE_TICK_MS;
const AUTO_SCROLL_TICK_MS = CONSTANTS.TIMING.AUTO_SCROLL_TICK_MS;
const AUTO_SCROLL_BASE_TICK_MS = CONSTANTS.TIMING.AUTO_SCROLL_BASE_TICK_MS;
const MIN_EFFECTIVE_SCROLL_STEP_PX = CONSTANTS.LIMITS.MIN_EFFECTIVE_SCROLL_STEP_PX;
const AUTO_SCROLL_MAX_TICKS = CONSTANTS.LIMITS.AUTO_SCROLL_MAX_TICKS;

// Search-run limits
const DEFAULT_SEARCH_RUN_MAX_STATUS_POSTS = CONSTANTS.LIMITS.DEFAULT_SEARCH_RUN_MAX_STATUS_POSTS;
const MIN_SEARCH_RUN_MAX_STATUS_POSTS = CONSTANTS.LIMITS.MIN_SEARCH_RUN_MAX_STATUS_POSTS;
const MAX_SEARCH_RUN_MAX_STATUS_POSTS = CONSTANTS.LIMITS.MAX_SEARCH_RUN_MAX_STATUS_POSTS;

// Translation settings
const DEFAULT_WAIT_FOR_IMMERSIVE_TRANSLATE = CONSTANTS.DEFAULTS.DEFAULT_WAIT_FOR_IMMERSIVE_TRANSLATE;
const DEFAULT_TRANSLATION_WAIT_MS = CONSTANTS.LIMITS.DEFAULT_TRANSLATION_WAIT_MS;
const MIN_TRANSLATION_WAIT_MS = CONSTANTS.LIMITS.MIN_TRANSLATION_WAIT_MS;
const MAX_TRANSLATION_WAIT_MS = CONSTANTS.LIMITS.MAX_TRANSLATION_WAIT_MS;
const TRANSLATION_POLL_MS = CONSTANTS.TIMING.TRANSLATION_POLL_MS;
const MAX_CONSECUTIVE_UNTRANSLATED_STATUS_TWEETS = CONSTANTS.LIMITS.MAX_CONSECUTIVE_UNTRANSLATED_STATUS_TWEETS;

// Auto-stop behaviour
const MAX_NO_NEW_TICKS = CONSTANTS.LIMITS.MAX_NO_NEW_TICKS;
const TIMELINE_NO_NEW_ELEMENT_PAUSE_MS = CONSTANTS.LIMITS.TIMELINE_NO_NEW_ELEMENT_PAUSE_MS;
const TIMELINE_LOAD_WAIT_MS = CONSTANTS.LIMITS.TIMELINE_LOAD_WAIT_MS;

// Page zoom defaults
const SCRAPE_PAGE_ZOOM_PERCENT = CONSTANTS.DEFAULTS.SCRAPE_PAGE_ZOOM_PERCENT;
const RESET_PAGE_ZOOM_PERCENT = CONSTANTS.DEFAULTS.RESET_PAGE_ZOOM_PERCENT;

// Common DOM selectors used across the codebase. This is intentionally small and can
// be grown over time as more selectors are reused in multiple places.
const SELECTORS = Object.freeze({
    TWEET: 'article[data-testid="tweet"]',
    TWEET_TEXT: '[data-testid="tweetText"]',
    USER_NAME: 'div[data-testid="User-Name"]'
});

