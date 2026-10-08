/**
 * BASA V2 — Playback Upgrade Manager Service
 * 
 * Coordinates the background lossless upgrade workflow:
 * - Determines upgrade eligibility
 * - Manages bounded upgrade timeouts (default: 15,000 ms)
 * - Protects against switching after track end
 * - Provides player state machine definitions and transitions
 */

const LOSSLESS_UPGRADE_TIMEOUT_MS = 15000;

const PLAYER_STATES = {
    IDLE: 'IDLE',
    RESOLVING: 'RESOLVING',
    PLAYING_FAST_SOURCE: 'PLAYING_FAST_SOURCE',
    RESOLVING_LOSSLESS: 'RESOLVING_LOSSLESS',
    PREPARING_UPGRADE: 'PREPARING_UPGRADE',
    UPGRADING: 'UPGRADING',
    PLAYING_LOSSLESS: 'PLAYING_LOSSLESS',
    PAUSED: 'PAUSED',
    ERROR: 'ERROR'
};

class PlaybackUpgradeManager {
    constructor() {
        this.timeoutMs = LOSSLESS_UPGRADE_TIMEOUT_MS;
        this.LOSSLESS_UPGRADE_TIMEOUT_MS = LOSSLESS_UPGRADE_TIMEOUT_MS;
        this.PlayerStates = PLAYER_STATES;
        this.activeSessions = new Map();
    }

    getStates() {
        return PLAYER_STATES;
    }

    /**
     * Checks if a background lossless upgrade is warranted
     */
    shouldUpgrade(currentCandidate, targetCandidate, settings = {}) {
        if (!currentCandidate || !targetCandidate) return false;
        if (settings.autoLosslessUpgrade === false) return false;
        if (settings.playbackMode === 'YOUTUBE') return false;
        if (currentCandidate.id === targetCandidate.id) return false;

        // Target must be verified lossless or Hi-Res
        const targetIsLossless = Boolean(targetCandidate.isLossless || targetCandidate.isHiRes || targetCandidate.quality === 'HI_RES_LOSSLESS' || targetCandidate.quality === 'LOSSLESS');
        if (!targetIsLossless) return false;

        // Don't upgrade if current candidate is already Hi-Res
        if (currentCandidate.isHiRes || currentCandidate.quality === 'HI_RES_LOSSLESS') return false;

        return true;
    }

    /**
     * Initiates a bounded upgrade session with timeout protection
     */
    createUpgradeSession(currentTrackId, targetCandidate, onTimeoutCallback = null) {
        // Cancel existing session for this track if any
        this.cancelSession(currentTrackId);

        const sessionId = `upg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        
        const timeoutTimer = setTimeout(() => {
            console.warn(`[PlaybackUpgradeManager] Upgrade timeout (${this.timeoutMs}ms) fired for session: ${sessionId}`);
            this.activeSessions.delete(currentTrackId);
            if (typeof onTimeoutCallback === 'function') {
                onTimeoutCallback(sessionId, targetCandidate);
            }
        }, this.timeoutMs);

        const session = {
            sessionId,
            currentTrackId,
            targetCandidate,
            startedAt: Date.now(),
            timeoutTimer,
            status: 'PREPARING'
        };

        this.activeSessions.set(currentTrackId, session);
        return session;
    }

    /**
     * Cancels an ongoing upgrade session by track ID or session ID
     */
    cancelSession(identifier) {
        if (this.activeSessions.has(identifier)) {
            const session = this.activeSessions.get(identifier);
            if (session?.timeoutTimer) clearTimeout(session.timeoutTimer);
            this.activeSessions.delete(identifier);
            return true;
        }
        for (const [tId, session] of this.activeSessions.entries()) {
            if (session.sessionId === identifier) {
                if (session.timeoutTimer) clearTimeout(session.timeoutTimer);
                this.activeSessions.delete(tId);
                return true;
            }
        }
        return false;
    }

    cancelUpgradeSession(identifier) {
        return this.cancelSession(identifier);
    }

    /**
     * Gets current upgrade session
     */
    getSession(currentTrackId) {
        return this.activeSessions.get(currentTrackId) || null;
    }
}

module.exports = new PlaybackUpgradeManager();
