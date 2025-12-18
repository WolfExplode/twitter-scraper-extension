'use strict';

// DOM parsing helpers for Twitter/X tweets.
// NOTE:
// - This file is loaded before `scraper.js` (see `manifest.json`).
// - It only defines functions; behaviour runs when called from `scraper.js`.

function getTweetIdFromTweetEl(tweetEl) {
    const a = tweetEl?.querySelector?.('a[href*="/status/"]');
    return normalizeStatusUrl(a?.href || '');
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
    // For top-level tweets that contain a quoted-tweet card, we *exclude* media that lives
    // inside the quote card; that media is attached to the quoted tweet instead.
    if (!tweetEl) return [];

    const out = new Set();

    // Pre-compute any embedded quote card containers so we can skip media inside them.
    const quoteCardEls = findQuoteCardElements?.(tweetEl) || [];
    const isInsideQuoteCard = (node) => {
        if (!node || quoteCardEls.length === 0) return false;
        for (const card of quoteCardEls) {
            if (card && card.contains(node)) return true;
        }
        return false;
    };

    // 1) Direct <img> tags (common).
    tweetEl.querySelectorAll('img[src*="pbs.twimg.com/media/"]').forEach(img => {
        if (isInsideQuoteCard(img)) return;
        const src = img.getAttribute('src') || '';
        const filename = normalizeTwitterMediaFilenameFromUrl(src);
        if (filename) out.add(filename);
    });

    // 2) Background-image styles (some layouts use this for photos).
    tweetEl.querySelectorAll('[style*="pbs.twimg.com/media/"]').forEach(el => {
        if (isInsideQuoteCard(el)) return;
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

function extractPollFromTweetElement(tweetEl) {
    if (!tweetEl) return null;

    const pollRoot = tweetEl.querySelector('[data-testid="cardPoll"]');
    if (!pollRoot) return null;

    const options = [];

    const items = pollRoot.querySelectorAll('li[role="listitem"]');
    items.forEach(li => {
        if (!li) return;

        // Best-effort: option label is usually the first dir="ltr" text block inside the item.
        let label = '';
        const labelBlock = li.querySelector('div[dir="ltr"]');
        if (labelBlock) {
            label = (labelBlock.innerText || labelBlock.textContent || '').trim();
        } else {
            label = (li.innerText || li.textContent || '').trim();
        }

        // Percent text is often in a trailing container with a number + "%" (e.g. "32.5%").
        let percent = '';
        const percentBlock = li.querySelector('div[dir="ltr"] span');
        if (percentBlock) {
            const raw = (percentBlock.innerText || percentBlock.textContent || '').trim();
            const m = raw.match(/[\d.,]+\s*%/);
            if (m) percent = m[0].replace(/\s+/g, '');
        }

        if (label) {
            options.push({
                label,
                percent
            });
        }
    });

    if (options.length === 0) return null;

    // Poll summary line (e.g. "80 votes · Final results").
    let summary = '';
    const summaryBlock = pollRoot.querySelector('div[dir="ltr"]');
    if (summaryBlock) {
        summary = (summaryBlock.innerText || summaryBlock.textContent || '').trim();
    }

    return { options, summary };
}

function findQuoteCardElements(tweetEl) {
    if (!tweetEl) return [];

    const cards = [];
    const seen = new Set();

    // --- Primary heuristic (2024+ X UI) ---
    // Look for nested "tweet-like" link cards that contain:
    // - a status URL
    // - a User-Name block and/or tweetText
    const linkCards = tweetEl.querySelectorAll('div[role="link"]');
    linkCards.forEach(card => {
        if (!card) return;

        const statusLink = card.querySelector('a[href*="/status/"]');
        if (!statusLink) return;

        const hasUser = !!card.querySelector('div[data-testid="User-Name"]');
        const hasText = !!card.querySelector('[data-testid="tweetText"]');
        if (!hasUser && !hasText) return;

        if (!seen.has(card)) {
            seen.add(card);
            cards.push(card);
        }
    });

    // --- Explicit "Quote" label + inline card (media + quote layout, no <a href="/status/">) ---
    // On some X layouts (especially when the outer tweet also has media), the quoted tweet
    // is rendered as:
    //
    //   <div id="...">
    //     <div dir="ltr">Quote</div>
    //     <div role="link"> ... compact tweet card ... </div>
    //   </div>
    //
    // The compact card has user name + tweet text, but *no* anchor with a /status/ URL.
    // We still want to treat that role="link" container as a quote card.
    if (cards.length === 0) {
        const labelEls = tweetEl.querySelectorAll('div[dir="ltr"], span[dir="ltr"]');
        labelEls.forEach(labelEl => {
            if (!labelEl) return;
            const text = (labelEl.innerText || labelEl.textContent || '').trim();
            if (!/^quote$/i.test(text)) return;

            let cardEl = null;

            // 1) The common pattern is that the label and card share a small wrapper div.
            const wrapper = labelEl.closest('div');
            if (wrapper) {
                cardEl = wrapper.querySelector('div[role="link"]');
            }

            // 2) Fallback: look at siblings under the same parent in case layout differs slightly.
            if (!cardEl && labelEl.parentElement) {
                let sib = labelEl.parentElement.firstElementChild;
                while (sib) {
                    if (sib !== labelEl) {
                        const candidate = sib.matches?.('div[role="link"]')
                            ? sib
                            : sib.querySelector?.('div[role="link"]');
                        if (candidate) {
                            cardEl = candidate;
                            break;
                        }
                    }
                    sib = sib.nextElementSibling;
                }
            }

            if (cardEl && !seen.has(cardEl)) {
                seen.add(cardEl);
                cards.push(cardEl);
            }
        });
    }

    // --- Fallback heuristic (older UI with explicit "Quote" label) ---
    if (cards.length === 0) {
        const containers = tweetEl.querySelectorAll('div[aria-labelledby]');
        containers.forEach(container => {
            if (!container) return;

            const labelEl =
                container.querySelector('div[dir="ltr"]') ||
                container.querySelector('span[dir="ltr"]') ||
                container.querySelector('div') ||
                container.querySelector('span');

            const labelText = (labelEl?.innerText || labelEl?.textContent || '').trim();
            if (!/^quote$/i.test(labelText)) return;

            const cardEl = container.querySelector('div[role="link"]');
            if (cardEl && !seen.has(cardEl)) {
                seen.add(cardEl);
                cards.push(cardEl);
            }
        });
    }

    // --- Last-resort heuristic (nested tweet/article or nested status link) ---
    // If nothing was found yet, try to locate a nested tweet/article that has its own status link.
    if (cards.length === 0) {
        const anchors = tweetEl.querySelectorAll('a[href*="/status/"]');
        anchors.forEach(a => {
            if (!a) return;
            const nestedArticle = a.closest('article[data-testid="tweet"]');
            if (nestedArticle && nestedArticle !== tweetEl && !seen.has(nestedArticle)) {
                seen.add(nestedArticle);
                cards.push(nestedArticle);
                return;
            }
            const linkContainer = a.closest('div[role="link"]');
            if (linkContainer && linkContainer !== tweetEl && !seen.has(linkContainer)) {
                seen.add(linkContainer);
                cards.push(linkContainer);
            }
        });
    }

    return cards;
}

function extractQuoteTweetFromTweetElement(tweetEl) {
    if (!tweetEl) return null;

    const cards = findQuoteCardElements(tweetEl);
    if (!cards || cards.length === 0) return null;

    // X only displays a single quoted tweet per post today; we take the first card.
    const card = cards[0];

    const tweetLinkElement = card.querySelector('a[href*="/status/"]');
    let tweetId = normalizeStatusUrl(tweetLinkElement?.href || '');

    // Fallback: some media+quote layouts render the quoted tweet as a card with no direct
    // <a href="/status/..."> link inside it. When Immersive Translate is active, a
    // data-immersive-translate-ai-subtitle-url attribute often carries the full X URL.
    if (!tweetId) {
        try {
            const subtitleHost = card.querySelector(
                '[data-immersive-translate-ai-subtitle-url*="/status/"]'
            );
            const subtitleUrl =
                subtitleHost?.getAttribute?.('data-immersive-translate-ai-subtitle-url') || '';
            if (subtitleUrl) {
                tweetId = normalizeStatusUrl(subtitleUrl);
            }
        } catch {
            // Best-effort only; never let DOM quirks break scraping.
        }
    }

    const tweetTextElement = card.querySelector('[data-testid="tweetText"]');
    const timeElement = (typeof pickBestTweetTimeElement === 'function')
        ? pickBestTweetTimeElement(card)
        : card.querySelector('time');

    // Extract display name + handle from the compact quote card layout.
    let authorName = '';
    let authorHandle = '';
    const userNameContainer = card.querySelector('div[data-testid="User-Name"]');
    if (userNameContainer) {
        const spans = Array.from(userNameContainer.querySelectorAll('span'));
        // Handle: span whose text looks like "@username".
        const handleSpan = spans.find(el => /^@[A-Za-z0-9_]{1,15}$/.test((el.innerText || el.textContent || '').trim()));
        if (handleSpan) {
            authorHandle = (handleSpan.innerText || handleSpan.textContent || '').trim();
        }
        // Name: first non-empty span that is not the handle and does not start with "@".
        const nameSpan = spans.find(el => {
            const t = (el.innerText || el.textContent || '').trim();
            if (!t) return false;
            if (t === authorHandle) return false;
            if (t.startsWith('@')) return false;
            return true;
        });
        if (nameSpan) {
            authorName = (nameSpan.innerText || nameSpan.textContent || '').trim();
        }
    }

    const hasNetworkVoice =
        (() => {
            const restId = extractRestIdFromStatusUrl(tweetId);
            return !!(restId && voiceDetectedByRestId.get(restId));
        })();
    const hasDomVoice =
        typeof domTweetLooksLikeVoicePost === 'function'
            ? domTweetLooksLikeVoicePost(card)
            : !!card.querySelector('[aria-label="Voice post"], [aria-label*="Voice post"], [aria-label*="voice"]');

    const quoteData = {
        id: tweetId,
        authorName,
        authorHandle,
        authorAvatarUrl: normalizeAvatarUrlTo200x200(extractAvatarUrl(card) || ''),
        authorAvatarFile: '',
        photoFiles: extractTweetPhotoFilenames(card),
        videoFiles: (() => {
            const restId = extractRestIdFromStatusUrl(tweetId);
            if (!restId) return [];
            const set = videoFilesByRestId.get(restId);
            return set ? Array.from(set) : [];
        })(),
        isVoicePost: hasNetworkVoice || hasDomVoice,
        text: extractTweetTextWithEmojis(tweetTextElement) || '',
        timestamp: timeElement?.getAttribute('datetime') || ''
    };

    // Determine a stable local avatar filename for markdown linking + export list.
    quoteData.authorAvatarFile = avatarFilenameFromUrlAndHandle(
        quoteData.authorAvatarUrl,
        quoteData.authorHandle
    );

    return quoteData;
}

function emojiUnicodeFromTwitterUrl(src) {
    if (!src) return null;

    // Parse codepoints from URL filename: .../emoji/v2/svg/1f9e0.svg or 1f3f3-fe0f-200d-1f308.svg
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

function getImmersiveTranslateContentNode(rootEl) {
    if (!rootEl) return null;

    // Core Immersive Translate content markers. These cover both block and inline
    // translation containers as used in the upstream extension.
    const TRANSLATION_SELECTOR = [
        '.immersive-translate-target-inner',
        '.immersive-translate-target-translation-block-wrapper',
        '.immersive-translate-target-translation-inline-wrapper',
        '.immersive-translate-target-translation-vertical-block-wrapper',
        '.immersive-translate-target-translation-pre-whitespace',
        '.immersive-translate-target-translation-pdf-block-wrapper',
        '[data-immersive-translate-translation-element-mark]'
    ].join(', ');

    // 1) Direct hits on the node itself or its descendants.
    if (rootEl.matches?.(TRANSLATION_SELECTOR)) return rootEl;
    const direct = rootEl.querySelector?.(TRANSLATION_SELECTOR);
    if (direct) return direct;

    // 2) Immersive sometimes injects translated DOM as a sibling or wrapper around
    // the original text node. Look at nearby siblings under the same parent.
    const parent = rootEl.parentElement;
    if (parent) {
        for (let node = parent.firstElementChild; node; node = node.nextElementSibling) {
            if (node === rootEl) continue;
            if (node.matches?.(TRANSLATION_SELECTOR)) return node;
            const nested = node.querySelector?.(TRANSLATION_SELECTOR);
            if (nested) return nested;
        }
    }

    // 3) Walk up to a nearby Immersive wrapper that might contain both original
    // and translated content, then search within it.
    const wrapper = rootEl.closest?.(
        '.immersive-translate-target-wrapper, [data-immersive-translate-paragraph]'
    );
    if (wrapper) {
        if (wrapper.matches?.(TRANSLATION_SELECTOR)) return wrapper;
        const nested = wrapper.querySelector?.(TRANSLATION_SELECTOR);
        if (nested) return nested;
    }

    return null;
}

function extractTweetTextWithEmojis(rootEl) {
    if (!rootEl) return '';

    const out = [];

    // Some translation extensions (e.g. Immersive Translate) inject translated content
    // as a sibling or wrapper around the original tweet text. Prefer scraping the
    // translated node (if present) instead of the original.
    const translatedInner = getImmersiveTranslateContentNode(rootEl);
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

function isImmersiveTranslateActiveOnPage() {
    // Best-effort: if the extension isn't installed/active, don't add unnecessary waits.
    return !!document.querySelector(
        [
            '.immersive-translate-target-wrapper',
            '.immersive-translate-target-inner',
            '.immersive-translate-target-translation-block-wrapper',
            '.immersive-translate-target-translation-inline-wrapper',
            '.immersive-translate-target-translation-vertical-block-wrapper',
            '.immersive-translate-target-translation-pre-whitespace',
            '.immersive-translate-target-translation-pdf-block-wrapper',
            '[data-immersive-translate-translation-element-mark]',
            '[data-immersive-translate-paragraph]'
        ].join(', ')
    );
}

// Best-effort DOM heuristic for detecting "voice posts" (audio notes) when
// network-based media detection (GraphQL interceptors) misses them. This is
// deliberately permissive and can be tuned over time.
function domTweetLooksLikeVoicePost(tweetEl) {
    if (!tweetEl || !tweetEl.querySelector) return false;

    try {
        // 1) Dedicated Voice post button (current X UI, English aria-label).
        if (tweetEl.querySelector('button[aria-label="Voice post"], button[aria-label*="Voice post"]')) {
            return true;
        }

        // 2) Generic voice/audio ARIA hints anywhere inside the tweet.
        if (tweetEl.querySelector('[aria-label*="voice"], [aria-label*="audio"], [data-testid*="voice"], [data-testid*="audio"]')) {
            // This may also catch other audio widgets, but downstream we only care
            // about flagging that this tweet *has* a voice-style media attachment.
            return true;
        }

        // 3) Fallback: look for a "Voice" badge plus a duration timecode like PT0H2M21S
        // inside the same control, which is how X renders voice tweet players today.
        const ltrBlocks = tweetEl.querySelectorAll('div[dir="ltr"], span[dir="ltr"]');
        for (const el of ltrBlocks) {
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt || !/\bVoice\b/i.test(txt)) continue;
            const host = el.closest('button,[role="button"],[data-testid]');
            if (host && host.querySelector('time[datetime^="PT"]')) {
                return true;
            }
        }
    } catch {
        // Never let DOM quirks break scraping.
    }

    return false;
}

// Prefer the actual tweet timestamp (ISO8601 date) over other <time> elements such
// as voice-note durations (e.g. datetime="PT0H2M21S") that can appear inside the
// tweet DOM. Falls back to the first <time> if no clear candidate is found.
function pickBestTweetTimeElement(rootEl) {
    if (!rootEl || !rootEl.querySelectorAll) return null;

    const times = rootEl.querySelectorAll('time[datetime]');
    if (!times || times.length === 0) return null;

    // 1) Prefer ISO8601-like datetimes that start with a calendar date.
    for (const t of times) {
        const dt = t.getAttribute('datetime') || '';
        if (/^\d{4}-\d{2}-\d{2}T/.test(dt)) {
            return t;
        }
    }

    // 2) Next-best: anything that is *not* an ISO8601 duration (PT...).
    for (const t of times) {
        const dt = t.getAttribute('datetime') || '';
        if (!/^PT/i.test(dt)) {
            return t;
        }
    }

    // 3) Fallback: first <time> element.
    return times[0] || null;
}

