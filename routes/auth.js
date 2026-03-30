const express = require('express');
const axios = require('axios');
const router = express.Router();
const { signup, login, forceLogin, sso, ssoByProvider, refreshToken, revokeToken, me } = require('../controllers/auth');
const {
    validateSignup,
    validateLogin,
    validateForceLogin,
    validateSso,
    validateSsoProviderRoute,
    validateRefreshToken,
    validateRevokeToken,
} = require('../models/auth/validator');
const { authenticate } = require('../middlewares/auth');
const { validateRequest } = require('../middlewares/validate-request');

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
router.get('/me', authenticate, me);

router.get('/github/callback', async (req, res) => {
    try {
        const code = req.query.code;

        // 1. Exchange code for GitHub access_token
        const tokenRes = await axios.post(
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
        const jsonResponse = await sso(req, {
            status: (statusCode) => ({
                json: (data) => data,
            }),
            cookie: res.cookie.bind(res),
        });
        console.log('SSO response:', jsonResponse);

        const { access_token, refresh_token, user } = jsonResponse;

        // 4. Redirect to frontend with tokens in query params
        // ⚠️ Do NOT send accessToken in URL in production (optional: use HttpOnly cookies)
        const redirectUrl = `http://localhost:3000/auth/callback?access_token=${access_token}&refresh_token=${refresh_token}&user=${encodeURIComponent(
            JSON.stringify(user)
        )}`;

        return res.redirect(redirectUrl);
    } catch (err) {
        console.error(err);
        return res.redirect(
            `http://localhost:3000/oauth-error?message=${encodeURIComponent(err.message)}`
        );
    }
});

module.exports = router;