import os
import sys
import logging
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, Query, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Ensure python_service root is in sys.path
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from models.schemas import (
    NormalizedTrackCandidate,
    LyricsResponse,
    RadioResponse,
    ErrorResponse
)
from providers.ytmusic_provider import YTMusicProvider
from providers.spotify_provider import SpotifyPublicProvider

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
)
logger = logging.getLogger("basa_python_service")

app = FastAPI(
    title="BASA V2 — Multi-Provider Metadata Service",
    description="Isolated metadata discovery service providing unauthenticated YTMusic and public Spotify metadata.",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Instantiate providers
ytmusic_provider = YTMusicProvider()
spotify_provider = SpotifyPublicProvider()

@app.on_event("startup")
async def startup_event():
    logger.info("==================================================")
    logger.info("BASA V2 Python Provider Service Initialized")
    logger.info("Host: 127.0.0.1:8001")
    logger.info("Provider: %s (version: %s) - Capabilities: %s", 
                ytmusic_provider.provider_name, ytmusic_provider.version, ytmusic_provider.capabilities)
    logger.info("Provider: %s (version: %s, healthy: %s) - Capabilities: %s", 
                spotify_provider.provider_name, spotify_provider.version, spotify_provider.is_healthy, spotify_provider.capabilities)
    logger.info("==================================================")

# --------------------------------------------------
# Health Endpoints
# --------------------------------------------------

@app.get("/v1/health")
async def health():
    return {
        "status": "OK",
        "service": "basa-python-providers",
        "version": "2.0.0"
    }

@app.get("/v1/providers/health")
async def providers_health():
    return {
        "status": "OK",
        "providers": {
            "ytmusic": {
                "status": "ONLINE" if ytmusic_provider.is_healthy else "OFFLINE",
                "version": ytmusic_provider.version,
                "role": "metadata_only",
                "playable": False,
                "capabilities": ytmusic_provider.capabilities
            },
            "spotify": {
                "status": "ONLINE" if spotify_provider.is_healthy else "DISABLED",
                "version": spotify_provider.version,
                "role": "metadata_only",
                "playable": False,
                "capabilities": spotify_provider.capabilities,
                "notice": spotify_provider.init_error
            }
        }
    }

# --------------------------------------------------
# YTMusic Endpoints (/v1/providers/ytmusic/*)
# --------------------------------------------------

@app.get("/v1/providers/ytmusic/search", response_model=Dict[str, Any])
async def ytmusic_search(
    q: str = Query(..., description="Search query"),
    limit: int = Query(20, ge=1, le=50, description="Results limit")
):
    try:
        results = ytmusic_provider.search(q, limit=limit)
        return {"success": True, "provider": "ytmusic", "data": [r.dict() for r in results]}
    except TimeoutError as te:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={"success": False, "error_code": "PROVIDER_TIMEOUT", "message": str(te), "provider": "ytmusic"}
        )
    except Exception as e:
        logger.error("YTMusic search error: %s", str(e))
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "ytmusic"}
        )

@app.get("/v1/providers/ytmusic/lyrics", response_model=Dict[str, Any])
async def ytmusic_lyrics(
    videoId: Optional[str] = Query(None, description="YouTube Video ID"),
    browseId: Optional[str] = Query(None, description="YTMusic Lyrics Browse ID")
):
    target_id = browseId or videoId
    if not target_id:
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"success": False, "error_code": "PROVIDER_BAD_RESPONSE", "message": "videoId or browseId required", "provider": "ytmusic"}
        )
    try:
        lyrics = ytmusic_provider.get_lyrics(target_id)
        return {"success": True, "provider": "ytmusic", "data": lyrics.dict()}
    except TimeoutError as te:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={"success": False, "error_code": "PROVIDER_TIMEOUT", "message": str(te), "provider": "ytmusic"}
        )
    except Exception as e:
        logger.error("YTMusic lyrics error: %s", str(e))
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "ytmusic"}
        )

@app.get("/v1/providers/ytmusic/radio", response_model=Dict[str, Any])
async def ytmusic_radio(
    videoId: str = Query(..., description="YouTube Video ID seed for radio candidates"),
    limit: int = Query(25, ge=1, le=50)
):
    try:
        radio = ytmusic_provider.get_radio(videoId, limit=limit)
        return {"success": True, "provider": "ytmusic", "data": radio.dict()}
    except TimeoutError as te:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={"success": False, "error_code": "PROVIDER_TIMEOUT", "message": str(te), "provider": "ytmusic"}
        )
    except Exception as e:
        logger.error("YTMusic radio error: %s", str(e))
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "ytmusic"}
        )

@app.get("/v1/providers/ytmusic/artist/{browse_id}")
async def ytmusic_artist(browse_id: str):
    try:
        data = ytmusic_provider.get_artist(browse_id)
        return {"success": True, "provider": "ytmusic", "data": data}
    except Exception as e:
        return JSONResponse(status_code=502, content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "ytmusic"})

@app.get("/v1/providers/ytmusic/album/{browse_id}")
async def ytmusic_album(browse_id: str):
    try:
        data = ytmusic_provider.get_album(browse_id)
        return {"success": True, "provider": "ytmusic", "data": data}
    except Exception as e:
        return JSONResponse(status_code=502, content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "ytmusic"})

@app.get("/v1/providers/ytmusic/playlist/{playlist_id}")
async def ytmusic_playlist(playlist_id: str):
    try:
        data = ytmusic_provider.get_playlist(playlist_id)
        return {"success": True, "provider": "ytmusic", "data": data}
    except Exception as e:
        return JSONResponse(status_code=502, content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "ytmusic"})

# --------------------------------------------------
# Spotify Public Endpoints (/v1/providers/spotify/*)
# --------------------------------------------------

@app.get("/v1/providers/spotify/search", response_model=Dict[str, Any])
async def spotify_search(
    q: str = Query(..., description="Search query"),
    limit: int = Query(15, ge=1, le=30)
):
    try:
        results = spotify_provider.search(q, limit=limit)
        return {"success": True, "provider": "spotify", "data": [r.dict() for r in results]}
    except TimeoutError as te:
        return JSONResponse(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            content={"success": False, "error_code": "PROVIDER_TIMEOUT", "message": str(te), "provider": "spotify"}
        )
    except Exception as e:
        logger.warning("Spotify search failed: %s", str(e))
        return JSONResponse(
            status_code=status.HTTP_502_BAD_GATEWAY,
            content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "spotify"}
        )

@app.get("/v1/providers/spotify/artist/{artist_id}")
async def spotify_artist(artist_id: str):
    try:
        data = spotify_provider.get_artist(artist_id)
        return {"success": True, "provider": "spotify", "data": data}
    except Exception as e:
        return JSONResponse(status_code=502, content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "spotify"})

@app.get("/v1/providers/spotify/album/{album_id}")
async def spotify_album(album_id: str):
    try:
        data = spotify_provider.get_album(album_id)
        return {"success": True, "provider": "spotify", "data": data}
    except Exception as e:
        return JSONResponse(status_code=502, content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "spotify"})

@app.get("/v1/providers/spotify/playlist/{playlist_id}")
async def spotify_playlist(playlist_id: str):
    try:
        data = spotify_provider.get_playlist(playlist_id)
        return {"success": True, "provider": "spotify", "data": data}
    except Exception as e:
        return JSONResponse(status_code=502, content={"success": False, "error_code": "PROVIDER_UNAVAILABLE", "message": str(e), "provider": "spotify"})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8001, log_level="info", reload=False)
