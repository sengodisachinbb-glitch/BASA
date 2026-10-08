/**
 * BASA V2 — Track Matcher Service
 * 
 * Determines whether results from different providers represent the same canonical song and recording.
 * Features:
 * - Uses dedicated textNormalizer for Unicode NFC, noise stripping, and transliteration
 * - Multi-signal identity priority:
 *     1. ISRC / exact recording identifier
 *     2. Recording version compatibility (NEVER merges Live, Remix, Acoustic with Original)
 *     3. Normalized title + artist similarity
 *     4. Relative percentage duration tolerance (+/- 5% or 8s)
 *     5. Filename parsing
 *     6. Phonetic token similarity
 * - Anti-false-positive rule: Rejects single generic word merges
 * - Canonical track clustering & candidate grouping preserving available sources
 */

const textNormalizer = require('./textNormalizer');
const versionClassifier = require('./versionClassifier');

class TrackMatcher {
    constructor() {
        this.normalizer = textNormalizer;
    }

    normalize(text) {
        return this.normalizer.normalize(text);
    }

    stripNoise(text) {
        return this.normalizer.stripNoise(text);
    }

    getSearchVariations(query) {
        return this.normalizer.getSearchVariations(query);
    }

    computeTokenSimilarity(strA, strB) {
        return this.normalizer.computeTokenSimilarity(strA, strB);
    }

    isPhoneticallyClose(a, b) {
        return this.normalizer.isPhoneticallyClose(a, b);
    }

    detectRecordingVersion(text) {
        return this.normalizer.detectRecordingVersion(text);
    }

    /**
     * Extracts title and artist from structured filename (e.g. "Artist - Title [24bit 96kHz].flac")
     */
    parseFilename(filename) {
        if (!filename) return { title: '', artist: '' };
        let clean = filename.replace(/\.[a-zA-Z0-9]{2,5}$/, ''); // remove extension
        clean = this.stripNoise(clean);

        const parts = clean.split(/\s+-\s+/);
        if (parts.length >= 2) {
            return {
                artist: this.normalize(parts[0]),
                title: this.normalize(parts.slice(1).join(' - '))
            };
        }

        return {
            title: this.normalize(clean),
            artist: ''
        };
    }

    /**
     * Relative duration compatibility check (Section 10):
     * Uses absolute difference + relative percentage tolerance (+/- 5% or 8 seconds).
     */
    isDurationCompatible(durA, durB, toleranceSec = null) {
        if (!durA || !durB || durA <= 0 || durB <= 0) return true; // unknown duration does not reject
        const absDiff = Math.abs(durA - durB);
        const allowedTolerance = toleranceSec !== null
            ? toleranceSec
            : Math.max(8, Math.min(durA, durB) * 0.05);
        return absDiff <= allowedTolerance;
    }

