import express from 'express';
import axios from 'axios';
import { signup, login, forceLogin, sso, ssoByProvider, refreshToken, revokeToken, me, type SsoResponseBody } from '../controllers/auth';
import {
    validateSignup,
    validateLogin,
    validateForceLogin,
    validateSso,
    validateSsoProviderRoute,
    validateRefreshToken,
    validateRevokeToken,
} from '../models/auth/validator';
import { authenticate } from '../middlewares/auth';
import { validateRequest } from '../middlewares/validate-request';
import { getErrorMessage } from '../utils/errors';

const router = express.Router();

router.post('/signup', validateSignup, validateRequest, signup);
router.post('/login', validateLogin, validateRequest, login);
router.post('/force-login', validateForceLogin, validateRequest, forceLogin);
router.post('/sso', validateSso, validateRequest, sso);
router.get('/sso/:provider', validateSsoProviderRoute, validateRequest, ssoByProvider);
router.post('/oauth2/token', validateSso, validateRequest, sso);
router.post('/callback', validateSso, validateRequest, sso);
router.post('/sso/callback', validateSso, validateRequest, sso);
router.post('/token/refresh', validateRefreshToken, validateRequest, refreshToken);
router.post('/token/revoke', validateRevokeToken, validateRequest, revokeToken);
router.post('/logout', validateRevokeToken, validateRequest, revokeToken);
router.get('/me', authenticate, me);

router.get('/github/callback', async (req, res) => {
    try {
        const code = req.query.code;

        // 1. Exchange code for GitHub access_token
        const tokenRes = await axios.post<{ access_token?: string }>(
            'https://github.com/login/oauth/access_token',
            {
                client_id: process.env.GITHUB_CLIENT_ID,
                client_secret: process.env.GITHUB_CLIENT_SECRET,
                code,
            },
            {
                headers: { Accept: 'application/json' },
            }
        );

        const accessToken = tokenRes.data.access_token;

        // 2. Build fake req body for your sso()
        req.body = {
            provider: 'github',
            accessToken,
        };

        // 3. Call your existing SSO handler
        // It will create JWT access + refresh tokens
        let ssoStatus = 200;
        const jsonResponse = await sso(req, {
            status: (statusCode: number) => {
                ssoStatus = statusCode;
                return { json: (data: SsoResponseBody) => data };
            },
            cookie: res.cookie.bind(res),
        });

        // sso() reports failures (bad code, device quota reached) via status, not by throwing.
        if (ssoStatus !== 200 || 'message' in jsonResponse) {
            const message = 'message' in jsonResponse ? jsonResponse.message : '';
            return res.redirect(
                `${process.env.FRONTEND_URL || 'http://localhost:4200'}/oauth-error?message=${encodeURIComponent(message || 'OAuth authentication failed')}`
            );
        }

        const { access_token, refresh_token, user } = jsonResponse;

        // 4. Redirect to frontend with tokens in query params
        // ⚠️ Do NOT send accessToken in URL in production (optional: use HttpOnly cookies)
        const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:4200'}/auth/callback?access_token=${access_token}&refresh_token=${refresh_token}&user=${encodeURIComponent(
            JSON.stringify(user)
        )}`;

        return res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        return res.redirect(
            `${process.env.FRONTEND_URL || 'http://localhost:4200'}/oauth-error?message=${encodeURIComponent(getErrorMessage(err))}`
        );
    }
});

export default router;
