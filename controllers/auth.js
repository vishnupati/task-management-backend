const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/user/user');
const RefreshToken = require('../models/auth/refresh-token');

const maxDeviceLogins = Number(process.env.MAX_DEVICE_LOGINS || 3);
const sessionTtlSeconds = Number(process.env.SESSION_TTL_SECONDS || 60 * 30);
const accessTokenTtlSeconds = Number(process.env.ACCESS_TOKEN_TTL_SECONDS || sessionTtlSeconds);
const refreshTokenTtlSeconds = Number(process.env.REFRESH_TOKEN_TTL_SECONDS || sessionTtlSeconds);
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;
const maxDeviceMessage = 'reached maxiamum login quata , if you want to login this device logout other devices';

const authCookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
};

const signAccessToken = (user) =>
    jwt.sign(
        { sub: user._id.toString(), email: user.email },
        process.env.JWT_SECRET || 'change-me-in-env',
        { expiresIn: process.env.JWT_EXPIRES_IN || `${accessTokenTtlSeconds}s` }
    );

const signRefreshToken = (user) =>
    jwt.sign(
        {
            sub: user._id.toString(),
            type: 'refresh',
            jti: crypto.randomUUID(),
        },
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me-in-env',
        { expiresIn: `${refreshTokenTtlSeconds}s` }
    );

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

const setAuthCookies = (res, tokens) => {
    res.cookie('access_token', tokens.accessToken, {
        ...authCookieOptions,
        maxAge: accessTokenTtlSeconds * 1000,
    });

    res.cookie('refresh_token', tokens.refreshToken, {
        ...authCookieOptions,
        maxAge: refreshTokenTtlSeconds * 1000,
    });
};

const clearAuthCookies = (res) => {
    res.clearCookie('access_token', authCookieOptions);
    res.clearCookie('refresh_token', authCookieOptions);
};

const getRefreshTokenFromRequest = (req) => {
    if (req.body && req.body.refresh_token) {
        return req.body.refresh_token;
    }

    if (req.cookies && req.cookies.refresh_token) {
        return req.cookies.refresh_token;
    }

    return null;
};

const toAuthResponse = (user, tokens) => ({
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

const issueTokenPair = async (user) => {
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    const decoded = jwt.decode(refreshToken);
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

const rotateRefreshTokenPair = async (user, currentTokenDoc) => {
    const tokens = await issueTokenPair(user);

    currentTokenDoc.revokedAt = new Date();
    currentTokenDoc.replacedByJti = tokens.refreshJti;
    await currentTokenDoc.save();

    return tokens;
};

const revokeAllUserRefreshTokens = async (userId) => {
    await RefreshToken.updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: new Date() } }
    );
};

const hasReachedDeviceQuota = async (userId) => {
    const activeSessions = await RefreshToken.countDocuments({
        userId,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
    });

    return activeSessions >= maxDeviceLogins;
};

const verifyGoogleIdentity = async (idToken) => {

    console.log('Google client initialized:', !!googleClient);
    if (!googleClient) {
        throw new Error('GOOGLE_CLIENT_ID is not configured');
    }

    console.log('Verifying Google ID token:', idToken);

    const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: googleClientId,
    });

    const payload = ticket.getPayload();

    console.log('Google token payload:', payload);

    if (!payload || !payload.email || !payload.email_verified) {
        throw new Error('Invalid Google token');
    }

    return {
        email: payload.email.toLowerCase(),
        name: payload.name || payload.email,
        providerId: payload.sub,
    };
};

const verifyGithubIdentity = async (accessToken) => {
    const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'task-management-backend',
    };

    const userResponse = await axios.get('https://api.github.com/user', { headers });
    const githubUser = userResponse.data;

    let email = githubUser.email;
    if (!email) {
        const emailsResponse = await axios.get('https://api.github.com/user/emails', { headers });
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

const verifyFacebookIdentity = async (accessToken) => {
    const response = await axios.get('https://graph.facebook.com/me', {
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

const verifyTwitterIdentity = async (accessToken) => {
    const response = await axios.get('https://api.twitter.com/2/users/me', {
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

const verifyOAuthIdentity = async ({ provider, idToken, accessToken }) => {
    if (provider === 'google') {
        return verifyGoogleIdentity(idToken);
    }

    if (provider === 'github') {
        return verifyGithubIdentity(accessToken);
    }

    if (provider === 'facebook') {
        return verifyFacebookIdentity(accessToken);
    }

    if (provider === 'twitter') {
        return verifyTwitterIdentity(accessToken);
    }

    throw new Error('Unsupported provider');
};

const buildSsoPayloadFromRequest = (req) => ({
    provider: String((req.body && req.body.provider) || (req.params && req.params.provider) || '').toLowerCase(),
    idToken: (req.body && req.body.idToken) || (req.query && req.query.idToken),
    accessToken: (req.body && req.body.accessToken) || (req.query && req.query.accessToken),
});

const signup = async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const normalizedEmail = email.toLowerCase();

        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(409).json({ message: 'User already exists' });
        }

        const user = await User.create({
            name,
            email: normalizedEmail,
            password,
            authProvider: 'local',
        });

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);
        return res.status(201).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const login = async (req, res) => {
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

        const reachedQuota = await hasReachedDeviceQuota(user._id);
        if (reachedQuota) {
            return res.status(409).json({ message: maxDeviceMessage });
        }

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);
        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const forceLogin = async (req, res) => {
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
        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

const sso = async (req, res) => {
    try {
        const { provider, idToken, accessToken } = buildSsoPayloadFromRequest(req);
        const identity = await verifyOAuthIdentity({ provider, idToken, accessToken });
        console.log('Verified identity from provider:', provider, identity);
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
        }

        const reachedQuota = await hasReachedDeviceQuota(user._id);
        if (reachedQuota) {
            return res.status(409).json({ message: maxDeviceMessage });
        }

        const tokens = await issueTokenPair(user);
        setAuthCookies(res, tokens);
        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(401).json({ message: error.message || 'OAuth authentication failed' });
    }
};

const ssoByProvider = async (req, res) => sso(req, res);

const refreshToken = async (req, res) => {
    try {
        const refreshTokenValue = getRefreshTokenFromRequest(req);

        if (!refreshTokenValue) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const decoded = jwt.verify(
            refreshTokenValue,
            process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'change-me-in-env'
        );

        if (!decoded || decoded.type !== 'refresh') {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const tokenDoc = await RefreshToken.findOne({ jti: decoded.jti });

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

        const user = await User.findById(decoded.sub);
        if (!user) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const tokens = await rotateRefreshTokenPair(user, tokenDoc);
        setAuthCookies(res, tokens);
        return res.status(200).json(toAuthResponse(user, tokens));
    } catch (error) {
        return res.status(401).json({ message: 'Invalid refresh token' });
    }
};

const revokeToken = async (req, res) => {
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

        if (!decoded || decoded.type !== 'refresh') {
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
        }

        clearAuthCookies(res);
        return res.status(200).json({ revoked: true });
    } catch (error) {
        clearAuthCookies(res);
        return res.status(200).json({ revoked: false });
    }
};

const me = async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).json({
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                authProvider: user.authProvider,
            },
        });
    } catch (error) {
        return res.status(500).json({ message: error.message });
    }
};

module.exports = { signup, login, forceLogin, sso, ssoByProvider, refreshToken, revokeToken, me };