    /**
     * Determines whether two tracks represent the same canonical song and recording.
     * Returns: { isMatch: boolean, score: number, reason: string }
     */
    matchTracks(trackA, trackB) {
        if (!trackA || !trackB) return { isMatch: false, score: 0, reason: 'invalid_inputs' };

        // 1. Version preservation (Section 7, 9): Do NOT merge different recordings
        const compatible = versionClassifier.areVersionsCompatible(trackA, trackB);
        if (!compatible) {
            const versionA = versionClassifier.classifyVersion(trackA);
            const versionB = versionClassifier.classifyVersion(trackB);
            return { isMatch: false, score: 0, reason: `version_mismatch_${versionA}_vs_${versionB}` };
        }

        // 2. ISRC / exact recording identifier match
        if (trackA.isrc && trackB.isrc && trackA.isrc.trim().toUpperCase() === trackB.isrc.trim().toUpperCase()) {
            return { isMatch: true, score: 1.0, reason: 'isrc_exact_match' };
        }

        // 3. Normalize titles and artists
        const titleA = this.normalize(trackA.title);
        const titleB = this.normalize(trackB.title);
        const artistA = this.normalize(trackA.artist || trackA.user?.name);
        const artistB = this.normalize(trackB.artist || trackB.user?.name);

        // Discard if either title is completely empty
        if (!titleA || !titleB) {
            return { isMatch: false, score: 0, reason: 'missing_title' };
        }

        // Parse filenames if titles are generic
        const fileInfoA = this.parseFilename(trackA.fileName || trackA.file_name);
        const fileInfoB = this.parseFilename(trackB.fileName || trackB.file_name);

        const effectiveTitleA = titleA || fileInfoA.title;
        const effectiveTitleB = titleB || fileInfoB.title;
        const effectiveArtistA = artistA || fileInfoA.artist;
        const effectiveArtistB = artistB || fileInfoB.artist;

        // Check relative duration compatibility
        const durA = Number(trackA.duration) || 0;
        const durB = Number(trackB.duration) || 0;
        const durationOk = this.isDurationCompatible(durA, durB);

        // Check transliteration / phonetic matching
        const titleSim = Math.max(
            this.computeTokenSimilarity(effectiveTitleA, effectiveTitleB),
            ...this.getSearchVariations(effectiveTitleA).map(v => this.computeTokenSimilarity(v, effectiveTitleB))
        );

        const artistSim = (effectiveArtistA && effectiveArtistB)
            ? Math.max(
                this.computeTokenSimilarity(effectiveArtistA, effectiveArtistB),
                ...this.getSearchVariations(effectiveArtistA).map(v => this.computeTokenSimilarity(v, effectiveArtistB))
            )
            : 0.5; // neutral if one artist is unknown

        // Anti-false-positive rule: Rejects single generic word matches
        const tokensA = effectiveTitleA.split(' ').filter(t => t.length > 0);
        const tokensB = effectiveTitleB.split(' ').filter(t => t.length > 0);
        const hasSpecificA = tokensA.some(t => t.length > 2 && !['song', 'track', 'audio', 'video', 'music'].includes(t));
        const hasSpecificB = tokensB.some(t => t.length > 2 && !['song', 'track', 'audio', 'video', 'music'].includes(t));

        if (!hasSpecificA || !hasSpecificB) {
            return { isMatch: false, score: 0.2, reason: 'generic_word_only' };
        }

        // Weighted similarity score
        const score = (titleSim * 0.65) + (artistSim * 0.35);

        // High confidence match: strong title similarity and duration compatibility
        if (titleSim >= 0.85 && durationOk) {
            return { isMatch: true, score: Math.max(score, 0.85), reason: 'high_title_duration_match' };
        }

        // Moderate confidence match: combined title + artist score and duration compatibility
        if (score >= 0.70 && durationOk) {
            return { isMatch: true, score, reason: 'title_artist_duration_match' };
        }

        return { isMatch: false, score, reason: 'insufficient_similarity' };
    }

