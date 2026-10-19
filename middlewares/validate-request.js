const { validationResult } = require('express-validator');

const validateRequest = (req, res, next) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const details = errors.array();
        // `message` matches the shape of every other error response so clients can show it directly.
        return res.status(400).json({ message: details[0].msg, errors: details });
    }

    return next();
};

module.exports = { validateRequest };