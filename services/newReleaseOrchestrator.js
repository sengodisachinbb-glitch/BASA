/**
 * BASA V2 — New Release Orchestrator Service
 * 
 * Responsibilities:
 * - Aggregates new release candidates from verified providers (JioSaavn, YTMusic, Spotify enrichment)
 * - Uses Promise.allSettled() for complete failure isolation between providers
 * - Strict release-date & release-year verification:
 *     - Only release dates within NEW_RELEASE_WINDOW_DAYS (e.g. 120 days) get "NEW {year}"
 *     - If only year is verified and matches current calendar year, tag is "{year}" (not "NEW {year}")
 *     - Missing or unverified dates are excluded from strict new releases
 * - Strict language validation: candidate language must match requested language with confidence >= 0.60
 * - Defense-in-depth Shorts filter (isDisallowedShortFormCandidate)
 * - Version/Remix filtering: prefers original releases unless requested
 * - Canonical deduplication via TrackMatcher
 * - Playability invariant: candidate must have at least one valid BASA playback source (playableSourceAvailable = true)
 * - In-memory cache by language:windowDays:year (1 hour TTL)
 * - Exposes safe diagnostic statistics
 */

const jioSaavnProvider = require('./jioSaavnProvider');
const ytmusicProvider = require('./ytmusicProvider');
const spotifyProvider = require('./spotifyProvider');
const languagePreferenceService = require('./languagePreferenceService');
const textNormalizer = require('./textNormalizer');
const trackMatcher = require('./trackMatcher');
const { isDisallowedShortFormCandidate } = require('./shortsDetector');

const CONFIG = {
    DEFAULT_WINDOW_DAYS: 120,
    CACHE_TTL_MS: 60 * 60 * 1000, // 1 hour
    MIN_LANGUAGE_CONFIDENCE: 0.60
};

class NewReleaseOrchestrator {
    constructor() {
        this.config = CONFIG;
        this.releaseCache = new Map(); // key -> { releases, computedAt, diagnostics }
    }

    /**
     * Determines whether a candidate's release date/year satisfies strict new-release criteria.
     * Returns { valid, releaseDate, releaseYear, releaseDateConfidence, releaseTag, reason }
     */
    evaluateReleaseDate(candidate, options = {}) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const windowDays = options.windowDays || this.config.DEFAULT_WINDOW_DAYS;
        const windowMs = windowDays * 24 * 60 * 60 * 1000;

        let rawDate = candidate.releaseDate || candidate.release_date || candidate.providerMetadata?.releaseDate;
        let rawYear = candidate.year || candidate.releaseYear || candidate.providerMetadata?.year;

        // Try extracting date/year from cover artwork URL if provider embeds timestamp (e.g. JioSaavn: -2026-20260827192132-)
        const artworkUrl = candidate.artwork || candidate.cover || candidate.image || '';
        if (!rawDate && artworkUrl) {
            const dateMatch = String(artworkUrl).match(/-(\d{4})(\d{2})(\d{2})\d{6}-/);
            if (dateMatch) {
                rawDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
                if (!rawYear) rawYear = parseInt(dateMatch[1], 10);
            }
        }

        // Try parsing copyright text (e.g. "℗ 2026 Think Music")
        const copyright = candidate.copyright || candidate.providerMetadata?.copyright;
        if (!rawYear && copyright) {
            const copyMatch = String(copyright).match(/\b(20\d{2})\b/);
            if (copyMatch) rawYear = parseInt(copyMatch[1], 10);
        }

        let parsedDate = null;
        if (rawDate) {
            const d = new Date(rawDate);
            if (!isNaN(d.getTime())) {
                parsedDate = d;
            }
        }

        const parsedYear = rawYear ? parseInt(rawYear, 10) : (parsedDate ? parsedDate.getFullYear() : null);

