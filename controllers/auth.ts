import crypto from 'crypto';
import type { Request, Response } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import type { HydratedDocument, Types } from 'mongoose';
import User, { type IUser } from '../models/user/user';
import RefreshToken, { type IRefreshToken } from '../models/auth/refresh-token';
import { publish, TOPICS } from '../config/kafka';
import { cacheKeys, readThrough, invalidate } from '../config/cache';
import { getAuthUser } from '../middlewares/auth';
import { getErrorMessage, isDuplicateKeyError } from '../utils/errors';

const maxDeviceLogins = Number(process.env.MAX_DEVICE_LOGINS || 3);
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 60 * 30);
const accessTokenTtlSeconds = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || sessionTtlSeconds);
const refreshTokenTtlSeconds = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || sessionTtlSeconds);
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;
const maxDeviceMessage = 'reached maxiamum login quata , if you want to login this device logout other devices';

const isProduction = process.env.NODE_ENV === 'production';

const authCookieOptions = {
    httpOnly: true,
    secure: isProduction,
    // Browsers drop SameSite=None cookies that aren't Secure, which silently broke cookie auth outside production.
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
} as const;

// What tokens and auth responses are built from; satisfied by both user documents and lean query results.
type TokenUser = Pick<IUser, 'name' | 'email' | 'authProvider'> & { _id: Types.ObjectId };

interface TokenPair {
    accessToken: string;
    refreshToken: string;
    refreshJti: string;
}

export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    token: string;
    user: {
        id: Types.ObjectId;
        name: string;
        email: string;
        authProvider: string;
    };
}

export type SsoResponseBody = AuthResponse | { message: string };

// The part of Response that sso() uses. routes/auth.ts passes a stand-in to capture the result of a GitHub login.
interface SsoResponder<T> {
    status(code: number): { json(body: SsoResponseBody): T };
    cookie: Response['cookie'];
}

interface SsoPayload {
    provider: string;
    idToken?: string;
    accessToken?: string;
}

interface OAuthIdentity {
    email: string;
    name: string;
    providerId: string;
}

// Auth events are analytics-only, so publish in the background: login/refresh latency no longer includes
// a Kafka round trip. Trade-off: an event can be lost if Kafka is down or the process dies mid-send.
const publishAuthEvent = (event: string, message: { userId: Types.ObjectId | string; [field: string]: unknown }) => {
    publish({
        topic: TOPICS.AUTH_EVENTS,
        event,
        key: String(message.userId),
        message: { ...message, timestamp: new Date() },
    }).catch((error: unknown) => console.error(`Kafka publish error (${event}):`, getErrorMessage(error)));
};

const signAccessToken = (user: TokenUser) =>
    jwt.sign(
        { sub: user._id.toString(), email: user.email },
        process.env.JWT_SECRET || 'change-me-in-env',
        // jsonwebtoken parses the duration (ms format) and throws on sign if JWT_EXPIRES_IN is malformed.
        { expiresIn: (process.env.JWT_EXPIRES_IN || `${accessTokenTtlSeconds}s`) as SignOptions['expiresIn'] }
    );

const signRefreshToken = (user: TokenUser) =>
    jwt.sign(
        {
            sub: user._id.toString(),
            type: 'refresh',
            jti: crypto.randomUUID(),
        },
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me-in-env',
        { expiresIn: `${refreshTokenTtlSeconds}s` }
    );

const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const setAuthCookies = (res: Pick<Response, 'cookie'>, tokens: TokenPair) => {
    res.cookie('access_token', tokens.accessToken, {
        ...authCookieOptions,
        maxAge: accessTokenTtlSeconds * 1000,
    });

    res.cookie('refresh_token', tokens.refreshToken, {
        ...authCookieOptions,
        maxAge: refreshTokenTtlSeconds * 1000,
    });
};

const clearAuthCookies = (res: Response) => {
    res.clearCookie('access_token', authCookieOptions);
    res.clearCookie('refresh_token', authCookieOptions);
};

