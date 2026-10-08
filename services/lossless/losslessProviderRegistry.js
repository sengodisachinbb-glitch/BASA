/**
 * BASA V2 — Lossless Provider Registry
 * 
 * Central registry of all lossless source providers.
 * Enforces provider capability matrix and isolated fault tolerance.
 */

const telegramLosslessProvider = require('./providers/telegramLosslessProvider');
const localLosslessProvider = require('./providers/localLosslessProvider');
const internetArchiveLosslessProvider = require('./providers/internetArchiveLosslessProvider');
const qobuzProvider = require('./providers/qobuzProvider');
const tidalProvider = require('./providers/tidalProvider');
const amazonProvider = require('./providers/amazonProvider');

class LosslessProviderRegistry {
    constructor() {
        this.providers = new Map();

        // Register default providers
        this.register(telegramLosslessProvider);
        this.register(localLosslessProvider);
        this.register(internetArchiveLosslessProvider);
        this.register(qobuzProvider);
        this.register(tidalProvider);
        this.register(amazonProvider);
    }

    register(provider) {
        if (!provider || !provider.id) return;
        this.providers.set(provider.id, provider);
    }

    getProvider(id) {
        return this.providers.get(id) || null;
    }

    getProviders() {
        return Array.from(this.providers.values());
    }

    getEnabledProviders() {
        return this.getProviders().filter(p => p.enabled);
    }

    /**
     * Aggregated provider health report with isolated timeouts.
     */
    async getHealth(db) {
        const healthReport = {};
        const entries = Array.from(this.providers.entries());

        const healthPromises = entries.map(async ([id, provider]) => {
            try {
                if (typeof provider.getHealth === 'function') {
                    const health = await Promise.race([
                        provider.getHealth(db),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 3500))
                    ]);
                    return { id, health };
                }
                return {
                    id,
                    health: {
                        id,
                        name: provider.name,
                        status: provider.enabled ? 'UP' : 'UNAVAILABLE',
                        enabled: provider.enabled
                    }
                };
            } catch (err) {
                return {
                    id,
                    health: {
                        id,
                        name: provider.name,
                        status: 'DOWN',
                        error: err.message
                    }
                };
            }
        });

        const settled = await Promise.allSettled(healthPromises);
        settled.forEach(r => {
            if (r.status === 'fulfilled' && r.value) {
                healthReport[r.value.id] = r.value.health;
            }
        });

        return healthReport;
    }

    /**
     * Reports full provider capability matrix distinguishing capability from live availability.
     */
    getCapabilityMatrix() {
        return this.getProviders().map(p => {
            const isConfigured = Boolean(p.enabled);
            const isTelegram = p.id === 'telegram';
            const isLocal = p.id === 'local';
            const isArchive = p.id === 'internet_archive';
            const isBuiltinActive = isTelegram || isLocal || isArchive;

            return {
                id: p.id,
                name: p.name,
                adapterImplemented: true,
                metadataAvailable: Boolean(p.metadataSupported),
                discoverySupported: Boolean(p.searchSupported),
                credentialsConfigured: isBuiltinActive || isConfigured,
                liveAccessAvailable: isBuiltinActive || isConfigured,
                sourceIdentified: isBuiltinActive,
                playableVerifiedFlac: isBuiltinActive,
                playableLosslessVerified: isBuiltinActive,
                verificationEngineAvailable: true,
                userAuthenticationRequired: Boolean(p.requiresAuthentication && !isBuiltinActive),
                serviceAuthenticationMethod: isTelegram ? 'BOT' : (isLocal ? 'LOCAL_FILESYSTEM' : (isArchive ? 'OPEN_PUBLIC' : 'OAUTH2 / API_KEY')),

                // Backwards-compatible aliases for existing UI and integration consumers
                enabled: isBuiltinActive || isConfigured,
                metadata: Boolean(p.metadataSupported),
                discovery: Boolean(p.searchSupported),
                sourceResolution: isBuiltinActive ? Boolean(p.sourceResolutionSupported) : false,
                playback: isBuiltinActive ? Boolean(p.playbackSupported) : false,
                verification: true,
                authentication: isTelegram ? 'BOT' : Boolean(p.requiresAuthentication)
            };
        });
    }
}

module.exports = new LosslessProviderRegistry();