        // Case 1: Exact release date is verified
        if (parsedDate) {
            const diffMs = now.getTime() - parsedDate.getTime();
            const ageDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

            // Allow from (now - windowDays) up to 14 days in future (upcoming/timezone)
            if (ageDays >= -14 && ageDays <= windowDays) {
                const yearStr = String(parsedDate.getFullYear());
                const formattedDate = parsedDate.toISOString().slice(0, 10);
                return {
                    valid: true,
                    releaseDate: formattedDate,
                    releaseYear: parsedDate.getFullYear(),
                    releaseDateConfidence: 0.99,
                    releaseTag: `NEW ${yearStr}`,
                    reason: `Verified release date: ${formattedDate} (${ageDays >= 0 ? `${ageDays} days ago` : 'brand new'})`
                };
            }

            // Older than window -> reject
            return {
                valid: false,
                releaseDate: parsedDate.toISOString().slice(0, 10),
                releaseYear: parsedDate.getFullYear(),
                releaseDateConfidence: 0.99,
                releaseTag: null,
                reason: `Release date ${parsedDate.toISOString().slice(0, 10)} is outside ${windowDays}-day window (${ageDays} days old)`
            };
        }

        // Case 2: Only release year is verified (no exact date)
        if (parsedYear) {
            if (parsedYear === currentYear) {
                // Hard Rule 17 & 29: If only releaseYear is known, releaseTag = "2026", NOT "NEW 2026"
                return {
                    valid: true,
                    releaseDate: `${parsedYear}-01-01`,
                    releaseYear: parsedYear,
                    releaseDateConfidence: 0.80,
                    releaseTag: `${parsedYear}`,
                    reason: `Verified release year: ${parsedYear} (exact day unknown)`
                };
            }

            // Year is from a previous year -> reject
            return {
                valid: false,
                releaseDate: null,
                releaseYear: parsedYear,
                releaseDateConfidence: 0.80,
                releaseTag: null,
                reason: `Release year ${parsedYear} does not match current year ${currentYear}`
            };
        }

