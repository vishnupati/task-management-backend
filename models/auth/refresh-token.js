const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        jti: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        tokenHash: {
            type: String,
            required: true,
            index: true,
        },
        revokedAt: {
            type: Date,
            default: null,
            index: true,
        },
        replacedByJti: {
            type: String,
            default: null,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);