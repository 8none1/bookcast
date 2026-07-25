#!/usr/bin/env python3
"""Split an .m4b audiobook into one file per embedded chapter, ready to upload
to a Bookcast book folder.

Bookcast's model is "one Drive file = one podcast episode". A single .m4b is
therefore one enormous episode with no chapter navigation, and almost always
over the ~100MB line where Drive serves a virus-scan HTML interstitial instead
of the audio. Splitting on the m4b's own chapter markers fixes both.

By default chapters are stream-copied (no re-encode: fast, lossless) into .m4a
files. Use --mp3 if you need maximum client compatibility.

As a side effect this also extracts the embedded cover art and writes a
metadata.json from the container tags, so Bookcast skips the Open Library
lookup entirely. The book folder is named from the container's title tag plus
the Audible ASIN where there is one, because downloaded filenames are routinely
mangled (duplicated subtitles, substituted colons) while the tags aren't.

Usage:
    ./split_m4b.py "This Way Up.m4b"
    ./split_m4b.py "This Way Up.m4b" -o ~/audiobooks --mp3 --bitrate 64k
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

MAX_SAFE_BYTES = 100 * 1024 * 1024  # Drive's virus-scan interstitial threshold


def run(cmd):
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:3])}...\n{proc.stderr.strip()}")
    return proc.stdout


def probe(path):
    raw = run(["ffprobe", "-v", "error", "-print_format", "json",
               "-show_chapters", "-show_format", "-show_streams", str(path)])
    return json.loads(raw)


def safe(name):
    """Filesystem- and Drive-safe filename fragment."""
    # "Title: Subtitle" reads better as "Title - Subtitle" than "Title- Subtitle".
    name = name.replace(":", " -")
    name = re.sub(r"[/\\*?\"<>|]", "-", name).strip().strip(".")
    return re.sub(r"\s+", " ", name)[:120] or "Chapter"


def tags_of(info):
    return {k.lower(): v for k, v in (info.get("format", {}).get("tags") or {}).items()}


def book_folder_name(info, source_stem):
    """Prefer the container's own title tag over the filename.

    Downloaders mangle filenames (this is where duplicated subtitles and
    substituted colons come from); the embedded tags are what the publisher
    actually wrote. Append the Audible ASIN when present so the folder is
    traceable back to the purchase. Bookcast's Open Library fallback strips
    anything in square brackets, so the ASIN can't poison a metadata lookup.
    """
    tags = tags_of(info)
    title = (tags.get("title") or tags.get("album") or source_stem).strip()

    # Audible titles are "Short Title: The Long Explanatory Subtitle", with the
    # subtitle repeated in its own tag. Folder names read far better without it
    # and the full title still lands in metadata.json, which is what actually
    # gets displayed. Only strip when the tags agree, so a title that merely
    # happens to contain a colon is left alone.
    subtitle = (tags.get("subtitle") or "").strip()
    if subtitle and title.lower().endswith(subtitle.lower()):
        trimmed = title[: -len(subtitle)].strip().rstrip(":-–—").strip()
        if trimmed:
            title = trimmed

    asin = (tags.get("audible_asin") or tags.get("asin") or "").strip()
    return safe(f"{title} [{asin}]" if asin else title)


def chapter_title(chapter, ordinal):
    title = (chapter.get("tags") or {}).get("title", "").strip()
    # Some encoders name every chapter "Chapter 01" already; don't double it up.
    return title or f"Chapter {ordinal:02d}"


def extract_cover(src, outdir):
    """Pull the attached picture out, if there is one. Bookcast picks the
    largest image in the folder as the cover, so the filename is arbitrary."""
    dest = outdir / "cover.jpg"
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src),
         "-an", "-map", "0:v:0", "-frames:v", "1", str(dest)],
        capture_output=True, text=True)
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        dest.unlink(missing_ok=True)
        return None
    return dest


def write_metadata(info, outdir, fallback_title):
    tags = tags_of(info)
    year = None
    m = re.search(r"(19|20)\d{2}", tags.get("date") or tags.get("year") or "")
    if m:
        year = int(m.group(0))
    meta = {
        "title": tags.get("title") or tags.get("album") or fallback_title,
        "author": tags.get("artist") or tags.get("album_artist")
                  or tags.get("composer") or "Unknown",
        "narrator": tags.get("narrator") or tags.get("performer") or "",
        "year": year,
        "description": tags.get("description") or tags.get("comment")
                       or tags.get("synopsis") or "",
        "language": "en",
    }
    dest = outdir / "metadata.json"
    dest.write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=pathlib.Path, help="the .m4b file")
    ap.add_argument("-o", "--outdir", type=pathlib.Path, default=pathlib.Path("."),
                    help="parent directory for the book folder (default: cwd)")
    ap.add_argument("--mp3", action="store_true",
                    help="transcode to MP3 instead of stream-copying to M4A")
    ap.add_argument("--bitrate", default="64k", help="MP3 bitrate (default: 64k)")
    ap.add_argument("--name", help="override the book folder name (default: the "
                                   "container's title tag + [ASIN])")
    args = ap.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")
    if not args.source.is_file():
        sys.exit(f"no such file: {args.source}")

    info = probe(args.source)
    chapters = info.get("chapters") or []
    book = safe(args.name) if args.name else book_folder_name(info, args.source.stem)
    outdir = args.outdir.expanduser() / book
    outdir.mkdir(parents=True, exist_ok=True)

    if not chapters:
        duration = float(info.get("format", {}).get("duration", 0))
        sys.exit(
            f"{args.source.name} has no embedded chapter markers "
            f"({duration / 3600:.1f}h of audio).\n"
            "Split it by hand, e.g. into 30-minute parts:\n"
            f'  ffmpeg -i "{args.source}" -f segment -segment_time 1800 '
            f'-c copy "{outdir}/part-%02d.m4a"'
        )

    ext = "mp3" if args.mp3 else "m4a"
    codec = ["-c:a", "libmp3lame", "-b:a", args.bitrate] if args.mp3 else ["-c:a", "copy"]
    width = max(2, len(str(len(chapters))))

    print(f"{len(chapters)} chapters -> {outdir}")
    written = []
    for i, ch in enumerate(chapters, start=1):
        title = chapter_title(ch, i)
        # Zero-padded ordinal prefix: Bookcast orders episodes by filename.
        dest = outdir / f"{i:0{width}d} - {safe(title)}.{ext}"
        run(["ffmpeg", "-v", "error", "-y", "-i", str(args.source),
             "-ss", ch["start_time"], "-to", ch["end_time"],
             "-map", "0:a:0", *codec,
             "-metadata", f"title={title}",
             "-metadata", f"track={i}/{len(chapters)}",
             str(dest)])
        size = dest.stat().st_size
        written.append((dest, size))
        flag = "  << OVER 100MB, split further" if size > MAX_SAFE_BYTES else ""
        print(f"  {dest.name}  ({size / 1048576:.1f}MB){flag}")

    cover = extract_cover(args.source, outdir)
    meta = write_metadata(info, outdir, book)

    print()
    print(f"cover:        {'cover.jpg' if cover else 'NONE - add a square >=1400px JPG yourself'}")
    print(f"metadata.json {meta['title']} / {meta['author']}")
    total = sum(s for _, s in written)
    print(f"total:        {total / 1048576:.0f}MB across {len(written)} files")
    print()
    print(f'Upload the whole "{book}" folder into your Bookcast Drive root, then run')
    print("flushCache() in the Apps Script editor.")


if __name__ == "__main__":
    main()
