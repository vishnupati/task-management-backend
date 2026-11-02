import express from 'express';
import { signup, login, forceLogin, sso, ssoByProvider, githubCallback, refreshToken, revokeToken, me } from '../controllers';
import {
    validateSignup,
    validateLogin,
    validateForceLogin,
    validateSso,
    validateSsoProviderRoute,
    validateRefreshToken,
    validateRevokeToken,
} from '../validators';
import { authenticate, validateRequest } from '../middlewares';

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
router.get('/github/callback', githubCallback);

export default router;
