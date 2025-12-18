'use strict';

// Search-run and search date range helpers for the Twitter scraper.
// NOTE:
// - This file is loaded before `scraper.js` (see `manifest.json`).
// - Only defines functions and small constants; no behaviour is executed on load.

// --- Search date range helpers (for shifting since:/until: windows) ---

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseSearchQueryDateToken(dateText) {
    if (!dateText) return null;
    const parts = String(dateText).split('-').map(p => parseInt(p, 10));
    if (parts.length !== 3) return null;
    const [y, m, d] = parts;
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    // Use UTC to avoid local timezone shifting the calendar date.
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt;
}

function formatSearchQueryDateToken(dt) {
    if (!(dt instanceof Date) || isNaN(dt.getTime())) return '';
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    // Keep a simple YYYY-M-D style; Twitter accepts both padded and unpadded.
    return `${y}-${m}-${d}`;
}

function getCurrentSearchDateRangeFromLocation() {
    try {
        const href = window.location?.href || '';
        const u = new URL(href, window.location.origin);
        const rawQ = u.searchParams.get('q') || '';
        const decoded = String(rawQ || '');

        const sinceMatch = decoded.match(/\bsince:(\d{4}-\d{1,2}-\d{1,2})\b/i);
        const untilMatch = decoded.match(/\buntil:(\d{4}-\d{1,2}-\d{1,2})\b/i);
        if (!sinceMatch && !untilMatch) return null;

        const sinceText = sinceMatch ? sinceMatch[1] : '';
        const untilText = untilMatch ? untilMatch[1] : '';

        const sinceDate = sinceText ? parseSearchQueryDateToken(sinceText) : null;
        const untilDate = untilText ? parseSearchQueryDateToken(untilText) : null;

        return {
            query: decoded,
            sinceText,
            untilText,
            sinceDate,
            untilDate
        };
    } catch {
        return null;
    }
}

// Human-readable description for UI
function describeCurrentSearchDateRange() {
    const info = getCurrentSearchDateRangeFromLocation();
    if (!info) return '';
    const parts = [];
    if (info.sinceText) parts.push(`since:${info.sinceText}`);
    if (info.untilText) parts.push(`until:${info.untilText}`);
    return parts.join(' ');
}

// Shift the current search ?q= date window left/right by approximately its own width.
// direction: +1 => forward in time, -1 => backward.
function shiftCurrentSearchDateRange(direction) {
    if (!direction || (direction !== 1 && direction !== -1)) {
        direction = 1;
    }

    // Only meaningful on search result / advanced search pages.
    const mode = getPageModeFromLocation();
    if (!(mode === 'search' || mode === 'search_advanced')) {
        setUiStatus?.('Date range controls are only available on /search pages.');
        return;
    }

    const info = getCurrentSearchDateRangeFromLocation();
    if (!info || !info.sinceDate || !info.untilDate) {
        setUiStatus?.('Could not find valid since:/until: dates in current search query.');
        return;
    }

    const spanMs = info.untilDate.getTime() - info.sinceDate.getTime();
    let spanDays = Math.round(spanMs / MS_PER_DAY);
    if (!Number.isFinite(spanDays) || spanDays <= 0) {
        spanDays = 15; // sensible default
    }

    const stepMs = spanDays * MS_PER_DAY * direction;

    const newSince = new Date(info.sinceDate.getTime() + stepMs);
    const newUntil = new Date(info.untilDate.getTime() + stepMs);

    const newSinceText = formatSearchQueryDateToken(newSince);
    const newUntilText = formatSearchQueryDateToken(newUntil);

    if (!newSinceText || !newUntilText) {
        setUiStatus?.('Failed to compute new date range.');
        return;
    }

    let newQuery = info.query;
    newQuery = newQuery.replace(/\bsince:\d{4}-\d{1,2}-\d{1,2}\b/i, `since:${newSinceText}`);
    newQuery = newQuery.replace(/\buntil:\d{4}-\d{1,2}-\d{1,2}\b/i, `until:${newUntilText}`);

    try {
        const href = window.location?.href || '';
        const u = new URL(href, window.location.origin);
        u.searchParams.set('q', newQuery);
        window.location.assign(u.toString());
    } catch {
        setUiStatus?.('Failed to navigate to shifted date range.');
    }
}