        // Case 3: Missing date and year -> reject from strict new release section
        return {
            valid: false,
            releaseDate: null,
            releaseYear: null,
            releaseDateConfidence: 0.0,
            releaseTag: null,
            reason: 'Missing verified release date and year metadata'
        };
    }

    /**
     * Verifies that the candidate matches the requested language.
     */
    evaluateLanguage(candidate, targetLanguage) {
        if (!targetLanguage || targetLanguage === 'auto' || targetLanguage === 'ALL') {
            return { valid: true, language: 'Mixed', confidence: 0.8 };
        }

        const detected = languagePreferenceService.detectTrackLanguage(candidate);
        const normTarget = targetLanguage.toLowerCase().trim();
        const normDetected = detected.language.toLowerCase().trim();

        const explicitLang = (candidate.language || candidate.providerMetadata?.language || '').toLowerCase().trim();

        // 1. Explicit provider match
        if (explicitLang && explicitLang.includes(normTarget)) {
            return {
                valid: true,
                language: targetLanguage,
                confidence: 0.98,
                evidence: `Explicit provider language: ${explicitLang}`
            };
        }

        // 2. High-confidence detected match
        if (normDetected === normTarget && detected.confidence >= this.config.MIN_LANGUAGE_CONFIDENCE) {
            return {
                valid: true,
                language: detected.language,
                confidence: detected.confidence,
                evidence: detected.evidence
            };
        }

        // 3. Different detected language -> mismatch
        if (normDetected !== 'unknown' && normDetected !== normTarget && detected.confidence >= 0.70) {
            return {
                valid: false,
                language: detected.language,
                confidence: detected.confidence,
                reason: `Language mismatch: expected ${targetLanguage}, detected ${detected.language}`
            };
        }

        // 4. Low-confidence fallback
        return {
            valid: false,
            language: detected.language,
            confidence: detected.confidence,
            reason: `Insufficient language confidence (${detected.confidence}) for ${targetLanguage}`
        };
    }

    /**
     * Determines whether the candidate has a playable playback source in BASA.
     * Architectural rule: YTMusic and Spotify are metadata providers.
     * Playable candidates must have JioSaavn streamUrl, YouTube videoId, Telegram audio, or Local upload.
     */
    evaluatePlayability(candidate) {
        // JioSaavn with streamUrl
        if (candidate.source === 'jiosaavn' && candidate.streamUrl) {
            return {
                playableSourceAvailable: true,
                primarySource: 'jiosaavn',
                sourceProviders: ['jiosaavn']
            };
        }

        // YouTube or YTMusic mapped to YouTube videoId
        const videoId = candidate.videoId || candidate.sourceId || (candidate.source === 'youtube' ? candidate.id : null);
        if (videoId && !String(videoId).startsWith('http') && !String(videoId).startsWith('canon_')) {
            return {
                playableSourceAvailable: true,
                primarySource: 'youtube',
                sourceProviders: ['youtube']
            };
        }

        // Telegram FLAC
        if (candidate.source === 'telegram' && candidate.id) {
            return {
                playableSourceAvailable: true,
                primarySource: 'telegram',
                sourceProviders: ['telegram']
            };
        }

        // Local upload
        if (candidate.source === 'local' && candidate.id) {
            return {
                playableSourceAvailable: true,
                primarySource: 'local',
                sourceProviders: ['local']
            };
        }

        // Spotify alone without mapped playback source is NOT playable
        if (candidate.source === 'spotify') {
            return {
                playableSourceAvailable: false,
                primarySource: 'spotify',
                sourceProviders: []
            };
        }

        return {
            playableSourceAvailable: Boolean(candidate.playable && candidate.audioUrl),
            primarySource: candidate.source || 'unknown',
            sourceProviders: candidate.source ? [candidate.source] : []
        };
    }

    /**
     * Fetches raw candidates concurrently across providers with complete fault isolation.
     */
    async fetchCandidates(language, currentYear) {
        const queryJioSaavn = `latest ${language}`;
        const queryYTMusic = `new ${language} songs ${currentYear}`;
        const querySpotify = `${language} new releases ${currentYear}`;

        const providerStatuses = {
            jiosaavn: 'PENDING',
            ytmusic: 'PENDING',
            spotify: 'PENDING'
        };

        const results = await Promise.allSettled([
            jioSaavnProvider.search(queryJioSaavn, { limit: 25 })
                .then(res => { providerStatuses.jiosaavn = 'OK'; return res; })
                .catch(err => { providerStatuses.jiosaavn = `FAILED: ${err.message}`; return []; }),

            ytmusicProvider.search(queryYTMusic, { limit: 25 })
                .then(res => { providerStatuses.ytmusic = 'OK'; return res; })
                .catch(err => { providerStatuses.ytmusic = `FAILED: ${err.message}`; return []; }),

            spotifyProvider.search(querySpotify, { limit: 15 })
                .then(res => { providerStatuses.spotify = 'OK'; return res; })
                .catch(err => { providerStatuses.spotify = `FAILED: ${err.message}`; return []; })
        ]);

        const jioSaavnTracks = results[0].status === 'fulfilled' ? results[0].value : [];
        const ytmusicTracks = results[1].status === 'fulfilled' ? results[1].value : [];
        const spotifyTracks = results[2].status === 'fulfilled' ? results[2].value : [];

        const allCandidates = [...jioSaavnTracks, ...ytmusicTracks, ...spotifyTracks];

        return {
            allCandidates,
            providerStatuses
        };
    }

    /**
     * Main pipeline for language-aware new releases.
     */
    async getNewReleases(options = {}) {
        const targetLanguage = options.language || 'Tamil';
        const releaseWindowDays = options.releaseWindowDays || this.config.DEFAULT_WINDOW_DAYS;
        const currentYear = new Date().getFullYear();
        const limit = options.limit || 20;

        const cacheKey = `newreleases:${targetLanguage.toLowerCase()}:${releaseWindowDays}:${currentYear}`;
        if (!options.refresh && this.releaseCache.has(cacheKey)) {
            const cached = this.releaseCache.get(cacheKey);
            if (Date.now() - cached.computedAt < this.config.CACHE_TTL_MS) {
                return cached.data;
            }
        }

        // Diagnostics counters
        let candidateCount = 0;
        let verifiedDateCount = 0;
        let verifiedLanguageCount = 0;
        let shortsFilteredCount = 0;
        let duplicatesFilteredCount = 0;
        let playabilityFilteredCount = 0;

        const { allCandidates, providerStatuses } = await this.fetchCandidates(targetLanguage, currentYear);
        candidateCount = allCandidates.length;

        const filtered = [];
        const seenCanonical = new Set();
        const seenTitles = new Set();

        for (const candidate of allCandidates) {
            if (!candidate) continue;

            // 1. Shorts Hard Defense (Section 24, 38)
            if (isDisallowedShortFormCandidate(candidate)) {
                shortsFilteredCount++;
                continue;
            }

            // 2. Original / Variant check (Section 39)
            // Reject remix, cover, slowed, karaoke, 8D, etc. unless explicitly requested
            const versionType = candidate.recordingVersion || trackMatcher.detectRecordingVersion(candidate.title || '');
            if (versionType && versionType !== 'ORIGINAL' && versionType !== 'STANDARD') {
                continue;
            }

            // 3. Release Date & Year Validation (Section 17, 19, 29)
            const dateEval = this.evaluateReleaseDate(candidate, { windowDays: releaseWindowDays });
            if (!dateEval.valid) {
                continue;
            }
            verifiedDateCount++;

            // 4. Language Validation (Section 20)
            const langEval = this.evaluateLanguage(candidate, targetLanguage);
            if (!langEval.valid) {
                continue;
            }
            verifiedLanguageCount++;

            // 5. Playability Requirement (Section 25, 43)
            const playEval = this.evaluatePlayability(candidate);
            if (!playEval.playableSourceAvailable) {
                playabilityFilteredCount++;
                continue;
            }

            // 6. Deduplication & Canonicalization
            const normTitle = textNormalizer.normalize(candidate.title || '');
            const normArtist = textNormalizer.normalize(candidate.artist || '').slice(0, 10);
            const titleKey = `${normTitle}__${normArtist}`;

            if (seenTitles.has(titleKey)) {
                duplicatesFilteredCount++;
                continue;
            }
            seenTitles.add(titleKey);

            const canonicalTrackId = candidate.canonicalTrackId || `canon_${normTitle.replace(/\s+/g, '_')}_${normArtist}`;
            if (seenCanonical.has(canonicalTrackId)) {
                duplicatesFilteredCount++;
                continue;
            }
            seenCanonical.add(canonicalTrackId);

            // Construct final validated release card
            filtered.push({
                canonicalTrackId,
                id: candidate.id || canonicalTrackId,
                title: candidate.title,
                artist: candidate.artist,
                album: candidate.album || 'Single',
                duration: candidate.duration || 0,
                artwork: candidate.artwork || candidate.cover || '',
                cover: candidate.cover || candidate.artwork || '',
                releaseDate: dateEval.releaseDate,
                releaseYear: dateEval.releaseYear,
                releaseDateConfidence: dateEval.releaseDateConfidence,
                releaseTag: dateEval.releaseTag,
                language: langEval.language,
                languageConfidence: langEval.confidence,
                playableSourceAvailable: true,
                source: playEval.primarySource,
                sourceId: candidate.sourceId || candidate.id,
                sourceProviders: playEval.sourceProviders,
                streamUrl: candidate.streamUrl || candidate.audioUrl || '',
                videoId: candidate.videoId || candidate.sourceId || null
            });
        }

        // 7. Sorting (Section 18):
        // Primary: releaseDate descending (newest first)
        // Secondary: releaseDateConfidence descending
        // Tertiary: artist/title
        filtered.sort((a, b) => {
            const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
            const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
            if (dateB !== dateA) return dateB - dateA;
            if (b.releaseDateConfidence !== a.releaseDateConfidence) return b.releaseDateConfidence - a.releaseDateConfidence;
            return a.title.localeCompare(b.title);
        });

        const finalReleases = filtered.slice(0, limit);

        const responseData = {
            success: true,
            language: targetLanguage,
            languageSource: options.languageSource || 'MANUAL',
            releaseWindowDays,
            currentYear,
            releases: finalReleases,
            diagnostics: {
                candidateCount,
                verifiedDateCount,
                verifiedLanguageCount,
                shortsFilteredCount,
                duplicatesFilteredCount,
                playabilityFilteredCount,
                finalDisplayedCount: finalReleases.length,
                providerStatuses
            }
        };

        // Cache result
        this.releaseCache.set(cacheKey, {
            data: responseData,
            computedAt: Date.now()
        });

        return responseData;
    }
}

module.exports = new NewReleaseOrchestrator();
