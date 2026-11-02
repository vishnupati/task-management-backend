import crypto from 'crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import type { HydratedDocument, Types } from 'mongoose';
import { RefreshToken, User, type IRefreshToken, type IUser } from '../models';
import { TOPICS, cacheKeys, invalidate, publish, readThrough, type ReadThroughResult } from '../lib';
import { getErrorMessage, isDuplicateKeyError } from '../utils';
import { config } from '../config';

const googleClient = config.auth.googleClientId ? new OAuth2Client(config.auth.googleClientId) : null;

export type AuthErrorReason = 'user_exists' | 'invalid_credentials' | 'device_quota';

// An expected failure, which the caller turns into a response. Anything else thrown from here is unexpected.
export class AuthError extends Error {
    constructor(readonly reason: AuthErrorReason) {
        super(reason);
        this.name = 'AuthError';
    }
}

// The user as returned to clients.
export interface SessionUser {
    id: string;
    name: string;
    email: string;
    authProvider: string;
}

export interface TokenPair {
    accessToken: string;
    refreshToken: string;
}

export interface AuthSession {
    user: SessionUser;
    tokens: TokenPair;
}

export interface SsoPayload {
    provider: string;
    idToken?: string;
    accessToken?: string;
}

// What tokens and sessions are built from; satisfied by both user documents and lean query results.
type TokenUser = Pick<IUser, 'name' | 'email' | 'authProvider'> & { _id: Types.ObjectId };

interface IssuedTokens extends TokenPair {
    refreshJti: string;
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
        config.auth.jwtSecret,
        // jsonwebtoken parses the duration (ms format) and throws on sign if JWT_EXPIRES_IN is malformed.
        { expiresIn: (config.auth.jwtExpiresIn || `${config.auth.accessTokenTtlSeconds}s`) as SignOptions['expiresIn'] }
    );

const signRefreshToken = (user: TokenUser) =>
    jwt.sign(
        {
            sub: user._id.toString(),
            type: 'refresh',
            jti: crypto.randomUUID(),
        },
        config.auth.jwtRefreshSecret,
        { expiresIn: `${config.auth.refreshTokenTtlSeconds}s` }
    );

const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const toSessionUser = (user: TokenUser): SessionUser => ({
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    authProvider: user.authProvider,
});

const toSession = (user: TokenUser, { accessToken, refreshToken }: TokenPair): AuthSession => ({
    user: toSessionUser(user),
    tokens: { accessToken, refreshToken },
});

const issueTokenPair = async (user: TokenUser): Promise<IssuedTokens> => {
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
        expiresAt: new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000),
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

    return activeSessions >= config.auth.maxDeviceLogins;
};

// The claims of a refresh token we issued, or null if the token is malformed, expired, badly signed or not a refresh token.
const verifyRefreshToken = (token: string): { sub: string; jti: string } | null => {
    let decoded;
    try {
        decoded = jwt.verify(token, config.auth.jwtRefreshSecret);
    } catch (error) {
        if (error instanceof jwt.JsonWebTokenError) {
            return null;
        }
        throw error;
    }

    if (typeof decoded === 'string' || decoded.type !== 'refresh' || !decoded.sub || !decoded.jti) {
        return null;
    }

    return { sub: decoded.sub, jti: decoded.jti };
};

// Null when the user doesn't exist or has no password (an SSO-only account).
const findPasswordUser = async (email: string) => {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    return user && user.password ? user : null;
};

