const jwt = require('jsonwebtoken');

// Stateless: the signed access token is trusted for its (short) lifetime, so authenticated requests
// don't pay a MongoDB round trip. Endpoints that need the full user (e.g. /me) load it themselves.
const authenticate = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || '';
        const [scheme, token] = authHeader.split(' ');
        const cookieToken = req.cookies && req.cookies.access_token;
        const accessToken = scheme === 'Bearer' && token ? token : cookieToken;

        if (!accessToken) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const decoded = jwt.verify(accessToken, process.env.JWT_SECRET || 'change-me-in-env');

        // Refresh tokens are signed with JWT_SECRET too when JWT_REFRESH_SECRET is unset; never accept one here.
        if (!decoded.sub || decoded.type === 'refresh') {
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

module.exports = { authenticate };
