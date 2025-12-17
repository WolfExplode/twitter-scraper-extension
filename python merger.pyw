#!/usr/bin/env python3
"""
Twitter Status Merger
Scans ALL .md files, extracts tweets with full hierarchies, and merges chronologically.
Uses top-level tweet's timestamp for sorting.
"""

import os
import re
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Set, Iterator, Tuple


class Tweet:
    def __init__(self, url: str, timestamp: datetime, content: str, source: str):
        self.url = url
        self.timestamp = timestamp
        self.content = content
        self.source = source


def extract_tweets_from_content(content: str, source_file: str) -> Iterator[Tweet]:
    """
    Extract tweet blocks with full hierarchy (including replies).
    Uses top-level tweet's timestamp and URL for each block.
    """

    # Pattern matches entire top-level tweet blocks including nested replies
    # Captures: 1=full block, 2=username, 3=timestamp str, 4=URL, 5=remaining content
    top_level_pattern = re.compile(
        r'^(\s*!\[(?:\|?\d*\]\([^)]+\)|\[[^]|]+\|\d+\]\])\s*\*\*@([A-Za-z0-9_]+)\*\*\s*\[([^\]]+)\]\((https?://(?:x\.com|twitter\.com)/[^?]+)[^)]*\)(.*?))(?=^!\[(?:\|?\d*\]\(|\[[^]|]+\|\d+\]\])\s*\*\*@[^\*]+\*\*\s*\[|\Z)',
        re.MULTILINE | re.DOTALL
    )

    for match in top_level_pattern.finditer(content):
        full_block = match.group(1).strip()
        username = match.group(2)
        ts_str = match.group(3)
        url = match.group(4).split('?')[0]

        # Parse timestamp
        ts = None
        for fmt in ['%b %d %Y %H:%M UTC', '%b %d %Y %H:%M:%S UTC']:
            try:
                ts = datetime.strptime(ts_str, fmt)
                break
            except ValueError:
                continue

        if ts:
            yield Tweet(url, ts, full_block, source_file)


def get_username_from_file(filename: str) -> Optional[str]:
    """Extract username from status filename or content."""
    try:
        with open(filename, 'r', encoding='utf-8') as f:
            first_line = f.readline()
            if m := re.search(r'\*\*@([A-Za-z0-9_]{1,15})\*\*', first_line):
                return m.group(1)
    except:
        pass

    if m := re.match(r'^([^_]+)_status_\d+\.md$', Path(filename).name):
        return m.group(1)

    return None


def load_merged(path: Path) -> Tuple[List[Tweet], Set[str]]:
    """Load existing merged file and return (tweets, urls)."""
    if not path.exists():
        return [], set()

    try:
        content = path.read_text(encoding='utf-8')
        tweets = []
        urls = set()

        # Parse each tweet block in the merged file
        for block in re.split(r'\n---+\n', content):
            block = block.strip()
            if not block or block.startswith('# '):
                continue

            if src_match := re.match(r'^<!-- Source: (.+?) -->', block, re.MULTILINE):
                source = src_match.group(1)
                tweet_content = re.sub(r'^<!-- Source: .+? -->\n?', '', block, count=1).strip()

                for tweet in extract_tweets_from_content(tweet_content, source):
                    tweets.append(tweet)
                    urls.add(tweet.url)
                    break  # Only need the first tweet from each block

        return tweets, urls

    except Exception as e:
        return [], set()


def save_merged(path: Path, tweets: List[Tweet], username: str) -> int:
    """Save merged file, return count."""
    tweets.sort(key=lambda t: t.timestamp, reverse=True)

    # Deduplicate by URL, keep newest
    seen = {}
    for t in tweets:
        if t.url not in seen or t.timestamp > seen[t.url].timestamp:
            seen[t.url] = t

    unique = list(seen.values())
    unique.sort(key=lambda t: t.timestamp, reverse=True)

    lines = [
        f"# Consolidated Twitter Status Posts for @{username}",
        "",
        f"**Export Key:** {username}  ",
        f"**Total Tweets:** {len(unique)}  ",
    ]

    if unique:
        lines.append(
            f"**Date Range:** {unique[-1].timestamp:%b %d %Y %H:%M UTC} → {unique[0].timestamp:%b %d %Y %H:%M UTC}")

    lines.extend(["", "---", "", ""])

    for t in unique:
        # Ensure proper separation between blocks
        block_lines = t.content.split('\n')
        formatted_block = '\n'.join(block_lines)

        lines.extend([
            formatted_block,
            ""
        ])

    # Atomic write
    temp_fd, temp_path = tempfile.mkstemp(dir=str(path.parent), suffix='.tmp')
    try:
        with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))
        shutil.move(temp_path, str(path))
        return len(unique)
    except:
        os.unlink(temp_path)
        raise


def main():
    directory = Path.cwd()

    # Find ALL markdown files (not just status_*.md)
    md_files = [f for f in directory.iterdir()
                if f.is_file() and f.suffix.lower() == '.md' and not f.name.endswith('_merged.md')]

    if not md_files:
        print("No markdown files found")
        return

    # Determine username from first file
    username = None
    for f in md_files:
        if username := get_username_from_file(f):
            break

    if not username:
        print("Could not extract username from any file")
        return

    merged_path = directory / f"{username}_data_merged.md"

    # Remove merged path from processing if it exists
    if merged_path in md_files:
        md_files.remove(merged_path)

    all_tweets, seen_urls = load_merged(merged_path)

    # Process all markdown files
    new_count = 0
    for f in md_files:
        try:
            content = f.read_text(encoding='utf-8')
            file_tweets = list(extract_tweets_from_content(content, f.name))
            print(f"Processing {f.name}: found {len(file_tweets)} tweet blocks")

            for tweet in file_tweets:
                if tweet.url not in seen_urls:
                    all_tweets.append(tweet)
                    seen_urls.add(tweet.url)
                    new_count += 1
        except Exception as e:
            print(f"Error processing {f.name}: {e}")

    if new_count == 0:
        print(f"No new tweets. Total: {len(all_tweets)}")
        return

    print(f"Adding {new_count} new tweet blocks...")

    total = save_merged(merged_path, all_tweets, username)
    print(f"✅ Updated {merged_path.name} with {total} total tweet blocks")

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        raise