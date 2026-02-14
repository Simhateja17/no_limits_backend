/**
 * JTL Token Manager
 *
 * Centralizes JTL OAuth token refresh to prevent race conditions.
 *
 * Problem: JTL uses refresh token rotation — each call to /token with
 * grant_type=refresh_token returns a NEW refresh token and invalidates
 * the old one. Multiple JTLService instances racing to refresh will
 * "double-spend" the refresh token, breaking the chain.
 *
 * Solution: Singleton per clientId with promise deduplication.
 * If a refresh is already in flight, subsequent callers await the same
 * promise instead of issuing their own /token call.
 */

import { PrismaClient } from '@prisma/client';
import { getEncryptionService } from '../encryption.service.js';
import { Logger } from '../../utils/logger.js';

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

interface JTLTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface RefreshCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  environment: 'sandbox' | 'production';
}

const OAUTH_URL = 'https://oauth2.api.jtl-software.com';

export class JTLTokenManager {
  private static instances = new Map<string, JTLTokenManager>();
  private refreshPromise: Promise<TokenData> | null = null;
  private cachedTokens: TokenData | null = null;
  private logger = new Logger('JTLTokenManager');

  private constructor(private readonly internalClientId: string) {}

  /**
   * Get or create a TokenManager for a given internal client ID.
   * All JTLService instances for the same client share one manager.
   */
  static getInstance(internalClientId: string): JTLTokenManager {
    let instance = JTLTokenManager.instances.get(internalClientId);
    if (!instance) {
      instance = new JTLTokenManager(internalClientId);
      JTLTokenManager.instances.set(internalClientId, instance);
    }
    return instance;
  }

  /**
   * Serialized token refresh — if a refresh is already in flight,
   * piggyback on it instead of starting a new one.
   *
   * This is the core mutex: Node.js is single-threaded, so storing
   * `this.refreshPromise` before the first `await` guarantees that
   * any concurrent caller entering this method will see the in-flight
   * promise and join it.
   */
  async refreshToken(
    credentials: RefreshCredentials,
    prisma: PrismaClient,
  ): Promise<TokenData> {
    if (this.refreshPromise) {
      this.logger.debug({
        event: 'refresh_deduplicated',
        clientId: this.internalClientId,
      });
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefresh(credentials, prisma);
    try {
      const result = await this.refreshPromise;
      return result;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Re-read the latest tokens from DB without triggering a refresh.
   * Used by 401-retry: another instance may have already refreshed.
   */
  async getLatestTokens(prisma: PrismaClient): Promise<TokenData | null> {
    const encryptionService = getEncryptionService();

    const config = await prisma.jtlConfig.findUnique({
      where: { clientId_fk: this.internalClientId },
    });

    if (!config || !config.accessToken || !config.tokenExpiresAt) {
      return null;
    }

    const tokens: TokenData = {
      accessToken: encryptionService.safeDecrypt(config.accessToken),
      refreshToken: config.refreshToken
        ? encryptionService.safeDecrypt(config.refreshToken)
        : '',
      expiresAt: config.tokenExpiresAt,
    };

    this.cachedTokens = tokens;
    return tokens;
  }

  /** Returns the last known tokens without a DB round-trip. */
  getCachedTokens(): TokenData | null {
    return this.cachedTokens;
  }

  /**
   * Actually perform the refresh — called at most once per concurrent window.
   */
  private async doRefresh(
    credentials: RefreshCredentials,
    prisma: PrismaClient,
  ): Promise<TokenData> {
    const startTime = Date.now();

    this.logger.debug({
      event: 'token_refresh_started',
      clientId: this.internalClientId,
    });

    const authString = `${credentials.clientId}:${credentials.clientSecret}`;
    const basicAuth = Buffer.from(authString).toString('base64');

    const response = await fetch(`${OAUTH_URL}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      this.logger.error({
        event: 'token_refresh_failed',
        clientId: this.internalClientId,
        status: response.status,
        error,
      });
      throw new Error(`JTL token refresh error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as JTLTokenResponse;
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    // Persist to DB so other processes / restarts pick up the new tokens
    const encryptionService = getEncryptionService();
    await prisma.jtlConfig.update({
      where: { clientId_fk: this.internalClientId },
      data: {
        accessToken: encryptionService.encrypt(data.access_token),
        refreshToken: encryptionService.encrypt(data.refresh_token),
        tokenExpiresAt: expiresAt,
      },
    });

    const tokens: TokenData = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };

    this.cachedTokens = tokens;

    this.logger.debug({
      event: 'token_refresh_completed',
      clientId: this.internalClientId,
      duration: Date.now() - startTime,
    });

    return tokens;
  }
}

export default JTLTokenManager;
