import re
import time
import logging
from typing import Optional, List, Dict, Any
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from ytmusicapi import YTMusic

from models.schemas import NormalizedTrackCandidate, LyricsResponse, LyricLine, RadioResponse

import os
logger = logging.getLogger("ytmusic_provider")

OPERATION_TIMEOUT_SECONDS = float(os.environ.get("OPERATION_TIMEOUT_SECONDS", "3.5"))

def parse_duration_to_ms(duration_val: Any) -> Optional[int]:
    """Converts duration string (e.g. '3:45', '1:02:15') or numeric seconds to integer milliseconds."""
    if duration_val is None:
        return None
    if isinstance(duration_val, (int, float)):
        return int(duration_val * 1000)
    if isinstance(duration_val, str):
        parts = duration_val.strip().split(":")
        try:
            if len(parts) == 2:
                mins, secs = int(parts[0]), int(parts[1])
                return (mins * 60 + secs) * 1000
            elif len(parts) == 3:
                hrs, mins, secs = int(parts[0]), int(parts[1]), int(parts[2])
                return (hrs * 3600 + mins * 60 + secs) * 1000
            elif len(parts) == 1 and parts[0].isdigit():
                return int(parts[0]) * 1000
        except ValueError:
            return None
    return None

def extract_artwork_url(thumbnails: Any) -> Optional[str]:
    """Extracts best resolution thumbnail URL from thumbnail list."""
    if not thumbnails or not isinstance(thumbnails, list):
        return None
    try:
        # Pick thumbnail with largest width/height or last
        best = thumbnails[-1]
        if isinstance(best, dict):
            return best.get("url")
    except Exception:
        pass
    return None

