/**
 * BASA / Liquid Music — Gemini DJ Prompt Template
 * 
 * Provides structured system instructions and context builders for Gemini.
 * Sanitizes untrusted user/song metadata and enforces candidate ID constraints.
 */

function sanitizeString(str) {
    if (!str) return '';
    return String(str)
        .replace(/[<>{}]/g, '') // Strip XML-like delimiter characters
        .trim();
}

/**
 * Builds the system instruction for the Gemini DJ Recommender
 */
function getSystemInstruction() {
    return `You are an expert AI Radio DJ and music curation specialist for Liquid Music / BASA streaming platform.
Your job is to select and sequence the best upcoming songs from a strictly provided list of candidate songs.

CRITICAL RULES:
1. STRICT CANDIDATE ID COMPLIANCE (ZERO HALLUCINATIONS):
   - You MUST ONLY select song IDs that are explicitly listed in the <candidate_pool> JSON.
   - NEVER invent, hallucinate, or alter any song ID. Any ID not in <candidate_pool> is rejected.

2. SEAMLESS DJ SEQUENCING & ENERGY FLOW:
   - Sequence songs with natural, musical transitions.
   - Energy and tempo (BPM) must flow smoothly from the seed song(s) without jarring leaps, like a professional live DJ set.
   - Group harmonious moods and vibes together.

3. ARTIST DIVERSITY GUARDRAIL:
   - NEVER place more than 2 consecutive songs by the same artist.

4. 70/30 DIVERSITY BALANCE:
   - Approximately 70% of selections should be musically close to the seed (same genre, language, mood, vibe).
   - Approximately 30% should be fresh discovery tracks that share cultural, era, or thematic resonance.

5. LANGUAGE & TASTE HARMONY:
   - Prioritize the language of the seed song unless the user's taste profile shows active multi-language listening.
   - Respect user taste: favor liked/completed artists, avoid skipped artists.

6. CONCISE DJ REASON:
   - For every selected song, write a sharp, 1-sentence reason explaining why it was chosen and how it connects to the sequence.`;
}

/**
 * Builds the user prompt containing seed, user taste profile, and candidate pool.
 */
function buildUserPrompt({ seed, seeds = [], tasteProfile = {}, mode = 'song', limit = 15, candidates = [], excludeIds = [] }) {
    // 1. Format Seed Information
    const currentSeed = seed || (seeds.length > 0 ? seeds[seeds.length - 1] : null);
    const recentDriftSeeds = (seeds.length > 1 ? seeds.slice(0, -1) : []).map(s => ({
        id: s.id,
        title: sanitizeString(s.title),
        artist: sanitizeString(s.artist),
        language: sanitizeString(s.language),
        mood: sanitizeString(s.mood),
        energy: s.energy,
        tempo_bpm: s.tempo_bpm
    }));

    const seedPayload = currentSeed ? {
        id: currentSeed.id,
        title: sanitizeString(currentSeed.title),
        artist: sanitizeString(currentSeed.artist),
        language: sanitizeString(currentSeed.language),
        genre: sanitizeString(currentSeed.genre),
        mood: sanitizeString(currentSeed.mood),
        vibe_tags: currentSeed.vibe_tags || [],
        energy: currentSeed.energy,
        tempo_bpm: currentSeed.tempo_bpm,
        release_year: currentSeed.release_year,
        music_director: sanitizeString(currentSeed.music_director),
        hero_actor: sanitizeString(currentSeed.hero_actor)
    } : { mode };

    // 2. Format Taste Profile
    const tasteSummary = {
        topLanguages: Array.from(tasteProfile.topLanguages || []).slice(0, 4),
        likedArtists: Array.from(tasteProfile.likedArtists || []).slice(0, 8),
        recentlySkippedArtists: Array.from(tasteProfile.skippedArtists || []).slice(0, 8),
        completedTracksCount: (tasteProfile.completedSongIds || []).length
    };

    // 3. Compact Candidate Pool (IDs and essential acoustic/metadata features only)
    const compactCandidates = candidates.map(c => ({
        id: c.id,
        title: sanitizeString(c.title),
        artist: sanitizeString(c.artist),
        language: sanitizeString(c.language),
        genre: sanitizeString(c.genre),
        mood: sanitizeString(c.mood),
        energy: typeof c.energy === 'number' ? Math.round(c.energy * 100) / 100 : 0.5,
        tempo_bpm: c.tempo_bpm || 120,
        year: c.release_year || 2024
    }));

    return `Please construct the next ${limit} songs for an upcoming radio autoplay queue.

<radio_mode>${sanitizeString(mode)}</radio_mode>

<seed_track>
${JSON.stringify(seedPayload, null, 2)}
</seed_track>

<previous_plays_drift>
${JSON.stringify(recentDriftSeeds, null, 2)}
</previous_plays_drift>

<user_taste_profile>
${JSON.stringify(tasteSummary, null, 2)}
</user_taste_profile>

<exclude_ids>
${JSON.stringify(excludeIds.slice(0, 50))}
</exclude_ids>

<candidate_pool>
${JSON.stringify(compactCandidates)}
</candidate_pool>

Return exactly ${limit} songs chosen strictly from <candidate_pool>, in optimal listening order, with a 1-sentence DJ reason for each track.`;
}

/**
 * JSON Schema for structured output
 */
const recommendationResponseSchema = {
    type: "OBJECT",
    properties: {
        recommendations: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    id: {
                        type: "STRING",
                        description: "The exact song ID selected strictly from the candidate pool."
                    },
                    reason: {
                        type: "STRING",
                        description: "A concise 1-sentence musical DJ transition reason."
                    }
                },
                required: ["id", "reason"]
            }
        }
    },
    required: ["recommendations"]
};

module.exports = {
    getSystemInstruction,
    buildUserPrompt,
    recommendationResponseSchema,
    sanitizeString
};

