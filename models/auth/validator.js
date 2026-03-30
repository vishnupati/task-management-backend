const { body, param, query } = require('express-validator');

const ssoProviders = ['google', 'github', 'facebook', 'twitter'];

const validateSsoTokenByProvider = (source) =>
    source.custom((_, { req }) => {
        const provider = String((req.body && req.body.provider) || (req.params && req.params.provider) || '').toLowerCase();
        const idToken = (req.body && req.body.idToken) || (req.query && req.query.idToken);
        const accessToken = (req.body && req.body.accessToken) || (req.query && req.query.accessToken);

        if (provider === 'google' && !idToken) {
            throw new Error('idToken is required for Google OAuth2');
        }

        if (['github', 'facebook', 'twitter'].includes(provider) && !accessToken) {
            throw new Error('accessToken is required for this OAuth provider');
        }

        return true;
    });

const validateSignup = [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().withMessage('A valid email is required'),
    body('password')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long'),
];

const validateLogin = [
    body('email').isEmail().withMessage('A valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
];

const validateForceLogin = validateLogin;

const validateSso = [
    body('provider')
        .isIn(ssoProviders)
        .withMessage(`Provider must be one of: ${ssoProviders.join(', ')}`),
    body('idToken')
        .optional()
        .isString()
        .withMessage('idToken must be a string'),
    body('accessToken')
        .optional()
        .isString()
        .withMessage('accessToken must be a string'),
    validateSsoTokenByProvider(body()),
];

const validateSsoProviderRoute = [
    param('provider')
        .isIn(ssoProviders)
        .withMessage(`Provider must be one of: ${ssoProviders.join(', ')}`),
    query('idToken')
        .optional()
        .isString()
        .withMessage('idToken must be a string'),
    query('accessToken')
        .optional()
        .isString()
        .withMessage('accessToken must be a string'),
    body('idToken')
        .optional()
        .isString()
        .withMessage('idToken must be a string'),
    body('accessToken')
        .optional()
        .isString()
        .withMessage('accessToken must be a string'),
    validateSsoTokenByProvider(body()),
];

const validateRefreshToken = [
    body('refresh_token')
        .optional()
        .isString()
        .notEmpty()
        .withMessage('refresh_token must be a non-empty string'),
    body().custom((value, { req }) => {
        if (value.refresh_token || (req.cookies && req.cookies.refresh_token)) {
            return true;
        }

        throw new Error('refresh_token is required');
    }),
];

const validateRevokeToken = validateRefreshToken;

module.exports = {
    validateSignup,
    validateLogin,
    validateForceLogin,
    validateSso,
    validateSsoProviderRoute,
    validateRefreshToken,
    validateRevokeToken,
};