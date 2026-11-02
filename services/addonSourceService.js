/**
 * BASA 2.0 — Addon Source Service
 * 
 * Implements BASA 2.0 Addon HTTP specification:
 * - GET {base}/manifest.json
 * - GET {base}/search?q=
 * - GET {base}/stream/{id}
 * 
 * Supports user-added lossless / high-quality music streams.
 */

const https = require('https');
const http = require('http');

class AddonSourceService {
    constructor() {
        this.addons = new Map(); // id -> { id, name, baseUrl, version, enabled, settings }
    }

    /**
     * Register or update an addon by its base URL
     */
    async registerAddon(baseUrl) {
        const cleanUrl = baseUrl.replace(/\/+$/, '');
        const manifest = await this._fetchJson(`${cleanUrl}/manifest.json`);

        if (!manifest || !manifest.id) {
            throw new Error('Invalid addon manifest: missing id or unreachable');
        }

        const addon = {
            id: manifest.id,
            name: manifest.name || manifest.id,
            baseUrl: cleanUrl,
            version: manifest.version || '1.0.0',
            resources: manifest.resources || [],
            settings: manifest.settings || [],
            allowDownloads: Boolean(manifest.allowDownloads),
            checkValidLossless: Boolean(manifest.checkValidLossless),
            enabled: true,
            addedAt: new Date().toISOString()
        };

        this.addons.set(addon.id, addon);
        return addon;
    }

    /**
     * List all registered addons
     */
    getAddons() {
        return Array.from(this.addons.values());
    }

    /**
     * Toggle addon enabled status
     */
    setAddonEnabled(id, enabled) {
        const addon = this.addons.get(id);
        if (addon) {
            addon.enabled = Boolean(enabled);
            return true;
        }
        return false;
    }

    /**
     * Search enabled addons for matching tracks
     */
    async searchAddons(query, options = {}) {
        const limit = options.limit || 15;
        const enabledAddons = Array.from(this.addons.values()).filter(a => a.enabled);
        if (enabledAddons.length === 0) return [];

        const searchPromises = enabledAddons.map(async (addon) => {
            try {
                const searchUrl = `${addon.baseUrl}/search?q=${encodeURIComponent(query)}`;
                const data = await this._fetchJson(searchUrl, 3000);
                const tracks = data?.tracks || [];

                return tracks.slice(0, limit).map(t => ({
                    id: `addon_${addon.id}_${t.id}`,
                    sourceId: t.id,
                    addonId: addon.id,
                    source: 'addon',
                    title: t.title,
                    artist: t.artist,
                    album: t.album || '',
                    duration: t.duration || 0,
                    cover: t.artworkURL || t.albumArtworkURL || '',
                    audioUrl: t.streamURL || `/api/addon/${addon.id}/stream/${t.id}`,
                    format: t.format || 'FLAC',
                    quality: t.audioQuality || 'LOSSLESS',
                    isLossless: true,
                    lossless: true,
                    playable: true
                }));
            } catch (e) {
                return [];
            }
        });

        const settled = await Promise.allSettled(searchPromises);
        const results = [];
        settled.forEach(s => {
            if (s.status === 'fulfilled' && Array.isArray(s.value)) {
                results.push(...s.value);
            }
        });
        return results;
    }

    /**
     * Resolve stream URL for an addon track
     */
    async resolveStream(addonId, trackId) {
        const addon = this.addons.get(addonId);
        if (!addon) throw new Error('Addon not found: ' + addonId);

        const streamUrl = `${addon.baseUrl}/stream/${encodeURIComponent(trackId)}`;
        return this._fetchJson(streamUrl, 3000);
    }

    /**
     * Helper to fetch JSON from HTTP or HTTPS
     */
    _fetchJson(urlStr, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            try {
                const parsed = new URL(urlStr);
                const client = parsed.protocol === 'https:' ? https : http;

                const req = client.request({
                    hostname: parsed.hostname,
                    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: 'GET',
                    headers: { 'User-Agent': 'BASA/2.0 AddonClient' },
                    timeout: timeoutMs
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => { body += chunk; });
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(body));
                            } catch (e) {
                                reject(new Error('Invalid JSON from addon'));
                            }
                        } else {
                            reject(new Error(`Addon HTTP ${res.statusCode}`));
                        }
                    });
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Addon request timed out'));
                });
                req.on('error', reject);
                req.end();
            } catch (e) {
                reject(e);
            }
        });
    }
}

module.exports = new AddonSourceService();

