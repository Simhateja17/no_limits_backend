import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/auth.js';
import { UserRole } from '@prisma/client';
import { prisma } from '../config/database.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

// Authenticate user middleware
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Get token from Authorization header or cookie
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : req.cookies?.accessToken;

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Verify token
    const payload = verifyAccessToken(token);

    // Check if user still exists in database
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        client: true
      }
    });

    if (!user) {
      // User no longer exists - clear cookies and return 401
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');
      res.status(401).json({ error: 'Account no longer exists. Please log in again.' });
      return;
    }

    // Check if user is active
    if (!user.isActive) {
      // User account is deactivated
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');
      res.status(401).json({ error: 'Account has been deactivated. Please contact support.' });
      return;
    }

    // For CLIENT users, verify that the associated client record exists and is active
    if (user.role === 'CLIENT') {
      if (!user.client) {
        // Client record doesn't exist
        res.clearCookie('accessToken');
        res.clearCookie('refreshToken');
        res.status(401).json({ error: 'Client account no longer exists. Please contact support.' });
        return;
      }

      if (!user.client.isActive) {
        // Client is deactivated
        res.clearCookie('accessToken');
        res.clearCookie('refreshToken');
        res.status(401).json({ error: 'Client account has been deactivated. Please contact support.' });
        return;
      }
    }

    // Enrich the payload with the current clientId from database
    // This ensures that even if the token was generated before a client was associated,
    // or if the clientId in token is stale, we use the current database state
    const enrichedPayload = {
      ...payload,
      clientId: user.client?.id || payload.clientId,
    };

    req.user = enrichedPayload;
    (req as any).userId = payload.userId;

    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// Authorize by role middleware
export const authorize = (...roles: UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
};

// Role-specific middleware helpers
export const requireSuperAdmin = authorize('SUPER_ADMIN');
export const requireAdmin = authorize('SUPER_ADMIN', 'ADMIN');
export const requireEmployee = authorize('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE');
export const requireClient = authorize('CLIENT');
export const requireAnyRole = authorize('SUPER_ADMIN', 'ADMIN', 'EMPLOYEE', 'CLIENT');
