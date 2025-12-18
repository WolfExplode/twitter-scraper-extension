'use strict';

// Exporter helpers: markdown + ID / media export utilities.
// Depends on core helpers defined in `scraper.js` (e.g. formatTweet, extractRestIdFromStatusUrl, etc.).

function prefixBlockquoteToTweetMarkdown(block) {
    // Given the markdown for a single tweet (as returned by `formatTweet`),
    // prefix each non-empty line with a leading `>` so it renders as part of
    // an existing Obsidian callout / blockquote.
    //
    // Important:
    // - We skip lines that already begin with `>` so we don't double-nest.
    // - We preserve leading tabs/spaces *after* the `> ` so indentation is kept.
    const lines = String(block || '').split('\n');
    const out = lines.map(line => {
        if (!line) return line;
        if (/^\s*>/.test(line)) return line;
        return `> ${line}`;
    });
    return out.join('\n');
}

function generateMarkdown(tweets, filename) {
    let mdContent = '';
    // When a root tweet (depth 0) contains a quote, we add a horizontal rule
    // after its callout. For readability, we also want the *first-level* replies
    // that follow to be rendered flush-left (no leading tab), while keeping
    // deeper replies indented. We track that with a simple flag.
    let quoteIndentOffsetActive = false;

    tweets.forEach(tweet => {
        if (tweet.separator) {
            mdContent += '\n';
            quoteIndentOffsetActive = false;
            return;
        }

        // Any new root tweet ends the indentation offset from a previous quote.
        if (tweet.depth === 0) {
            quoteIndentOffsetActive = false;
        }

        // After a root+quote, drop one level of indentation for replies so that
        // depth-1 tweets render without a leading tab, and depth-2 tweets render
        // with a single tab (etc.).
        let effectiveTweet = tweet;
        if (quoteIndentOffsetActive && typeof tweet.depth === 'number' && tweet.depth > 0) {
            effectiveTweet = {
                ...tweet,
                depth: Math.max(0, (tweet.depth || 0) - 1)
            };
        }

        let block = formatTweet(effectiveTweet);

        mdContent += block;

        // For quote tweets, add a horizontal rule immediately after the quote
        // callout block so that subsequent replies render as normal tweets
        // outside the callout (matching the desired layout).
        if (tweet.depth === 0 && tweet.quote) {
            mdContent += '---\n';
            quoteIndentOffsetActive = true;
        }
    });

    downloadMarkdown(mdContent, filename);
}

