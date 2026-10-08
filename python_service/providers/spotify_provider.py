import sys
import types
import logging
from typing import Optional, List, Dict, Any
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError

from models.schemas import NormalizedTrackCandidate

import os
logger = logging.getLogger("spotify_provider")

OPERATION_TIMEOUT_SECONDS = float(os.environ.get("OPERATION_TIMEOUT_SECONDS", "3.5"))

class SpotifyPublicProvider:
    """
    Public Spotify Metadata Provider using spotapi 1.2.8.
    STRICT CONTRACT:
    - Public metadata and discovery ONLY
    - Zero private endpoint access
    - Zero audio extraction
    - Zero account / password login
    - Candidate playable field is strictly False
    - Optional: if initialization or network fails, BASA continues normally
    """
    def __init__(self):
        self.provider_name = "spotify"
        self.version = "1.2.8"
        self.capabilities = [
            "search_tracks",
            "get_track_metadata",
            "get_artist_metadata",
            "get_album_metadata",
            "get_playlist_metadata"
        ]
        self._executor = ThreadPoolExecutor(max_workers=4)
        self._public_client = None
        self.is_healthy = False
        self.init_error = None
        self._try_initialize()

    def _try_initialize(self):
        """Attempts to load Public Spotify client from spotapi 1.2.8 with graceful containment."""
        try:
            from spotapi.public import Public
            self._public_client = Public
            self.is_healthy = True
            logger.info("SpotifyPublicProvider loaded spotapi 1.2.8 Public client successfully")
        except Exception as e:
            self._public_client = None
            self.is_healthy = False
            self.init_error = str(e)
            logger.warning("SpotifyPublicProvider initialization deferred/disabled: %s (BASA will continue without Spotify)", str(e))

    def _run_with_timeout(self, func, *args, **kwargs):
        if not self.is_healthy or not self._public_client:
            raise RuntimeError(f"Spotify provider is not available: {self.init_error or 'Disabled'}")
        future = self._executor.submit(func, *args, **kwargs)
        try:
            return future.result(timeout=OPERATION_TIMEOUT_SECONDS)
        except FutureTimeoutError:
            raise TimeoutError(f"Spotify operation timed out after {OPERATION_TIMEOUT_SECONDS}s")

    def normalize_track(self, item: Dict[str, Any]) -> NormalizedTrackCandidate:
        """Normalizes Spotify track info into NormalizedTrackCandidate."""
        track_id = item.get("id") or item.get("uri", "").replace("spotify:track:", "") or ""
        title = item.get("name") or item.get("title") or "Unknown Title"

        # Artists
        artists_val = item.get("artists")
        artist_str = "Unknown Artist"
        if isinstance(artists_val, list):
            names = [a.get("name") for a in artists_val if isinstance(a, dict) and a.get("name")]
            if names:
                artist_str = ", ".join(names)
        elif isinstance(artists_val, str):
            artist_str = artists_val

        # Album
        album_val = item.get("album")
        album_str = None
        artwork_url = None
        if isinstance(album_val, dict):
            album_str = album_val.get("name")
            images = album_val.get("images") or []
            if images and isinstance(images, list) and len(images) > 0:
                artwork_url = images[0].get("url") if isinstance(images[0], dict) else None

        # Duration
        dur_ms = item.get("duration_ms")
        if dur_ms is not None:
            try:
                dur_ms = int(dur_ms)
            except (ValueError, TypeError):
                dur_ms = None

        return NormalizedTrackCandidate(
            providerTrackId=track_id,
            provider="spotify",
            title=title,
            artist=artist_str,
            album=album_str,
            durationMs=dur_ms,
            artworkUrl=artwork_url,
            playable=False, # STRICTLY FALSE: SPOTIFY IS METADATA ONLY
            resultType="song",
            isShortForm=False,
            metadataConfidence=0.95,
            providerMetadata={
                "spotifyId": track_id,
                "spotifyUri": f"spotify:track:{track_id}" if track_id else None,
                "explicit": item.get("explicit", False),
                "popularity": item.get("popularity")
            }
        )

    def search(self, query: str, limit: int = 15) -> List[NormalizedTrackCandidate]:
        if not query or not query.strip() or not self.is_healthy:
            return []

        def _do_search():
            gen = self._public_client.song_search(query.strip())
            results = []
            for _ in range(min(limit, 25)):
                try:
                    item = next(gen, None)
                    if not item:
                        break
                    results.append(item)
                except StopIteration:
                    break
            return results

        try:
            raw_items = self._run_with_timeout(_do_search)
            candidates = []
            for raw in raw_items:
                try:
                    candidates.append(self.normalize_track(raw))
                except Exception as ex:
                    logger.debug("Failed normalizing Spotify item: %s", str(ex))
            return candidates
        except Exception as err:
            logger.warning("Spotify search failed or timed out: %s", str(err))
            return []

    def get_track(self, track_id: str) -> Optional[NormalizedTrackCandidate]:
        if not track_id or not self.is_healthy:
            return None

        def _do_get():
            return self._public_client.song_info(track_id)

        try:
            raw = self._run_with_timeout(_do_get)
            if raw:
                return self.normalize_track(raw)
        except Exception as e:
            logger.warning("Spotify get_track failed: %s", str(e))
        return None

    def get_album(self, album_id: str) -> List[Dict[str, Any]]:
        if not album_id or not self.is_healthy:
            return []

        def _do_album():
            gen = self._public_client.album_info(album_id)
            return list(gen)

        try:
            return self._run_with_timeout(_do_album) or []
        except Exception as e:
            logger.warning("Spotify get_album failed: %s", str(e))
            return []

    def get_artist(self, artist_id_or_query: str) -> List[Dict[str, Any]]:
        if not artist_id_or_query or not self.is_healthy:
            return []

        def _do_artist():
            gen = self._public_client.artist_search(artist_id_or_query)
            return list(gen)

        try:
            return self._run_with_timeout(_do_artist) or []
        except Exception as e:
            logger.warning("Spotify get_artist failed: %s", str(e))
            return []

    def get_playlist(self, playlist_id: str) -> List[Dict[str, Any]]:
        if not playlist_id or not self.is_healthy:
            return []

        def _do_playlist():
            gen = self._public_client.playlist_info(playlist_id)
            return list(gen)

        try:
            return self._run_with_timeout(_do_playlist) or []
        except Exception as e:
            logger.warning("Spotify get_playlist failed: %s", str(e))
            return []
