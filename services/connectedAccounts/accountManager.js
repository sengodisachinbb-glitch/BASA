/**
 * BASA 2.0 — Connected Accounts Store & Lifecycle Manager
 * 
 * Securely persists connected Google & Spotify accounts with:
 * - AES-256-GCM token encryption
 * - Token expiration detection and automatic refresh
 * - Safe sanitization (tokens and secrets NEVER sent to browser)
 * - Disconnect & revocation
 */

const { v4: uuidv4 } = require('uuid');
const { encryptToken, decryptToken } = require('../security/tokenCipher');
const googleService = require('./googleService');
const spotifyService = require('./spotifyService');

class AccountManager {
    /**
     * Saves or updates a connected account with encrypted tokens
     */
    async saveAccount(db, userId, provider, data) {
        if (!db || !userId || !provider) {
            throw new Error('Database, userId, and provider are required');
        }

        const accessEncrypted = data.accessToken ? encryptToken(data.accessToken) : '';
        const refreshEncrypted = data.refreshToken ? encryptToken(data.refreshToken) : '';
        const expiresAt = data.expiresIn
            ? new Date(Date.now() + (Number(data.expiresIn) * 1000)).toISOString()
            : null;

        const id = uuidv4();
        const metadata = JSON.stringify(data.metadata || {});

        try {
            db.run(`
                INSERT OR REPLACE INTO connected_accounts (
                    id, user_id, provider, provider_user_id, provider_email,
                    provider_display_name, access_token_encrypted, refresh_token_encrypted,
                    token_expires_at, scope, channel_id, connected_at, last_synced_at, status, metadata_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'connected', ?)
            `, [
                id,
                userId,
                provider,
                data.providerUserId || null,
                data.providerEmail || null,
                data.providerDisplayName || null,
                accessEncrypted,
                refreshEncrypted,
                expiresAt,
                data.scope || null,
                data.channelId || null,
                metadata
            ]);
            return true;
        } catch (err) {
            console.error('[AccountManager] saveAccount error:', err.message);
            throw err;
        }
    }

    /**
     * Retrieves account and returns decrypted valid access token (refreshes automatically if expired)
     */
    async getValidToken(db, userId, provider) {
        const row = this._getRawAccount(db, userId, provider);
        if (!row || row.status !== 'connected') return null;

        const now = Date.now();
        const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
        const isExpired = expiresAt > 0 && expiresAt <= (now + 60000); // 60s buffer

        if (!isExpired && row.access_token_encrypted) {
            return decryptToken(row.access_token_encrypted);
        }

        // Token expired -> perform automatic refresh
        if (row.refresh_token_encrypted) {
            try {
                let refreshResult = null;
                if (provider === 'google') {
                    refreshResult = await googleService.refreshAccessToken(row.refresh_token_encrypted);
                } else if (provider === 'spotify') {
                    refreshResult = await spotifyService.refreshAccessToken(row.refresh_token_encrypted);
                }

                if (refreshResult && refreshResult.accessToken) {
                    const newAccessEncrypted = encryptToken(refreshResult.accessToken);
                    const newExpiresAt = new Date(Date.now() + (refreshResult.expiresIn * 1000)).toISOString();

                    db.run(`
                        UPDATE connected_accounts
                        SET access_token_encrypted = ?, token_expires_at = ?, last_synced_at = CURRENT_TIMESTAMP
                        WHERE user_id = ? AND provider = ?
                    `, [newAccessEncrypted, newExpiresAt, userId, provider]);

                    return refreshResult.accessToken;
                }
            } catch (err) {
                console.warn(`[AccountManager] Token refresh failed for ${provider}:`, err.message);
                db.run(`UPDATE connected_accounts SET status = 'expired' WHERE user_id = ? AND provider = ?`, [userId, provider]);
            }
        }

        return decryptToken(row.access_token_encrypted);
    }

    /**
     * Lists all connected accounts for user (SANITIZED: NO TOKENS EXPOSED)
     */
    listSanitizedAccounts(db, userId) {
        if (!db || !userId) return [];
        const accounts = [];
        try {
            const stmt = db.prepare(`
                SELECT provider, provider_user_id, provider_email, provider_display_name,
                       channel_id, connected_at, last_synced_at, status
                FROM connected_accounts
                WHERE user_id = ?
            `);
            stmt.bind([userId]);
            while (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const obj = {};
                cols.forEach((c, i) => obj[c] = vals[i]);
                accounts.push(obj);
            }
            stmt.free();
        } catch (err) {
            console.error('[AccountManager] listSanitizedAccounts error:', err.message);
        }
        return accounts;
    }

    /**
     * Disconnects account and revokes OAuth tokens
     */
    async disconnectAccount(db, userId, provider) {
        const row = this._getRawAccount(db, userId, provider);
        if (!row) return true;

        if (provider === 'google' && row.refresh_token_encrypted) {
            await googleService.revokeToken(row.refresh_token_encrypted);
        }

        try {
            db.run(`
                UPDATE connected_accounts
                SET status = 'disconnected', access_token_encrypted = NULL, refresh_token_encrypted = NULL
                WHERE user_id = ? AND provider = ?
            `, [userId, provider]);
            return true;
        } catch (err) {
            console.error('[AccountManager] disconnectAccount error:', err.message);
            return false;
        }
    }

    _getRawAccount(db, userId, provider) {
        try {
            const stmt = db.prepare(`SELECT * FROM connected_accounts WHERE user_id = ? AND provider = ?`);
            stmt.bind([userId, provider]);
            if (stmt.step()) {
                const cols = stmt.getColumnNames();
                const vals = stmt.get();
                const obj = {};
                cols.forEach((c, i) => obj[c] = vals[i]);
                stmt.free();
                return obj;
            }
            stmt.free();
        } catch (e) {}
        return null;
    }
}

module.exports = new AccountManager();