const getRefreshTokenFromRequest = (req: Request): string | null => {
    if (req.body && req.body.refresh_token) {
        return req.body.refresh_token;
    }

    if (req.cookies && req.cookies.refresh_token) {
        return req.cookies.refresh_token;
    }

    return null;
};

const toAuthResponse = (user: TokenUser, tokens: TokenPair): AuthResponse => ({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    expires_in: accessTokenTtlSeconds,
    token: tokens.accessToken,
    user: {
        id: user._id,
        name: user.name,
        email: user.email,
        authProvider: user.authProvider,
    },
});

const issueTokenPair = async (user: TokenUser): Promise<TokenPair> => {
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    const decoded = jwt.decode(refreshToken, { json: true });
    const jti = decoded && decoded.jti;

    if (!jti) {
        throw new Error('Failed to create refresh token');
    }

    await RefreshToken.create({
        userId: user._id,
        jti,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshTokenTtlSeconds * 1000),
    });

    return { accessToken, refreshToken, refreshJti: jti };
};

const rotateRefreshTokenPair = async (user: TokenUser, currentTokenDoc: HydratedDocument<IRefreshToken>) => {
    const tokens = await issueTokenPair(user);

    currentTokenDoc.revokedAt = new Date();
    currentTokenDoc.replacedByJti = tokens.refreshJti;
    await currentTokenDoc.save();

    return tokens;
};

const revokeAllUserRefreshTokens = async (userId: Types.ObjectId | string) => {
    await RefreshToken.updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );
};

const hasReachedDeviceQuota = async (userId: Types.ObjectId) => {
    const activeSessions = await RefreshToken.countDocuments({
        userId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
    });

    return activeSessions >= maxDeviceLogins;
};

const verifyGoogleIdentity = async (idToken: string): Promise<OAuthIdentity> => {
    if (!googleClient) {
        throw new Error('GOOGLE_CLIENT_ID is not configured');
    }

    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: googleClientId,
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email || !payload.email_verified) {
        throw new Error('Invalid Google token');
    }

    return {
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email,
        providerId: payload.sub,
    };
};

interface GithubUser {
    id: number;
    login: string;
    name: string | null;
    email: string | null;
}

interface GithubEmail {
    email: string;
    primary: boolean;
    verified: boolean;
}

const verifyGithubIdentity = async (accessToken: string): Promise<OAuthIdentity> => {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'task-management-backend',
    };

    const userResponse = await axios.get<GithubUser>('https://api.github.com/user', { headers });
    const githubUser = userResponse.data;

    let email = githubUser.email;
    if (!email) {
        const emailsResponse = await axios.get<GithubEmail[] | null>('https://api.github.com/user/emails', { headers });
        const primaryVerified = (emailsResponse.data || []).find((item) => item.primary && item.verified);
        email = primaryVerified ? primaryVerified.email : null;
    }

    if (!email) {
        throw new Error('GitHub account has no verified email');
    }

    return {
        email: email.toLowerCase(),
        name: githubUser.name || githubUser.login || email,
        providerId: String(githubUser.id),
    };
};

interface FacebookUser {
    id?: string;
    name?: string;
    email?: string;
}

const verifyFacebookIdentity = async (accessToken: string): Promise<OAuthIdentity> => {
    const response = await axios.get<FacebookUser | null>('https://graph.facebook.com/me', {
        params: {
            fields: 'id,name,email',
            access_token: accessToken,
        },
    });

    const facebookUser = response.data;

    if (!facebookUser || !facebookUser.id) {
        throw new Error('Invalid Facebook token');
    }

    const resolvedEmail = (facebookUser.email || `${facebookUser.id}@facebook.local`).toLowerCase();

    return {
        email: resolvedEmail,
        name: facebookUser.name || resolvedEmail,
        providerId: String(facebookUser.id),
    };
};

interface TwitterUserResponse {
    data?: {
        id?: string;
        name?: string;
        username?: string;
        email?: string;
    };
}

