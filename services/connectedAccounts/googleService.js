/**
 * BASA 2.0 — Google & YouTube Music Connected Account Service
 * 
 * Implements:
 * - Google OAuth 2.0 authorization URL and code exchange
 * - Encrypted token storage and refresh (AES-256-GCM)
 * - Official YouTube Data API v3 integration:
 *   - User YouTube channel details
 *   - Accessible playlists
 *   - Liked music / videos
 * - Token revocation
 * - Google Takeout watch-history parser (JSON & CSV)
 */

const { encryptToken, decryptToken } = require('../security/tokenCipher');

class GoogleService {
    constructor() {
        this.clientId = process.env.GOOGLE_CLIENT_ID || '';
        this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
        this.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/connected-accounts/google/callback';
        this.scopes = [
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/youtube.readonly'
        ];
    }

    /**
     * Builds Google OAuth authorization URL
     */
    getAuthUrl(state = '') {
        const base = 'https://accounts.google.com/o/oauth2/v2/auth';
        const params = new URLSearchParams({
            client_id: this.clientId || 'basa-google-client-id-placeholder',
            redirect_uri: this.redirectUri,
            response_type: 'code',
            scope: this.scopes.join(' '),
            access_type: 'offline',
            prompt: 'consent',
            state: state || 'basa_google_auth'
        });
        return `${base}?${params.toString()}`;
    }

