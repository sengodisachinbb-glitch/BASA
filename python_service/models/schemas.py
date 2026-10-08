from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

class LyricLine(BaseModel):
    time: float = Field(..., description="Timestamp in seconds")
    text: str = Field(..., description="Line lyric text")

class LyricsResponse(BaseModel):
    lyrics: Optional[str] = None
    hasTimestamps: bool = False
    source: str = "ytmusic"
    lines: List[LyricLine] = Field(default_factory=list)

class NormalizedTrackCandidate(BaseModel):
    providerTrackId: str = Field(..., description="Provider unique identifier (e.g. videoId or spotifyId)")
    provider: str = Field(..., description="Provider name: ytmusic | spotify")
    title: str = Field(..., description="Track title")
    artist: str = Field(..., description="Primary artist or artists string")
    album: Optional[str] = Field(None, description="Album title")
    durationMs: Optional[int] = Field(None, description="Duration in integer milliseconds")
    artworkUrl: Optional[str] = Field(None, description="Primary artwork/cover URL")
    playable: bool = Field(False, description="Strictly False for metadata candidates")
    resultType: str = Field("song", description="Result category: song, video, album, artist")
    isShortForm: bool = Field(False, description="Short-form / Shorts indicator")
    metadataConfidence: float = Field(1.0, description="Confidence score 0.0 - 1.0")
    canonicalTrackId: Optional[str] = Field(None, description="Optional canonical ID if precomputed")
    providerMetadata: Dict[str, Any] = Field(default_factory=dict, description="Raw provider metadata details")

class RadioResponse(BaseModel):
    tracks: List[NormalizedTrackCandidate] = Field(default_factory=list)
    lyricsBrowseId: Optional[str] = None

class ErrorResponse(BaseModel):
    error_code: str
    message: str
    provider: str
    details: Optional[str] = None