const verifyTwitterIdentity = async (accessToken: string): Promise<OAuthIdentity> => {
    const response = await axios.get<TwitterUserResponse | null>('https://api.twitter.com/2/users/me', {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
        params: {
            'user.fields': 'id,name,username',
        },
    });

    const twitterUser = response.data && response.data.data;

    if (!twitterUser || !twitterUser.id) {
        throw new Error('Invalid Twitter token');
    }

    const usernameOrId = twitterUser.username || twitterUser.id;
    const resolvedEmail = (twitterUser.email || `${usernameOrId}@twitter.local`).toLowerCase();

    return {
        email: resolvedEmail,
        name: twitterUser.name || twitterUser.username || resolvedEmail,
        providerId: String(twitterUser.id),
    };
};

const verifyOAuthIdentity = async ({ provider, idToken, accessToken }: SsoPayload): Promise<OAuthIdentity> => {
    // The route validators already require the right token per provider; the GitHub callback route doesn't run them.
    if (provider === 'google') {
        if (!idToken) {
            throw new Error('idToken is required for Google OAuth2');
        }

        return verifyGoogleIdentity(idToken);
    }

    if (provider !== 'github' && provider !== 'facebook' && provider !== 'twitter') {
        throw new Error('Unsupported provider');
    }

    if (!accessToken) {
        throw new Error('accessToken is required for this OAuth provider');
    }

    if (provider === 'github') {
        return verifyGithubIdentity(accessToken);
    }

    if (provider === 'facebook') {
        return verifyFacebookIdentity(accessToken);
    }

    return verifyTwitterIdentity(accessToken);
};

const buildSsoPayloadFromRequest = (req: Request): SsoPayload => ({
    provider: String((req.body && req.body.provider) || (req.params && req.params.provider) || '').toLowerCase(),
    idToken: (req.body && req.body.idToken) || (req.query && req.query.idToken),
    accessToken: (req.body && req.body.accessToken) || (req.query && req.query.accessToken),
});

export const signup = async (req: Request, res: Response) => {
    try {
        const { name, email, password } = req.body;
        const normalizedEmail = email.toLowerCase();

        // The unique email index is the check: no extra lookup, and concurrent signups can't both succeed.
        let user;
        try {
            user = await User.create({
                name,
                email: normalizedEmail,
                password,
                authProvider: 'local',
            });
        } catch (error) {
            if (isDuplicateKeyError(error)) {
                return res.status(409).json({ message: 'User already exists' });
            }
            throw error;
        }

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);

        publishAuthEvent('user_signed_up', { userId: user._id, email: user.email });

        return res.status(201).json(toAuthResponse(user, tokens));
    } catch (error) {
        console.error('Signup failed:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const login = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email.toLowerCase();

        const user = await User.findOne({ email: normalizedEmail }).select('+password');
        if (!user || !user.password) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Independent: overlap the session count query with the bcrypt work instead of running them back to back.
        // The password result is still checked first, so a wrong password never reveals the quota state.
        const [isMatch, reachedQuota] = await Promise.all([
            user.comparePassword(password),
            hasReachedDeviceQuota(user._id),
        ]);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (reachedQuota) {
            return res.status(409).json({ message: maxDeviceMessage });
        }

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);

        publishAuthEvent('user_logged_in', { userId: user._id, email: user.email });

        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        console.error('Login failed:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const forceLogin = async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;
        const normalizedEmail = email.toLowerCase();

        const user = await User.findOne({ email: normalizedEmail }).select('+password');

        if (!user || !user.password) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        await revokeAllUserRefreshTokens(user._id);

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);

        publishAuthEvent('user_force_logged_in', { userId: user._id, email: user.email });

        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        console.error('Force login failed:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const sso = async <T>(req: Request, res: SsoResponder<T>): Promise<T> => {
    try {
        const { provider, idToken, accessToken } = buildSsoPayloadFromRequest(req);
        const identity = await verifyOAuthIdentity({ provider, idToken, accessToken });
        const normalizedEmail = identity.email;

        let user = await User.findOne({
            $or: [
                { email: normalizedEmail },
                { authProvider: provider, providerId: identity.providerId },
            ],
        });

        if (!user) {
            user = await User.create({
                name: identity.name,
                email: normalizedEmail,
                authProvider: provider,
                providerId: identity.providerId,
            });
        } else {
            user.name = identity.name || user.name;
            user.authProvider = provider;
            user.providerId = identity.providerId;
            await user.save();
            await invalidate(cacheKeys.userProfile(user._id.toString()));
        }

        const reachedQuota = await hasReachedDeviceQuota(user._id);
        if (reachedQuota) {
            return res.status(409).json({ message: maxDeviceMessage });
        }

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);

        publishAuthEvent('user_sso_login', { userId: user._id, email: user.email, provider });

        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(401).json({ message: (error instanceof Error && error.message) || 'OAuth authentication failed' });
    }
};