function downloadMarkdown(content, filename) {
    // Force UTF-8 (and include BOM) so Windows editors don't mis-detect encoding and mangle CJK text.
    const utf8WithBom = "\uFEFF" + String(content ?? '');
    const blob = new Blob([utf8WithBom], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function collectUniqueVoiceTweetUrlsFromScrapedData(allTweets) {
    const out = new Set();
    for (const t of (allTweets || [])) {
        if (!t?.id) continue;
        if (!t.isVoicePost) continue;
        out.add(normalizeStatusUrl(t.id));
    }
    return Array.from(out);
}

function exportVoiceTweetUrlListFile(allTweets, accountName) {
    const urls = collectUniqueVoiceTweetUrlsFromScrapedData(allTweets);
    if (!urls || urls.length === 0) return;

    const safeAccount = String(accountName || 'account').replace(/[^a-z0-9_-]/gi, '_');
    const listFilename = `${safeAccount}_voice_tweets.txt`;

    const listContent = urls.join('\n') + '\n';

    downloadTextFile(listContent, listFilename);
}

function collectUniqueAvatarDownloads(allTweets) {
    // Returns array of { handle, url, file } with unique (handle+url).
    const out = [];
    const seen = new Set();
    for (const t of (allTweets || [])) {
        const handle = String(t?.authorHandle || '').trim();
        const url = String(t?.authorAvatarUrl || '').trim();
        const file = String(t?.authorAvatarFile || '').trim();
        if (!handle || !url || !file) continue;
        const key = `${handle}\n${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ handle, url, file });
    }
    return out;
}

function exportAvatarDownloadFiles(allTweets, accountName) {
    const rows = collectUniqueAvatarDownloads(allTweets);
    if (!rows || rows.length === 0) return;

    const safeAccount = String(accountName || 'account').replace(/[^a-z0-9_-]/gi, '_');
    const tsvFilename = `${safeAccount}_avatars.tsv`;

    // TSV: handle \t url \t file
    const tsv = [
        '# handle\tavatarUrl\tlocalFile',
        ...rows.map(r => `${r.handle}\t${r.url}\t${r.file}`)
    ].join('\r\n') + '\r\n';

    downloadTextFile(tsv, tsvFilename);
}

function exportCombinedDownloadMediaRunner(accountName) {
    const safeAccount = String(accountName || 'account').replace(/[^a-z0-9_-]/gi, '_');
    const filename = `${safeAccount}_download_media.cmd`;

    const cookiesBrowser = String(ytDlpCookiesBrowser || DEFAULT_YTDLP_COOKIES_BROWSER).trim() || DEFAULT_YTDLP_COOKIES_BROWSER;
    const avatarTsv = `${safeAccount}_avatars.tsv`;
    const voiceList = `${safeAccount}_voice_tweets.txt`;

    // Hybrid .cmd -> extracts embedded PowerShell payload to a temp .ps1, then runs it
    // from the correct working directory. This version matches the hand-fixed
    // `*_download_media corrected.cmd` layout and also:
    //   - Creates an `avatars` subfolder
    //   - Prints helpful debug information
    //   - Keeps the window open at the end
    const content = [
        ':: Save this file as ANSI or UTF-8 without BOM',
        '@echo off',
        'setlocal EnableExtensions EnableDelayedExpansion',
        'set "WXP_ROOT=%~dp0"',
        'set "SELF=%~f0"',
        'set "TMP=%TEMP%\\%~n0_%RANDOM%.ps1"',
        '',
        ':: --- CONFIGURE THESE FILENAMES ---',
        'set "AVATAR_TSV=' + avatarTsv + '"',
        'set "VOICE_LIST=' + voiceList + '"',
        'set "COOKIES_BROWSER=' + cookiesBrowser + '"',
        '',
        ':: Extract PowerShell payload',
        'for /f "delims=:" %%A in (\'findstr /n "^:POWERSHELL_PAYLOAD$" "%SELF%"\') do set "LINE=%%A"',
        'if not defined LINE (',
        '    echo ERROR: POWERSHELL payload marker not found.',
        '    pause',
        '    exit /b 1',
        ')',
        'set /a SKIP=LINE',
        'more +%SKIP% "%SELF%" > "%TMP%"',
        '',
        ':: --- RUN POWERSHELL FROM CORRECT DIRECTORY ---',
        'echo ==================== DEBUG INFO ====================',
        'echo Script directory: %WXP_ROOT%',
        'echo Avatar file: %AVATAR_TSV%',
        'echo Looking for file at: %WXP_ROOT%%AVATAR_TSV%',
        'echo Output folder: %WXP_ROOT%avatars',
        'echo ===================================================',
        'echo.',
        '',
        'cd /d "%WXP_ROOT%"',
        'pwsh -NoProfile -ExecutionPolicy Bypass -File "%TMP%" -workingDir "%WXP_ROOT%." -avatarTsv "%AVATAR_TSV%" -voiceList "%VOICE_LIST%" -cookiesBrowser "%COOKIES_BROWSER%"',
        'set "EC=%ERRORLEVEL%"',
        'del "%TMP%" >nul 2>nul',
        '',
        ':: --- KEEP WINDOW OPEN ---',
        'echo.',
        'if %EC% NEQ 0 (',
        '    echo ==================== ERROR CODE %EC% ====================',
        ') else (',
        '    echo ==================== COMPLETE ====================',
        ')',
        'pause',
        'exit /b %EC%',
        '',
        ':POWERSHELL_PAYLOAD',
        'param(',
        '    [string]$workingDir,',
        '    [string]$avatarTsv,',
        '    [string]$voiceList,',
        '    [string]$cookiesBrowser',
        ')',
        '',
        '$ErrorActionPreference = "Stop"',
        '$ScriptRoot = $workingDir  # Use the directory passed from CMD',
        '',
        'Write-Host "Working directory: $ScriptRoot"',
        'Write-Host "Avatar TSV: $avatarTsv"',
        'Write-Host "Voice list: $voiceList"',
        'Write-Host ""',
        '',
        '# Create avatars subdirectory',
        '$avatarDir = Join-Path $ScriptRoot "avatars"',
        'if (-not (Test-Path $avatarDir)) {',
        '    New-Item -ItemType Directory -Path $avatarDir -Force | Out-Null',
        '    Write-Host "Created avatars folder: $avatarDir"',
        '}',
        '',
        '# Download Avatars',
        '$AvatarPath = Join-Path $ScriptRoot $avatarTsv',
        'if (Test-Path $AvatarPath) {',
        '    Write-Host "Found TSV file: $AvatarPath"',
        '    $rows = Get-Content -LiteralPath $AvatarPath | Where-Object { $_ -and -not $_.StartsWith("#") }',
        '    foreach ($row in $rows) {',
        '        $parts = $row -split "`t"',
        '        if ($parts.Count -lt 3) { continue }',
        '        $handle = $parts[0].Trim()',
        '        $url = $parts[1].Trim()',
        '        $file = $parts[2].Trim()',
        '        if (-not $url -or -not $file) { continue }',
        '        ',
        '        $outFile = Join-Path $avatarDir $file  # Save to avatars folder',
        '        Write-Host "`n[avatar] $handle"',
        '        Write-Host "         From: $url"',
        '        Write-Host "         To:   $outFile"',
        '        ',
        '        if (Test-Path $outFile) {',
        '            Write-Host "         Status: Already exists, skipping"',
        '            continue',
        '        }',
        '        ',
        '        try {',
        '            Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing',
        '            Write-Host "         Status: SUCCESS"',
        '        } catch {',
        '            Write-Warning "Failed: $($_.Exception.Message)"',
        '        }',
        '    }',
        '} else {',
        '    Write-Warning "FILE NOT FOUND: $AvatarPath"',
        '    Write-Host "Current directory contents:"',
        '    Get-ChildItem $ScriptRoot | Where-Object { $_.Name -like "*avatar*" } | ForEach-Object { Write-Host "  - $($_.Name)" }',
        '}',
        '',
        '# Voice posts (yt-dlp)',
        'if ($voiceList) {',
        '    $VoicePath = Join-Path $ScriptRoot $voiceList',
        '    if (Test-Path $VoicePath) {',
        '        $urls = Get-Content -LiteralPath $VoicePath | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }',
        '        if ($urls.Count -gt 0) {',
        '            foreach ($u in $urls) {',
        '                $m = [regex]::Match($u, "/status/(?<id>\\d+)")',
        '                if (-not $m.Success) {',
        '                    Write-Warning ("[voice] Skipping (no status id): " + $u)',
        '                    continue',
        '                }',
        '                $id = $m.Groups["id"].Value',
        '                $out = ("voice_" + $id + ".%(ext)s")',
        '                Write-Host ("[voice] " + $id)',
        '                try {',
        '                    yt-dlp --cookies-from-browser $cookiesBrowser -x --audio-format m4a --no-overwrites --continue -o $out $u',
        '                } catch {',
        '                    Write-Warning ("[voice] yt-dlp failed for: " + $u)',
        '                }',
        '            }',
        '        }',
        '    } else {',
        '        Write-Host ("No voice list found: " + $VoicePath)',
        '    }',
        '} else {',
        '    Write-Host "No voice list configured; skipping voice downloads."',
        '}',
        '',
        'Write-Host ""',
        'pause'
    ].join('\r\n');

    // IMPORTANT: Do NOT prepend a BOM here. A UTF-8 BOM at the start of a .cmd file
    // shows up as strange characters (e.g. "∩╗┐") and breaks the first command.
    const blob = new Blob([String(content ?? '')], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function downloadTextFile(content, filename) {
    // Plain UTF-8 without BOM (safe for .tsv, .txt, etc. and avoids issues in tools
    // that treat a BOM as literal text).
    const blob = new Blob([String(content ?? '')], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