const verifyGoogleIdentity = async (idToken: string): Promise<OAuthIdentity> => {
    if (!googleClient) {
        throw new Error('GOOGLE_CLIENT_ID is not configured');
    }

    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: config.auth.googleClientId,
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
    // The route validators already require the right token per provider; the GitHub callback doesn't go through them.
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

export const registerUser = async ({ name, email, password }: { name: string; email: string; password: string }): Promise<AuthSession> => {
    // The unique email index is the check: no extra lookup, and concurrent signups can't both succeed.
    let user;
    try {
        user = await User.create({
            name,
            email: email.toLowerCase(),
            password,
            authProvider: 'local',
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            throw new AuthError('user_exists');
        }
        throw error;
    }

    const tokens = await issueTokenPair(user);
    publishAuthEvent('user_signed_up', { userId: user._id, email: user.email });

    return toSession(user, tokens);
};

export const loginWithPassword = async (email: string, password: string): Promise<AuthSession> => {
    const user = await findPasswordUser(email);
    if (!user) {
        throw new AuthError('invalid_credentials');
    }

    // Independent: overlap the session count query with the bcrypt work instead of running them back to back.
    // The password result is still checked first, so a wrong password never reveals the quota state.
    const [isMatch, reachedQuota] = await Promise.all([
        user.comparePassword(password),
        hasReachedDeviceQuota(user._id),
    ]);
    if (!isMatch) {
        throw new AuthError('invalid_credentials');
    }

    if (reachedQuota) {
        throw new AuthError('device_quota');
    }

    const tokens = await issueTokenPair(user);
    publishAuthEvent('user_logged_in', { userId: user._id, email: user.email });

    return toSession(user, tokens);
};

// For when the device quota is reached: signs out every other session, then logs in.
export const forceLoginWithPassword = async (email: string, password: string): Promise<AuthSession> => {
    const user = await findPasswordUser(email);
    if (!user || !(await user.comparePassword(password))) {
        throw new AuthError('invalid_credentials');
    }

    await revokeAllUserRefreshTokens(user._id);

    const tokens = await issueTokenPair(user);
    publishAuthEvent('user_force_logged_in', { userId: user._id, email: user.email });

    return toSession(user, tokens);
};

// Verification failures (bad token, provider unreachable) are thrown as plain errors whose message explains why.
export const loginWithSso = async (payload: SsoPayload): Promise<AuthSession> => {
    const { provider } = payload;
    const identity = await verifyOAuthIdentity(payload);
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
        throw new AuthError('device_quota');
    }

    const tokens = await issueTokenPair(user);
    publishAuthEvent('user_sso_login', { userId: user._id, email: user.email, provider });

    return toSession(user, tokens);
};

// The code from GitHub's OAuth redirect, passed through as received. GitHub answers a bad code without an
// access_token, which loginWithSso then rejects.
export const exchangeGithubCode = async (code: unknown): Promise<string | undefined> => {
    const response = await axios.post<{ access_token?: string }>(
        'https://github.com/login/oauth/access_token',
        {
            client_id: config.auth.githubClientId,
            client_secret: config.auth.githubClientSecret,
            code,
        },
        {
            headers: { Accept: 'application/json' },
        }
    );

    return response.data.access_token;
};

// Rotates the refresh token: the presented one is revoked and a new pair issued. Null if it isn't a current refresh
// token. An unknown, rotated or revoked one also revokes all of the user's sessions, as a replay suggests theft.
export const refreshSession = async (refreshToken: string): Promise<AuthSession | null> => {
    const claims = verifyRefreshToken(refreshToken);
    if (!claims) {
        return null;
    }

    // Independent lookups: run them in one round trip instead of two.
    const [tokenDoc, user] = await Promise.all([
        RefreshToken.findOne({ jti: claims.jti }),
        User.findById(claims.sub).lean(),
    ]);

    if (!tokenDoc) {
        await revokeAllUserRefreshTokens(claims.sub);
        return null;
    }

    const isExpired = tokenDoc.expiresAt <= new Date();
    const isRevoked = Boolean(tokenDoc.revokedAt);
    const isHashMismatch = tokenDoc.tokenHash !== hashToken(refreshToken);

    if (isExpired || isRevoked || isHashMismatch) {
        await revokeAllUserRefreshTokens(claims.sub);
        return null;
    }

    if (!user) {
        return null;
    }

    const tokens = await rotateRefreshTokenPair(user, tokenDoc);
    publishAuthEvent('token_refreshed', { userId: user._id, email: user.email });

    return toSession(user, tokens);
};

// Logout. True if the token is one of ours, even if it was already revoked.
export const revokeSession = async (refreshToken: string): Promise<boolean> => {
    const claims = verifyRefreshToken(refreshToken);
    if (!claims) {
        return false;
    }

    const tokenDoc = await RefreshToken.findOne({ jti: claims.jti });
    if (!tokenDoc || tokenDoc.tokenHash !== hashToken(refreshToken)) {
        return false;
    }

    if (!tokenDoc.revokedAt) {
        tokenDoc.revokedAt = new Date();
        await tokenDoc.save();

        publishAuthEvent('token_revoked', { userId: claims.sub, jti: claims.jti });
    }

    return true;
};

// Cached; the only profile mutation (the SSO re-link in loginWithSso) invalidates it. body is null for an unknown user.
export const getUserProfile = (userId: string): Promise<ReadThroughResult> =>
    readThrough({
        ...cacheKeys.userProfile(userId),
        load: async () => {
            const user = await User.findById(userId).select('name email authProvider').lean();

            return user && { user: toSessionUser(user) };
        },
    });