export const ssoByProvider = async (req: Request, res: Response) => sso(req, res);

export const refreshToken = async (req: Request, res: Response) => {
    try {
        const refreshTokenValue = getRefreshTokenFromRequest(req);

        if (!refreshTokenValue) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const decoded = jwt.verify(
            refreshTokenValue,
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me-in-env'
        );

        if (typeof decoded === 'string' || decoded.type !== 'refresh' || !decoded.sub || !decoded.jti) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        // Independent lookups: run them in one round trip instead of two.
        const [tokenDoc, user] = await Promise.all([
            RefreshToken.findOne({ jti: decoded.jti }),
            User.findById(decoded.sub).lean(),
        ]);

        if (!tokenDoc) {
            await revokeAllUserRefreshTokens(decoded.sub);
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const isExpired = tokenDoc.expiresAt <= new Date();
        const isRevoked = Boolean(tokenDoc.revokedAt);
        const isHashMismatch = tokenDoc.tokenHash !== hashToken(refreshTokenValue);

        if (isExpired || isRevoked || isHashMismatch) {
            await revokeAllUserRefreshTokens(decoded.sub);
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        if (!user) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const tokens = await rotateRefreshTokenPair(user, tokenDoc);
        setAuthCookies(res, tokens);

        publishAuthEvent('token_refreshed', { userId: user._id, email: user.email });

        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(401).json({ message: 'Invalid refresh token' });
    }
};

export const revokeToken = async (req: Request, res: Response) => {
    try {
        const refreshTokenValue = getRefreshTokenFromRequest(req);

        if (!refreshTokenValue) {
            clearAuthCookies(res);
            return res.status(200).json({ revoked: false });
        }

        const decoded = jwt.verify(
            refreshTokenValue,
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me-in-env'
        );

        if (typeof decoded === 'string' || decoded.type !== 'refresh' || !decoded.sub || !decoded.jti) {
            clearAuthCookies(res);
            return res.status(200).json({ revoked: false });
        }

        const tokenDoc = await RefreshToken.findOne({ jti: decoded.jti });

        if (!tokenDoc || tokenDoc.tokenHash !== hashToken(refreshTokenValue)) {
            clearAuthCookies(res);
            return res.status(200).json({ revoked: false });
        }

        if (!tokenDoc.revokedAt) {
            tokenDoc.revokedAt = new Date();
            await tokenDoc.save();

            publishAuthEvent('token_revoked', { userId: decoded.sub, jti: decoded.jti });
        }

        clearAuthCookies(res);
        return res.status(200).json({ revoked: true });
    } catch (error) {
        clearAuthCookies(res);
        return res.status(200).json({ revoked: false });
    }
};

export const me = async (req: Request, res: Response) => {
    try {
        const userId = getAuthUser(req).id;

        // Cached; the only profile mutation (SSO re-link in sso()) invalidates it.
        const { body, status } = await readThrough({
            ...cacheKeys.userProfile(userId),
            load: async () => {
                const user = await User.findById(userId).select('name email authProvider').lean();

                return user && {
                    user: {
                        id: user._id,
                        name: user.name,
                        email: user.email,
                        authProvider: user.authProvider,
                    },
                };
            },
        });

        if (body === null) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).set('X-Cache', status).type('json').send(body);
    } catch (error) {
        console.error('Failed to load current user:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
