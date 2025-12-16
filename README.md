# Twitter Scraper for Obsidian

A browser extension that scrapes Twitter/X profiles and tweet threads, exporting them as Obsidian-compatible markdown with rich media support, translation integration, and intelligent conversation threading.

## Features

### 🎯 Core Scraping
- **Two scraping modes**: Profile `/with_replies` pages and individual tweet `/status` pages
- **Conversation-aware threading**: Automatically groups replies into threaded conversations on profile pages
- **Resume support**: Remember scraped tweets and continue from where you left off
- **Smart auto-stop**: Detects when you've reached the end of a timeline

### 🎨 Markdown Output
- **Obsidian-optimized**: Uses `![[filename]]` embed syntax for local media
- **Emoji preservation**: Converts Twitter emoji images to Unicode characters
- **Clean formatting**: Removes YouTube URLs (Twitter's embeds) and handles markdown escaping
- **Avatar embeds**: Includes profile avatars as 18px thumbnails
- **Media dimensions**: Photos (400px), videos (vid-20), voice notes (aud)

### 🔄 Translation Support
- **Immersive Translate integration**: Waits for translations to load before scraping
- **Deferred processing**: Automatically retries tweets if translations haven't appeared yet
- **Configurable wait times**: Adjust polling duration per your needs

### 📥 Media Handling
- **Photos**: Auto-detects `pbs.twimg.com/media/` filenames
- **Videos**: Intercepts network traffic to extract stable MP4 filenames
- **Voice posts**: Exports URLs for `yt-dlp` batch downloading
- **Avatars**: Exports download lists for profile pictures
- **MediaHarvest integration**: Auto-clicks the MediaHarvest extension button
- **Batch downloader**: Generates PowerShell scripts for offline media downloading

### 💾 Resume & Deduplication
- **Local storage**: Remembers scraped tweet IDs between sessions
- **Import/export**: Backup/restore your scraped ID list as JSON
- **Start tweet selection**: Resume from any tweet (click-to-select)
- **Checkpoint saving**: Automatically sets resume point after each download

## Prerequisites

- **Browser**: Chrome/Edge/Firefox with Manifest V3 support
- **Optional but recommended**:
  - [MediaHarvest extension](https://github.com/isaackogan/TwitterMediaHarvest) for video downloading
  - [Immersive Translate](https://immersivetranslate.com/) for translation support
  - [yt-dlp](https://github.com/yt-dlp/yt-dlp) for voice post downloading
  - [Obsidian](https://obsidian.md/) as the target markdown viewer

## Installation

### Option 1: Chrome Extension (Recommended)
1. Clone or download this repository
2. Open Chrome/Edge and go to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked" and select the extension directory
5. Navigate to any Twitter profile's `/with_replies` page or a tweet permalink
6. The scraper UI will appear in the top-left corner

### Option 2: Userscript (Alternative)
1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Copy the contents of `scraper.js`, `exporter.js`, and `ui.js`
3. Paste into a new userscript (remember the `@match` headers)
4. Save and navigate to Twitter/X

## Usage Guide

### Profile Scraping Mode (`/with_replies`)

**For scraping all tweets and replies from a profile:**

1. Navigate to `https://x.com/username/with_replies`
2. **Optional**: Click "Pick start tweet" then hover/click any tweet to resume from there
3. Click **Start Scraping**
4. The page will auto-scroll, collecting tweets and waiting for translations if enabled
5. Click **Stop and Download** when done (or enable auto-stop)

**What you get:**
- `[username]_with_replies.md` - Main markdown file
- `[username]_voice_tweets.txt` - Voice post URLs for yt-dlp
- `[username]_avatars.tsv` - Avatar download list
- `[username]_download_media.cmd` - Combined downloader script

### Tweet Thread Mode (`/status`)

**For scraping a specific tweet and its reply thread:**

1. Navigate to any tweet permalink (`https://x.com/user/status/1234567890`)
2. Click **Start Scraping**
3. The scraper will collect the root tweet and all visible replies
4. Click **Stop and Download**

**What you get:**
- `[username]_status_[tweet_id].md` - Thread markdown with proper nesting
- Same media export files as profile mode

### Auto-Scroll to Text

**Find a tweet by text content:**
1. Paste a snippet of the target tweet into the "Auto-scroll to text" field
2. Click **Scroll to text**
3. The page will auto-scroll until found or timeout
4. You can then use "Pick start tweet" to set it as your resume point

## Configuration Options

### Scraping Behavior
| Option | Description | Default |
|--------|-------------|---------|
| **Auto-stop when no new tweets** | Automatically stops when end of timeline detected | ✅ On |
| **Auto-download on auto-stop** | Triggers download immediately after auto-stop | ✅ On |
| **Scroll step (px)** | How many pixels to scroll per tick | 500px |
| **Remember scraped IDs** | Stores tweet IDs to skip on future runs | ✅ On |
| **Highlight scraped tweets** | Adds green outline to already-scraped tweets | ❌ Off |

### Translation (Immersive Translate)
| Option | Description | Default |
|--------|-------------|---------|
| **Wait for Immersive Translate** | Delays scraping until translations appear | ❌ Off |
| **Translation wait (ms)** | Max time to wait per tweet | 6000ms |

### Media Handling
| Option | Description | Default |
|--------|-------------|---------|
| **Auto-harvest via MediaHarvest** | Auto-clicks MediaHarvest buttons | ❌ Off |
| **Generate voice download list** | Exports yt-dlp batch file | ✅ On |
| **yt-dlp cookies browser** | Browser for authentication (firefox/chrome) | firefox |

### Resume Management
- **Export IDs**: Download your scraped ID list as JSON
- **Import IDs**: Restore from a previous export
- **Clear IDs**: Reset the remembered tweets database
- **Pick start tweet**: Click any tweet to resume from it next time
- **Clear start tweet**: Remove the resume checkpoint

## Media Download Workflow

### 1. Photos & Videos (via MediaHarvest)
- Install MediaHarvest extension
- Enable "Auto-harvest via MediaHarvest" in the scraper UI
- Videos will be downloaded automatically as you scrape

### 2. Voice Posts (via yt-dlp)
1. Ensure voice posts are detected (logs will show `[voice] <id>`)
2. After scraping, you'll get `*_voice_tweets.txt`
3. Run the generated `*_download_media.cmd` (Windows) or extract the PowerShell script for macOS/Linux
4. Files save as `voice_[tweet_id].m4a`

### 3. Avatars
1. The scraper generates `*_avatars.tsv` with handles, URLs, and local filenames
2. Run the `*_download_media.cmd` script to download all avatars
3. Avatars save as `avatar_[handle]_[original_name].[ext]`
4. Markdown embeds them as `![[avatar_...]]`

## Generated File Formats

### Markdown Structure
```
![[avatar_ayase_200x200.jpg|18]]**@ayase** [2024-12-15 14:30 UTC]
This is the tweet text with preserved emojis 🎉
![[G74vDW1bEAAT6aD.jpg|400]]
![[Uh8iwW-Dw2JmvwBF.mp4|vid-20]]
```

### TSV Format (avatars)
```
# handle	avatarUrl	localFile
@user1	https://.../avatar_200x200.jpg	avatar_user1_abc_200x200.jpg
@user2	https://.../def.png	avatar_user2_def_200x200.png
```

### Voice List (yt-dlp)
```
https://x.com/user1/status/1234567890
https://x.com/user2/status/1234567891
```

## Tips & Troubleshooting

### General
- **Don't clear browser data**: Remembered IDs are stored in localStorage
- **SPA navigation**: The scraper detects page changes automatically; no need to refresh
- **Large profiles**: Use "Pick start tweet" to break up long scraping sessions

### Media Issues
- **Missing videos**: Ensure MediaHarvest is installed and not rate-limited
- **Voice posts not detected**: Check browser console for `[voice]` logs; some may be missed
- **Avatar 404s**: Twitter sometimes serves deleted avatars; the scraper uses 200x200 variants

### Translation
- **Infinite waiting**: If translations never appear, disable "Wait for Immersive Translate"
- **Partial translations**: Increase "Translation wait (ms)" for slower connections
- **Mixed content**: The scraper prioritizes translated text when available

### Resume & Checkpoints
- **Not resuming**: Ensure "Remember scraped IDs" is enabled and IDs are imported
- **Wrong start point**: Use "Clear start tweet" if you selected the wrong one
- **Duplicate tweets**: Disable "Remember scraped IDs" to force re-scraping

### Performance
- **Slow scrolling**: Reduce "Scroll step (px)" for better loading
- **High CPU**: Disable "Highlight scraped tweets" on very long pages
- **Memory usage**: Export and clear IDs periodically for large profiles

## Technical Details

### Extension Architecture
- **Manifest V3**: Modern Chrome extension standard
- **Content scripts**: Injects into Twitter/X pages at `document_start`
- **Isolated world**: Runs in MAIN world to intercept network traffic
- **No background script**: All logic runs on-demand in-page

### Scraping Strategy
- **MutationObserver**: Watches for new tweet elements
- **XHR/Fetch interception**: Captures video URLs from GraphQL API responses
- **DOM walking**: Extracts emojis by reading `<img>` tags and converting to Unicode
- **Timeline parsing**: Uses vertical reply lines and "Replying to" banners to detect thread structure

### Data Flow
1. **Collection**: Tweets are extracted from `article[data-testid="tweet"]` elements
2. **Deduplication**: Checked against `scrapedIdSet` (session) and `rememberedScrapedIdSet` (persistent)
3. **Translation wait**: Defers processing if Immersive Translate wrapper is detected but content is missing
4. **Thread grouping**: Groups comments by username and pairs owner replies via DOM adjacency
5. **Chronological sorting**: Sorts threads by first tweet timestamp within each root section
6. **Export**: Generates markdown with depth-based indentation and media embeds

## License & Credits

Created for personal research and archival purposes. Respect Twitter's Terms of Service and users' privacy. Consider using the official API when possible.

---

**Note**: This tool stops at the DOM-visible timeline. For complete archival, consider combining with the official Twitter API or Wayback Machine snapshots.