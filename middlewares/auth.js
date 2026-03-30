const jwt = require('jsonwebtoken');
const User = require('../models/user/user');

const authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization || '';
        const [scheme, token] = authHeader.split(' ');
        const cookieToken = req.cookies && req.cookies.access_token;
        const accessToken = scheme === 'Bearer' && token ? token : cookieToken;

        if (!accessToken) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const decoded = jwt.verify(accessToken, process.env.JWT_SECRET || 'change-me-in-env');
        const user = await User.findById(decoded.sub);

        if (!user) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        req.user = {
            id: user._id.toString(),
            email: user.email,
            name: user.name,
        };

        return next();
    } catch (error) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
};

module.exports = { authenticate };