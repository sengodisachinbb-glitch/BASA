/**
 * BASA 2.0 — Token Cipher & Secret Security
 * 
 * Provides AES-256-GCM authenticated encryption for OAuth access and refresh tokens.
 * Complies with BASA Security Guidelines:
 * - Tokens are NEVER stored in plaintext.
 * - Secret keys and refresh tokens are NEVER exposed to client-side code.
 * - GCM authentication tags prevent ciphertext tampering.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const SALT_STRING = 'basa_oauth_token_vault_salt_v2';

function getDerivedKey() {
    const secret = process.env.TOKEN_ENCRYPTION_SECRET || process.env.JWT_SECRET || 'basa_super_secure_vault_default_secret_key_2026';
    return crypto.scryptSync(secret, SALT_STRING, 32);
}

/**
 * Encrypts a plaintext string into formatted ciphertext: iv:authTag:encryptedHex
 * @param {string} text - Plaintext token
 * @returns {string} Encrypted bundle
 */
function encryptToken(text) {
    if (!text || typeof text !== 'string') return '';
    try {
        const key = getDerivedKey();
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    } catch (err) {
        console.error('[TokenCipher] Encryption error:', err.message);
        throw new Error('Failed to securely encrypt credential');
    }
}

/**
 * Decrypts a formatted ciphertext bundle into plaintext.
 * @param {string} bundle - iv:authTag:encryptedHex
 * @returns {string} Decrypted token
 */
function decryptToken(bundle) {
    if (!bundle || typeof bundle !== 'string') return '';
    try {
        const parts = bundle.split(':');
        if (parts.length !== 3) {
            // Not encrypted or legacy plaintext
            return bundle;
        }
        
        const [ivHex, tagHex, encryptedHex] = parts;
        const key = getDerivedKey();
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(tagHex, 'hex');
        
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('[TokenCipher] Decryption error:', err.message);
        return '';
    }
}

module.exports = {
    encryptToken,
    decryptToken
};