    /**
     * Determines whether two tracks belong to the SAME SONG FAMILY (Section 3, 5).
     * Returns true if they are the same canonical track, alternate versions (remix, slowed, live, acoustic, cover, etc.),
     * or duplicates across providers.
     */
    isSameSongFamily(trackA, trackB) {
        if (!trackA || !trackB) return false;

        // Check 1: Same canonicalTrackId or canonicalId
        const idA = trackA.canonicalTrackId || trackA.canonicalId;
        const idB = trackB.canonicalTrackId || trackB.canonicalId;
        if (idA && idB && idA === idB) {
            return true;
        }

        // Check 2: Stripped canonicalTrackId match (e.g. canon_beggin_ORIGINAL_maneskin vs canon_beggin_remix_REMIX_maneskin)
        const famA = this.normalizer.extractCanonicalFamilyId(trackA);
        const famB = this.normalizer.extractCanonicalFamilyId(trackB);
        if (famA && famB && famA === famB) {
            return true;
        }

        // Check 3: Same ISRC
        if (trackA.isrc && trackB.isrc && typeof trackA.isrc === 'string' && typeof trackB.isrc === 'string') {
            if (trackA.isrc.trim().toUpperCase() === trackB.isrc.trim().toUpperCase() && trackA.isrc.trim().length > 3) {
                return true;
            }
        }

        // Check 4: Base title extraction and version evaluation
        const infoA = this.normalizer.extractBaseSongTitle(trackA.title || '', trackA.artist || '');
        const infoB = this.normalizer.extractBaseSongTitle(trackB.title || '', trackB.artist || '');

        const baseTitleA = infoA.baseTitle;
        const baseTitleB = infoB.baseTitle;

        if (!baseTitleA || !baseTitleB || baseTitleA.length < 2 || baseTitleB.length < 2) {
            return false;
        }

        // Base title similarity
        const baseTitleMatch = (baseTitleA === baseTitleB) || (
            this.computeTokenSimilarity(baseTitleA, baseTitleB) >= 0.85
        );

        if (!baseTitleMatch) {
            return false;
        }

        const normArtistA = this.normalize(trackA.artist || trackA.user?.name || '');
        const normArtistB = this.normalize(trackB.artist || trackB.user?.name || '');

        const durA = Number(trackA.duration) || 0;
        const durB = Number(trackB.duration) || 0;

        // Signal 1: Cover version of the same song (TEST 6: Beggin' vs Beggin' Cover -> REJECTED)
        if (infoA.versionType === 'COVER' || infoB.versionType === 'COVER' || (trackA.title && /\bcover\b/i.test(trackA.title)) || (trackB.title && /\bcover\b/i.test(trackB.title))) {
            return true;
        }

        // Signal 2: Version modifiers of the same root recording
        const hasVersionA = infoA.versionType !== 'ORIGINAL';
        const hasVersionB = infoB.versionType !== 'ORIGINAL';
        if (hasVersionA || hasVersionB) {
            if (!normArtistA || !normArtistB || normArtistA === normArtistB || normArtistA.includes(normArtistB) || normArtistB.includes(normArtistA)) {
                return true;
            }
            if (this.isDurationCompatible(durA, durB, 45)) {
                return true;
            }
        }

        // Signal 3: Both are original recordings with matching title
        const artistMatch = (!normArtistA || !normArtistB || normArtistA === normArtistB || normArtistA.includes(normArtistB) || normArtistB.includes(normArtistA));
        if (artistMatch) {
            // TEST 16: Same title + same artist but genuinely different recording (e.g. 35s intro vs 260s full track)
            if (durA > 0 && durB > 0 && Math.abs(durA - durB) > 45) {
                return false;
            }
            return true;
        }

        return false;
    }

    /**
     * Groups raw candidate tracks from providers into unified Canonical Tracks with version preservation.
     * Each canonical track contains:
     * - `.candidates` array holding normalized provider candidates
     * - `.availableSources` array summarizing distinct sources (YouTube, Telegram, Archive, Local)
     * - `.recordingVersion` indicating version (Original, Live, Remix, etc.)
     * - `.isOfficial` and `.isOriginal` classification flags
     */
    groupCandidates(rawCandidates = []) {
        if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) return [];

        const clusters = []; // Array of { canonical, candidates: [] }