    /**
     * Exchanges auth code for access & refresh tokens
     */
    async exchangeCodeForTokens(code) {
        if (!code) throw new Error('Authorization code is required');

        // Allow mock/test bypass if client credentials are placeholder
        if (!this.clientId || this.clientId.includes('placeholder')) {
            return {
                accessToken: 'mock_google_access_token_' + Date.now(),
                refreshToken: 'mock_google_refresh_token_' + Date.now(),
                expiresIn: 3600,
                tokenType: 'Bearer',
                scope: this.scopes.join(' ')
            };
        }

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: this.clientId,
                client_secret: this.clientSecret,
                redirect_uri: this.redirectUri,
                grant_type: 'authorization_code'
            })
        });

        if (!res.ok) {
            const errBody = await res.text();
            throw new Error(`Google token exchange failed (${res.status}): ${errBody}`);
        }

        const data = await res.json();
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            tokenType: data.token_type,
            scope: data.scope
        };
    }

    /**
     * Refreshes an expired access token using the encrypted refresh token
     */
    async refreshAccessToken(encryptedRefreshToken) {
        const refreshToken = decryptToken(encryptedRefreshToken);
        if (!refreshToken) throw new Error('Invalid refresh token');

        if (!this.clientId || this.clientId.includes('placeholder')) {
            return {
                accessToken: 'mock_refreshed_google_access_' + Date.now(),
                expiresIn: 3600
            };
        }

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                refresh_token: refreshToken,
                client_id: this.clientId,
                client_secret: this.clientSecret,
                grant_type: 'refresh_token'
            })
        });

        if (!res.ok) {
            throw new Error(`Google token refresh failed (${res.status})`);
        }

        const data = await res.json();
        return {
            accessToken: data.access_token,
            expiresIn: data.expires_in
        };
    }

    /**
     * Fetches user profile from Google UserInfo API
     */
    async getUserProfile(accessToken) {
        if (!accessToken) throw new Error('Access token is required');

        if (accessToken.startsWith('mock_')) {
            return {
                id: 'google_user_123',
                email: 'user@example.com',
                name: 'Google User',
                picture: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb'
            };
        }

        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
        return await res.json();
    }

    /**
     * Fetches user's YouTube channel details
     */
    async getYouTubeChannel(accessToken) {
        if (accessToken.startsWith('mock_')) {
            return {
                channelId: 'UC_mock_channel_123',
                title: 'My Music Channel',
                likesPlaylistId: 'LL_mock_likes'
            };
        }

        const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) throw new Error(`YouTube channel fetch failed (${res.status})`);
        const data = await res.json();

        if (!data.items || data.items.length === 0) return null;
        const item = data.items[0];
        return {
            channelId: item.id,
            title: item.snippet?.title,
            likesPlaylistId: item.contentDetails?.relatedPlaylists?.likes
        };
    }

    /**
     * Fetches user's YouTube playlists
     */
    async getPlaylists(accessToken, maxResults = 50) {
        if (accessToken.startsWith('mock_')) {
            return [
                { id: 'yt_pl_1', title: 'Favorite Melodies', trackCount: 15, coverUrl: '' },
                { id: 'yt_pl_2', title: 'Late Night Chill', trackCount: 22, coverUrl: '' }
            ];
        }

        const res = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&mine=true&maxResults=${maxResults}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) throw new Error(`YouTube playlists fetch failed (${res.status})`);
        const data = await res.json();

        return (data.items || []).map(p => ({
            id: p.id,
            title: p.snippet?.title,
            description: p.snippet?.description,
            trackCount: p.contentDetails?.itemCount || 0,
            coverUrl: p.snippet?.thumbnails?.high?.url || p.snippet?.thumbnails?.default?.url
        }));
    }

    /**
     * Fetches items from a YouTube playlist
     */
    async getPlaylistItems(accessToken, playlistId, maxResults = 50) {
        if (accessToken.startsWith('mock_')) {
            return [
                { providerTrackId: 'yt_v1', title: 'Vennilave Vennilave', artist: 'A.R. Rahman', durationMs: 310000 },
                { providerTrackId: 'yt_v2', title: 'Hukum - Thalaivar Alappara', artist: 'Anirudh Ravichander', durationMs: 205000 }
            ];
        }

        const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=${maxResults}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) throw new Error(`YouTube playlistItems fetch failed (${res.status})`);
        const data = await res.json();

        return (data.items || []).map(item => {
            const rawTitle = item.snippet?.title || '';
            // Parse "Artist - Title" heuristic
            let artist = item.snippet?.videoOwnerChannelTitle || 'YouTube Artist';
            let title = rawTitle;
            if (rawTitle.includes(' - ')) {
                const parts = rawTitle.split(' - ');
                artist = parts[0].trim();
                title = parts.slice(1).join(' - ').trim();
            }

            return {
                providerTrackId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId,
                title,
                artist,
                album: item.snippet?.title || '',
                durationMs: 0, // YouTube Data API snippet doesn't include duration without video details
                coverUrl: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url
            };
        });
    }

    /**
     * Revokes Google OAuth token
     */
    async revokeToken(encryptedToken) {
        const token = decryptToken(encryptedToken);
        if (!token) return true;

        if (token.startsWith('mock_')) return true;

        try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            return true;
        } catch (err) {
            console.error('[GoogleService] Revocation error:', err.message);
            return false;
        }
    }

    /**
     * Parses Google Takeout watch-history (JSON or CSV format)
     * Provides manual historical listening import since official YouTube API does not provide complete listening logs.
     */
    parseTakeoutHistory(rawContent, fileType = 'json') {
        const tracks = [];

        if (fileType === 'json') {
            try {
                const data = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent;
                if (Array.isArray(data)) {
                    for (const item of data) {
                        let title = item.title || '';
                        if (title.startsWith('Watched ')) title = title.replace(/^Watched\s+/, '');
                        if (!title) continue;

                        let artist = 'YouTube Music';
                        if (Array.isArray(item.subtitles) && item.subtitles.length > 0) {
                            artist = item.subtitles[0].name || artist;
                        }

                        // Extract video ID from titleUrl (e.g. https://www.youtube.com/watch?v=xxx)
                        let videoId = '';
                        if (item.titleUrl) {
                            try {
                                const url = new URL(item.titleUrl);
                                videoId = url.searchParams.get('v') || '';
                            } catch (e) {}
                        }

                        tracks.push({
                            provider: 'takeout',
                            providerTrackId: videoId || `takeout_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                            title,
                            artist,
                            playedAt: item.time || new Date().toISOString()
                        });
                    }
                }
            } catch (err) {
                console.error('[GoogleService] Takeout JSON parse error:', err.message);
            }
        } else if (fileType === 'csv') {
            try {
                const lines = String(rawContent).split(/\r?\n/).filter(Boolean);
                // Assume CSV columns: Title, Channel/Artist, URL, Time
                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
                    if (cols.length >= 2 && cols[0]) {
                        tracks.push({
                            provider: 'takeout',
                            providerTrackId: `takeout_csv_${i}`,
                            title: cols[0],
                            artist: cols[1] || 'YouTube Music',
                            playedAt: cols[3] || new Date().toISOString()
                        });
                    }
                }
            } catch (err) {
                console.error('[GoogleService] Takeout CSV parse error:', err.message);
            }
        }

        return tracks;
    }
}

module.exports = new GoogleService();
