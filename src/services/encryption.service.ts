/**
 * Encryption Service
 * Handles encryption and decryption of sensitive data using AES-256-GCM
 */

import crypto from 'crypto';

export class EncryptionService {
  private algorithm = 'aes-256-gcm';
  private key: Buffer;

  constructor() {
    // Get encryption key from environment
    const encryptionKey = process.env.ENCRYPTION_KEY;

    if (!encryptionKey) {
      throw new Error(
        'ENCRYPTION_KEY environment variable is required. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
      );
    }

    if (encryptionKey.length !== 64) {
      throw new Error(
        'ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
        'Current length: ' + encryptionKey.length
      );
    }

    this.key = Buffer.from(encryptionKey, 'hex');
  }

  /**
   * Encrypt a string value
   * @param text - The plaintext string to encrypt
   * @returns Encrypted string in format: iv:authTag:encrypted
   */
  encrypt(text: string): string {
    if (!text) {
      return text;
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      this.algorithm,
      this.key,
      iv
    ) as crypto.CipherGCM;

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt an encrypted string
   * @param encryptedText - The encrypted string in format: iv:authTag:encrypted
   * @returns The decrypted plaintext string
   */
  decrypt(encryptedText: string): string {
    if (!encryptedText) {
      return encryptedText;
    }

    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted text format. Expected format: iv:authTag:encrypted');
    }

    const [ivHex, authTagHex, encrypted] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.key,
      iv
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Check if a string is encrypted (has the format iv:authTag:encrypted)
   * @param text - The string to check
   * @returns True if the string appears to be encrypted
   */
  isEncrypted(text: string): boolean {
    if (!text) return false;
    const parts = text.split(':');
    return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
  }

  /**
   * Safely decrypt a string - handles both encrypted and unencrypted values
   * Use this when you're not sure if a value is encrypted (e.g., legacy data)
   * @param text - The text to decrypt (may or may not be encrypted)
   * @returns The decrypted text if encrypted, or the original text if not
   */
  safeDecrypt(text: string): string {
    if (!text) {
      return text;
    }

    // Check if the text looks encrypted (format: iv:authTag:encrypted)
    if (this.isEncrypted(text)) {
      try {
        return this.decrypt(text);
      } catch (error) {
        // If decryption fails, it might be a false positive
        // (e.g., a value that happens to have colons)
        console.warn('[Encryption] Failed to decrypt value that looked encrypted, returning original');
        return text;
      }
    }

    // Not encrypted - return as-is
    return text;
  }
}

// Export a singleton instance
let encryptionServiceInstance: EncryptionService | null = null;

export function getEncryptionService(): EncryptionService {
  if (!encryptionServiceInstance) {
    encryptionServiceInstance = new EncryptionService();
  }
  return encryptionServiceInstance;
}

export default EncryptionService;