class YTMusicProvider:
    def __init__(self):
        self.provider_name = "ytmusic"
        self.version = "1.12.3"
        self._executor = ThreadPoolExecutor(max_workers=8)
        self.capabilities = [
            "search_songs",
            "get_lyrics",
            "get_timed_lyrics",
            "get_watch_playlist_radio",
            "get_artist",
            "get_album",
            "get_playlist"
        ]
        try:
            self.client = YTMusic()
            self.is_healthy = True
            logger.info("YTMusicProvider initialized unauthenticated successfully (capabilities: %s)", len(self.capabilities))
        except Exception as e:
            self.client = None
            self.is_healthy = False
            logger.error("Failed to initialize YTMusicProvider: %s", str(e))

    def _run_with_timeout(self, func, *args, **kwargs):
        if not self.client:
            raise RuntimeError("YTMusic client is not initialized")
        future = self._executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=OPERATION_TIMEOUT_SECONDS)
        except FutureTimeoutError:
            raise TimeoutError(f"YTMusic operation timed out after {OPERATION_TIMEOUT_SECONDS}s")

    def normalize_candidate(self, item: Dict[str, Any]) -> NormalizedTrackCandidate:
        """Converts raw ytmusicapi search / track item into standard NormalizedTrackCandidate."""
        video_id = item.get("videoId") or item.get("id") or ""
        title = item.get("title") or "Unknown Title"

        # Artist formatting
        artists_data = item.get("artists")
        artist_str = "Unknown Artist"
        if isinstance(artists_data, list):
            artist_names = [a.get("name") for a in artists_data if isinstance(a, dict) and a.get("name")]
            if artist_names:
                artist_str = ", ".join(artist_names)
        elif isinstance(artists_data, str):
            artist_str = artists_data

        # Album formatting
        album_data = item.get("album")
        album_str = None
        if isinstance(album_data, dict):
            album_str = album_data.get("name")
        elif isinstance(album_data, str):
            album_str = album_data

        # Duration
        dur_sec = item.get("duration_seconds")
        dur_str = item.get("duration") or item.get("length")
        duration_ms = parse_duration_to_ms(dur_sec if dur_sec is not None else dur_str)

        # Artwork
        artwork_url = extract_artwork_url(item.get("thumbnails"))

        # Category and result type
        result_type = str(item.get("resultType") or "song").lower()

        # Shorts indicator check
        lower_title = title.lower()
        is_short = bool(
            "#shorts" in lower_title or
            "youtube shorts" in lower_title or
            item.get("videoType") == "SHORTS" or
            result_type == "short"
        )

        return NormalizedTrackCandidate(
            providerTrackId=video_id,
            provider="ytmusic",
            title=title,
            artist=artist_str,
            album=album_str,
            durationMs=duration_ms,
            artworkUrl=artwork_url,
            playable=False, # STRICTLY FALSE FOR METADATA PROVIDER
            resultType=result_type,
            isShortForm=is_short,
            metadataConfidence=0.95 if result_type == "song" else 0.8,
            providerMetadata={
                "videoId": video_id,
                "resultType": result_type,
                "category": item.get("category"),
                "year": item.get("year"),
                "isExplicit": item.get("isExplicit", False),
                "albumId": album_data.get("id") if isinstance(album_data, dict) else None
            }
        )

    def search(self, query: str, limit: int = 20) -> List[NormalizedTrackCandidate]:
        """Queries YTMusic using filter='songs' and normalizes results."""
        if not query or not query.strip():
            return []

        def _do_search():
            return self.client.search(query.strip(), filter="songs", limit=min(limit, 30))

        raw_results = self._run_with_timeout(_do_search)
        candidates = []
        for item in (raw_results or []):
            try:
                cand = self.normalize_candidate(item)
                candidates.append(cand)
            except Exception as ex:
                logger.warning("Failed to normalize search candidate: %s", str(ex))

        return candidates

    def get_lyrics(self, video_id_or_browse_id: str) -> LyricsResponse:
        """
        Retrieves lyrics using ytmusicapi get_lyrics.
        If given a videoId, first resolves lyrics browseId via get_watch_playlist.
        """
        if not video_id_or_browse_id:
            return LyricsResponse(lyrics=None, hasTimestamps=False, source="ytmusic", lines=[])

        browse_id = video_id_or_browse_id

        # If it looks like a video ID rather than a lyrics browse ID
        if not browse_id.startswith("MPLY"):
            def _get_watch():
                return self.client.get_watch_playlist(videoId=video_id_or_browse_id, limit=1)

            watch_data = self._run_with_timeout(_get_watch)
            browse_id = watch_data.get("lyrics") if isinstance(watch_data, dict) else None
            if not browse_id:
                return LyricsResponse(lyrics=None, hasTimestamps=False, source="ytmusic", lines=[])

        def _fetch_lyrics():
            # First attempt timed lyrics
            try:
                timed = self.client.get_lyrics(browse_id, timestamps=True)
                if timed:
                    return timed
            except Exception:
                pass
            # Fallback to plain lyrics
            return self.client.get_lyrics(browse_id, timestamps=False)

        raw_lyrics = self._run_with_timeout(_fetch_lyrics)
        if not raw_lyrics:
            return LyricsResponse(lyrics=None, hasTimestamps=False, source="ytmusic", lines=[])

        # Parse response
        has_timestamps = bool(raw_lyrics.get("hasTimestamps", False)) if isinstance(raw_lyrics, dict) else False
        raw_lines = raw_lyrics.get("lyrics") if isinstance(raw_lyrics, dict) else getattr(raw_lyrics, "lyrics", None)
        source = str(raw_lyrics.get("source", "ytmusic")) if isinstance(raw_lyrics, dict) else "ytmusic"

        parsed_lines: List[LyricLine] = []
        plain_text: Optional[str] = None

        if has_timestamps and isinstance(raw_lines, list):
            for line in raw_lines:
                # dataclass object with start_time, end_time, text or dict
                start_ms = getattr(line, "start_time", None) if not isinstance(line, dict) else line.get("start_time")
                text = getattr(line, "text", "") if not isinstance(line, dict) else line.get("text", "")
                if start_ms is not None and text:
                    time_sec = round(float(start_ms) / 1000.0, 3)
                    parsed_lines.append(LyricLine(time=time_sec, text=str(text).strip()))

            plain_text = "\n".join(l.text for l in parsed_lines)
        elif isinstance(raw_lines, str):
            plain_text = raw_lines.strip()
            has_timestamps = False

        return LyricsResponse(
            lyrics=plain_text,
            hasTimestamps=has_timestamps and len(parsed_lines) > 0,
            source=source,
            lines=parsed_lines if has_timestamps else []
        )

    def get_radio(self, video_id: str, limit: int = 25) -> RadioResponse:
        """Retrieves watch/radio queue candidates from get_watch_playlist."""
        def _fetch_radio():
            return self.client.get_watch_playlist(videoId=video_id, radio=True, limit=min(limit, 50))

        watch_res = self._run_with_timeout(_fetch_radio)
        if not watch_res or not isinstance(watch_res, dict):
            return RadioResponse(tracks=[], lyricsBrowseId=None)

        lyrics_browse_id = watch_res.get("lyrics")
        raw_tracks = watch_res.get("tracks") or []
        candidates = []

        for item in raw_tracks:
            try:
                cand = self.normalize_candidate(item)
                candidates.append(cand)
            except Exception as e:
                logger.warning("Radio candidate normalization warning: %s", str(e))

        return RadioResponse(
            tracks=candidates,
            lyricsBrowseId=lyrics_browse_id
        )

    def get_artist(self, browse_id: str) -> Dict[str, Any]:
        return self._run_with_timeout(self.client.get_artist, browse_id)

    def get_album(self, browse_id: str) -> Dict[str, Any]:
        return self._run_with_timeout(self.client.get_album, browse_id)

    def get_playlist(self, playlist_id: str) -> Dict[str, Any]:
        return self._run_with_timeout(self.client.get_playlist, playlist_id)
