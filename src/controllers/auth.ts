import type { Request, Response } from 'express';
import {
    AuthError,
    forceLoginWithPassword,
    getUserProfile,
    loginWithGithubCode,
    loginWithPassword,
    loginWithSso,
    refreshSession,
    registerUser,
    revokeSession,
} from '../services';
import { getAuthUser } from '../middlewares';
import type { AuthErrorReason, AuthResponse, AuthSession, SsoPayload, TokenPair } from '../types';
import { getErrorMessage } from '../utils';
import { config } from '../config';

const maxDeviceMessage = 'reached maxiamum login quata , if you want to login this device logout other devices';

const authCookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    // Browsers drop SameSite=None cookies that aren't Secure, which silently broke cookie auth outside production.
    sameSite: config.isProduction ? 'none' : 'lax',
    path: '/',
} as const;

const authErrorResponses: Record<AuthErrorReason, { status: number; message: string }> = {
    user_exists: { status: 409, message: 'User already exists' },
    invalid_credentials: { status: 401, message: 'Invalid credentials' },
    device_quota: { status: 409, message: maxDeviceMessage },
    email_in_use: { status: 409, message: 'This email is already registered. Sign in with the method you used before.' },
};

const toAuthResponse = ({ user, tokens }: AuthSession): AuthResponse => ({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: 'Bearer',
    expires_in: config.auth.accessTokenTtlSeconds,
    token: tokens.accessToken,
    user,
});

const setAuthCookies = (res: Response, tokens: TokenPair) => {
    res.cookie('access_token', tokens.accessToken, {
        ...authCookieOptions,
        maxAge: config.auth.accessTokenTtlSeconds * 1000,
    });

    res.cookie('refresh_token', tokens.refreshToken, {
        ...authCookieOptions,
        maxAge: config.auth.refreshTokenTtlSeconds * 1000,
    });
};

const clearAuthCookies = (res: Response) => {
    res.clearCookie('access_token', authCookieOptions);
    res.clearCookie('refresh_token', authCookieOptions);
};

// Tokens go out both as cookies and in the body, for clients that don't use cookies.
const sendSession = (res: Response, status: number, session: AuthSession) => {
    setAuthCookies(res, session.tokens);
    return res.status(status).json(toAuthResponse(session));
};

const sendAuthError = (res: Response, error: AuthError) => {
    const { status, message } = authErrorResponses[error.reason];
    return res.status(status).json({ message });
};

// Why SSO verification failed (rejected token, provider error), as shown to the client.
const ssoFailureMessage = (error: unknown) => (error instanceof Error && error.message) || 'OAuth authentication failed';

const redirectToOAuthError = (res: Response, message: string) =>
    res.redirect(`${config.frontendUrl}/oauth-error?message=${encodeURIComponent(message)}`);

const getRefreshTokenFromRequest = (req: Request): string | null => {
    if (req.body && req.body.refresh_token) {
        return req.body.refresh_token;
    }

    if (req.cookies && req.cookies.refresh_token) {
        return req.cookies.refresh_token;
    }

    return null;
};

const buildSsoPayloadFromRequest = (req: Request): SsoPayload => ({
    provider: String((req.body && req.body.provider) || (req.params && req.params.provider) || '').toLowerCase(),
    idToken: (req.body && req.body.idToken) || (req.query && req.query.idToken),
    accessToken: (req.body && req.body.accessToken) || (req.query && req.query.accessToken),
});

export const signup = async (req: Request, res: Response) => {
    try {
        const { name, email, password } = req.body;
        return sendSession(res, 201, await registerUser({ name, email, password }));
    } catch (error) {
        if (error instanceof AuthError) {
            return sendAuthError(res, error);
        }

        console.error('Signup failed:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const login = async (req: Request, res: Response) => {
    try {
        return sendSession(res, 200, await loginWithPassword(req.body.email, req.body.password));
    } catch (error) {
        if (error instanceof AuthError) {
            return sendAuthError(res, error);
        }

        console.error('Login failed:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const forceLogin = async (req: Request, res: Response) => {
    try {
        return sendSession(res, 200, await forceLoginWithPassword(req.body.email, req.body.password));
    } catch (error) {
        if (error instanceof AuthError) {
            return sendAuthError(res, error);
        }

        console.error('Force login failed:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

export const sso = async (req: Request, res: Response) => {
    try {
        return sendSession(res, 200, await loginWithSso(buildSsoPayloadFromRequest(req)));
    } catch (error) {
        if (error instanceof AuthError) {
            return sendAuthError(res, error);
        }

        return res.status(401).json({ message: ssoFailureMessage(error) });
    }
};

export const ssoByProvider = async (req: Request, res: Response) => sso(req, res);

// GitHub's OAuth redirect lands here with a code; the outcome goes back to the frontend as a redirect.
export const githubCallback = async (req: Request, res: Response) => {
    try {
        const session = await loginWithGithubCode(req.query.code);
        setAuthCookies(res, session.tokens);

        // ⚠️ Do NOT send accessToken in URL in production (optional: use HttpOnly cookies)
        const { access_token, refresh_token, user } = toAuthResponse(session);
        return res.redirect(
            `${config.frontendUrl}/auth/callback?access_token=${access_token}&refresh_token=${refresh_token}&user=${encodeURIComponent(JSON.stringify(user))}`
        );
    } catch (error) {
        // The same failures POST /sso reports with a status code.
        if (error instanceof AuthError) {
            return redirectToOAuthError(res, authErrorResponses[error.reason].message);
        }

        // The message only: a failed code exchange carries the request, GitHub client secret included.
        console.error('GitHub login failed:', getErrorMessage(error));
        return redirectToOAuthError(res, ssoFailureMessage(error));
    }
};

export const refreshToken = async (req: Request, res: Response) => {
    try {
        const refreshTokenValue = getRefreshTokenFromRequest(req);
        const session = refreshTokenValue ? await refreshSession(refreshTokenValue) : null;

        if (!session) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        return sendSession(res, 200, session);
    } catch (error) {
        return res.status(401).json({ message: 'Invalid refresh token' });
    }
};

export const revokeToken = async (req: Request, res: Response) => {
    const refreshTokenValue = getRefreshTokenFromRequest(req);
    // Logout always succeeds for the client: cookies are cleared even if the token is missing, invalid or can't be revoked.
    const revoked = refreshTokenValue ? await revokeSession(refreshTokenValue).catch(() => false) : false;

    clearAuthCookies(res);
    return res.status(200).json({ revoked });
};

export const me = async (req: Request, res: Response) => {
    try {
        const { body, status } = await getUserProfile(getAuthUser(req).id);

        if (body === null) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).set('X-Cache', status).type('json').send(body);
    } catch (error) {
        console.error('Failed to load current user:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};
