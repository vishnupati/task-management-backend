import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { AuthUser } from '../types';

// Stateless: the signed access token is trusted for its (short) lifetime, so authenticated requests
// don't pay a MongoDB round trip. Endpoints that need the full user (e.g. /me) load it themselves.
export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization || '';
        const [scheme, token] = authHeader.split(' ');
        const cookieToken = req.cookies && req.cookies.access_token;
        const accessToken = scheme === 'Bearer' && token ? token : cookieToken;

        if (!accessToken) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const decoded = jwt.verify(accessToken, config.auth.jwtSecret);

        // Refresh tokens are signed with JWT_SECRET too when JWT_REFRESH_SECRET is unset; never accept one here.
        if (typeof decoded === 'string' || !decoded.sub || decoded.type === 'refresh') {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        req.user = {
            id: decoded.sub,
            email: decoded.email,
        };

        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
};

// For handlers behind authenticate. A route that forgot the middleware fails loudly instead of running anonymously.
export const getAuthUser = (req: Pick<Request, 'user'>): AuthUser => {
    if (!req.user) {
        throw new Error('Route is missing the authenticate middleware');
    }

    return req.user;
};