        for (const rawCandidate of rawCandidates) {
            const normalizedCand = versionClassifier.normalizeCandidate(rawCandidate);
            let matchedCluster = null;

            for (const cluster of clusters) {
                // Compare candidate against the cluster's canonical track
                const matchResult = this.matchTracks(normalizedCand, cluster.canonical);
                if (matchResult.isMatch) {
                    matchedCluster = cluster;
                    break;
                }
            }

            if (matchedCluster) {
                matchedCluster.candidates.push(normalizedCand);
                // Enrich canonical metadata with higher fidelity candidate details if missing
                if (!matchedCluster.canonical.album && normalizedCand.album) {
                    matchedCluster.canonical.album = normalizedCand.album;
                }
                if (!matchedCluster.canonical.cover && normalizedCand.cover) {
                    matchedCluster.canonical.cover = normalizedCand.cover;
                }
                if ((!matchedCluster.canonical.duration || matchedCluster.canonical.duration === 0) && normalizedCand.duration > 0) {
                    matchedCluster.canonical.duration = normalizedCand.duration;
                }
                // Upgrade canonical official status if any candidate is official
                if (normalizedCand.isOfficial) {
                    matchedCluster.canonical.isOfficial = true;
                    matchedCluster.canonical.officialConfidence = Math.max(
                        matchedCluster.canonical.officialConfidence || 0,
                        normalizedCand.officialConfidence || 0
                    );
                }
            } else {
                // Form a new canonical cluster
                const version = normalizedCand.isOriginal ? 'ORIGINAL' : (normalizedCand.versionType || this.detectRecordingVersion(normalizedCand.title));
                const canonicalId = `canon_${this.normalize(normalizedCand.title).replace(/\s+/g, '_')}_${version}_${this.normalize(normalizedCand.artist || '').substring(0, 8)}`;
                normalizedCand.canonicalTrackId = canonicalId;
                
                const canonicalTrack = {
                    id: normalizedCand.candidateId,
                    canonicalId,
                    canonicalTrackId: canonicalId,
                    canonicalTitle: normalizedCand.title,
                    canonicalArtist: normalizedCand.artist || 'Unknown Artist',
                    recordingVersion: version,
                    versionType: normalizedCand.versionType || version,
                    isOfficial: normalizedCand.isOfficial,
                    isOriginal: normalizedCand.isOriginal,
                    officialConfidence: normalizedCand.officialConfidence,
                    isShort: normalizedCand.isShort,
                    source: normalizedCand.source,
                    sourceId: normalizedCand.sourceId || normalizedCand.candidateId,
                    title: normalizedCand.title,
                    artist: normalizedCand.artist || 'Unknown Artist',
                    album: normalizedCand.album || '',
                    albumArtist: normalizedCand.albumArtist || normalizedCand.artist || '',
                    duration: normalizedCand.duration || 0,
                    cover: normalizedCand.cover || '',
                    audioUrl: normalizedCand.audioUrl || normalizedCand.preview || '',
                    preview: normalizedCand.preview || normalizedCand.audioUrl || '',
                    format: normalizedCand.format || 'STANDARD',
                    codec: normalizedCand.codec || normalizedCand.format || 'STANDARD',
                    quality: normalizedCand.quality || 'STANDARD',
                    sampleRate: normalizedCand.sampleRate || null,
                    bitDepth: normalizedCand.bitDepth || null,
                    bitrate: normalizedCand.bitrate || null,
                    channels: normalizedCand.channels || 2,
                    isLossless: Boolean(normalizedCand.isLossless),
                    isHiRes: Boolean(normalizedCand.isHiRes),
                    isCached: Boolean(normalizedCand.isCached),
                    views: normalizedCand.views || 0,
                    likes: normalizedCand.likes || 0,
                    channelName: normalizedCand.channelName || '',
                    providerMetadata: normalizedCand.rawMetadata || {},
                    candidates: [normalizedCand]
                };

                clusters.push({
                    canonical: canonicalTrack,
                    candidates: canonicalTrack.candidates
                });
            }
        }

        // Summarize availableSources on each canonical track
        return clusters.map(c => {
            const canonical = c.canonical;
            canonical.candidates = c.candidates;
            canonical.availableSources = Array.from(new Set(canonical.candidates.map(cand => cand.source))).map(src => {
                const bestForSource = canonical.candidates.find(cand => cand.source === src);
                return {
                    source: src,
                    title: bestForSource?.title || canonical.title,
                    quality: bestForSource?.quality || 'STANDARD',
                    isHiRes: Boolean(bestForSource?.isHiRes || bestForSource?.quality === 'HI_RES_LOSSLESS'),
                    isLossless: Boolean(bestForSource?.isLossless || bestForSource?.quality === 'LOSSLESS'),
                    isCached: Boolean(bestForSource?.isCached)
                };
            });
            return canonical;
        });
    }
}

module.exports = new TrackMatcher();
