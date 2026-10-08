/**
 * BASA V2 — Centralized YouTube Shorts Detector & Guard
 * 
 * Enforces the Absolute Shorts Invariant across all 9 layers of Defense-in-Depth.
 * 
 * Rules:
 * 1. Only inspect YouTube Shorts logic when provider is "youtube" or "ytmusic".
 * 2. URL Rule: YouTube hostname (youtube.com, www.youtube.com, m.youtube.com, music.youtube.com, youtu.be)
 *    AND pathname starts with "/shorts/" -> HARD REJECT.
 * 3. Never reject generic "/short/" unless the provider explicitly identifies content as short-form.
 * 4. Never reject a title merely because it contains the word "short" (e.g. "Short Trip Home").
 * 5. Strong signals:
 *    - #shorts hashtag in title or description
 *    - Explicit provider metadata (resultType === 'short', videoType === 'SHORTS')
 *    - Short duration (< 60s) COMBINED WITH explicit short-form category/teaser/snippet marker.
 * 6. Duration alone (< 60s) MUST NEVER reject a legitimate song.
 */

const YOUTUBE_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be'
]);

function isYouTubeHostname(hostname) {
    if (!hostname) return false;
    const cleanHost = String(hostname).toLowerCase().trim();
    if (YOUTUBE_HOSTS.has(cleanHost)) return true;
    for (const host of YOUTUBE_HOSTS) {
        if (cleanHost.endsWith('.' + host)) return true;
    }
    return false;
}

function parseUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    try {
        if (urlStr.startsWith('//')) {
            return new URL('https:' + urlStr);
        }
        if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
            // Check if relative shorts path
            if (urlStr.startsWith('/shorts/')) {
                return { hostname: 'www.youtube.com', pathname: urlStr };
            }
            return new URL('https://' + urlStr);
        }
        return new URL(urlStr);
    } catch {
        // Fallback simple parsing for edge cases
        const match = urlStr.match(/^https?:\/\/([^\/]+)(\/.*)?$/i);
        if (match) {
            return { hostname: match[1], pathname: match[2] || '/' };
        }
        if (urlStr.startsWith('/shorts/')) {
            return { hostname: 'www.youtube.com', pathname: urlStr };
        }
        return null;
    }
}

/**
 * Authoritative Shorts Check
 * Returns boolean: true if the candidate is a disallowed short-form video, false otherwise.
 */
function isDisallowedShortFormCandidate(candidate) {
    if (!candidate) return false;

    // Fast path: if explicitly pre-flagged by provider
    if (candidate.isShortForm === true || candidate.isShort === true) {
        return true;
    }

    const provider = String(
        candidate.provider || candidate.source || candidate.track_source || ''
    ).toLowerCase().trim();

    // Rule 1: Only inspect YouTube Shorts logic for youtube and ytmusic providers
    const isYtProvider = provider === 'youtube' || provider === 'ytmusic';

    // Check URLs attached to candidate (url, audioUrl, preview, webUrl)
    const urlsToCheck = [
        candidate.url,
        candidate.audioUrl,
        candidate.preview,
        candidate.webUrl,
        candidate.videoUrl,
        candidate.permalink
    ].filter(Boolean);

    for (const u of urlsToCheck) {
        const parsed = parseUrl(u);
        if (parsed) {
            const isYtHost = isYouTubeHostname(parsed.hostname) || isYtProvider;
            const path = (parsed.pathname || '').toLowerCase();
            // Rule 2: YouTube hostname AND pathname starts with /shorts/ -> HARD REJECT
            if (isYtHost && (path.startsWith('/shorts/') || path === '/shorts')) {
                return true;
            }
        } else if (typeof u === 'string') {
            const lowerU = u.toLowerCase();
            if (lowerU.includes('youtube.com/shorts/') || lowerU.includes('youtu.be/shorts/')) {
                return true;
            }
        }
    }

    // Provider-specific metadata checks
    const meta = candidate.providerMetadata || candidate.metadata || {};
    if (meta.videoType === 'SHORTS' || meta.resultType === 'short' || meta.category === 'Shorts') {
        return true;
    }

    // Title and description checks for YouTube/YTMusic candidates
    if (isYtProvider) {
        const title = String(candidate.title || '').toLowerCase();
        const description = String(candidate.description || meta.description || '').toLowerCase();

        // Strong signal: #shorts hashtag as standalone tag or in text
        if (/#shorts?\b/.test(title) || /#shorts?\b/.test(description)) {
            return true;
        }

        // Strong signal: explicit "youtube shorts" string
        if (title.includes('youtube shorts') || description.includes('youtube shorts')) {
            return true;
        }

        // Check duration combined with contextual marker
        const durationSec = candidate.durationMs != null
            ? Math.round(candidate.durationMs / 1000)
            : (Number(candidate.duration) || Number(candidate.seconds) || null);

        // Rule 6: Duration < 60s alone MUST NOT reject. Only reject if sub-60s AND has clear clip/snippet/teaser marker
        if (durationSec !== null && durationSec > 0 && durationSec < 60) {
            const hasClipMarker = /\b(snippet|teaser|short-form clip|tiktok audio)\b/i.test(title) ||
                                  /\b(snippet|teaser|short-form clip)\b/i.test(description);
            if (hasClipMarker) {
                return true;
            }
        }
    }

    return false;
}

module.exports = {
    isDisallowedShortFormCandidate,
    isYouTubeHostname,
    parseUrl
};
