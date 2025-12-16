'use strict';

// Exporter helpers: markdown + ID / media export utilities.
// Depends on core helpers defined in `scraper.js` (e.g. formatTweet, extractRestIdFromStatusUrl, etc.).

function generateMarkdown(tweets, filename) {
    let mdContent = '';
    
    tweets.forEach(tweet => {
        if (tweet.separator) {
            mdContent += '\n'; // Blank line between root tweets
        } else {
            mdContent += formatTweet(tweet);
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

    // Hybrid .cmd -> extracts embedded PowerShell payload to a temp .ps1, then runs it.
    // This avoids "polyglot" tricks that don't reliably execute under cmd.exe.
    const content = [
        '@echo off',
        'setlocal EnableExtensions EnableDelayedExpansion',
        'set "WXP_ROOT=%~dp0"',
        'set "SELF=%~f0"',
        'set "TMP=%TEMP%\\%~n0_%RANDOM%.ps1"',
        'for /f "delims=:" %%A in (\'findstr /n "^:POWERSHELL_PAYLOAD$" "%SELF%"\') do set "LINE=%%A"',
        'if not defined LINE (',
        '  echo ERROR: POWERSHELL payload marker not found.',
        '  exit /b 1',
        ')',
        'set /a SKIP=LINE',
        'more +%SKIP% "%SELF%" > "%TMP%"',
        'pwsh -NoProfile -ExecutionPolicy Bypass -File "%TMP%" %*',
        'set "EC=%ERRORLEVEL%"',
        'del "%TMP%" >nul 2>nul',
        'exit /b %EC%',
        ':POWERSHELL_PAYLOAD',
        '',
        '$ErrorActionPreference = "Stop"',
        '$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition',
        '$AvatarTsv = Join-Path $ScriptRoot "' + "${avatarTsv}" + '"',
        '$VoiceList = Join-Path $ScriptRoot "' + "${voiceList}" + '"',
        '$CookiesBrowser = "' + "${cookiesBrowser}" + '"',
        '',
        'Write-Host "Working directory: $ScriptRoot"',
        'Write-Host "Avatar TSV:      $AvatarTsv"',
        'Write-Host "Voice list:      $VoiceList"',
        'Write-Host ""',
        '',
        'if (Test-Path $AvatarTsv) {',
        '  $rows = Get-Content -LiteralPath $AvatarTsv | Where-Object { $_ -and -not $_.StartsWith("#") }',
        '  foreach ($row in $rows) {',
        '    $parts = $row -split "`t"',
        '    if ($parts.Count -lt 3) { continue }',
        '    $handle = $parts[0].Trim()',
        '    $url    = $parts[1].Trim()',
        '    $file   = $parts[2].Trim()',
        '    if (-not $url) { continue }',
        '    if (-not $file) { continue }',
        '    Write-Host ("[avatar] " + $handle + " -> " + $file)',
        '    try {',
        '      Invoke-WebRequest -Uri $url -OutFile (Join-Path $ScriptRoot $file) -UseBasicParsing',
        '    } catch {',
        '      Write-Warning ("[avatar] Failed to download for " + $handle + ": " + $_.Exception.Message)',
        '    }',
        '  }',
        '} else {',
        '  Write-Host ("No avatar TSV found: " + $AvatarTsv)',
        '}',
        '',
        '## Voice posts (yt-dlp)',
        'if (Test-Path $VoiceList) {',
        '  $urls = Get-Content -LiteralPath $VoiceList | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }',
        '  if ($urls.Count -gt 0) {',
        '    foreach ($u in $urls) {',
        '      $m = [regex]::Match($u, "/status/(?<id>\\d+)")',
        '      if (-not $m.Success) {',
        '        Write-Warning ("[voice] Skipping (no status id): " + $u)',
        '        continue',
        '      }',
        '      $id = $m.Groups["id"].Value',
        '      $out = ("voice_" + $id + ".%(ext)s")',
        '      Write-Host ("[voice] " + $id)',
        '      try {',
        '        yt-dlp --cookies-from-browser $CookiesBrowser -x --audio-format m4a --no-overwrites --continue -o $out $u',
        '      } catch {',
        '        Write-Warning ("[voice] yt-dlp failed for: " + $u)',
        '      }',
        '    }',
        '  }',
        '} else {',
        '  Write-Host ("No voice list found: " + $VoiceList)',
        '}',
        '',
        'Write-Host ""',
        'Write-Host "Done."',
        ''
    ].join('\r\n');

    downloadTextFile(content, filename);
}

function downloadTextFile(content, filename) {
    // Force UTF-8 (and include BOM) so Windows editors don't mis-detect encoding.
    const utf8WithBom = "\uFEFF" + String(content ?? '');
    const blob = new Blob([utf8WithBom], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}


