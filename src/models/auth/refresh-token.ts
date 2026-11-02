import mongoose, { type Types } from 'mongoose';

export interface IRefreshToken {
    userId: Types.ObjectId;
    jti: string;
    tokenHash: string;
    revokedAt: Date | null;
    replacedByJti: string | null;
    expiresAt: Date;
}

const refreshTokenSchema = new mongoose.Schema<IRefreshToken>(
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

export default mongoose.model<IRefreshToken>('RefreshToken', refreshTokenSchema);
