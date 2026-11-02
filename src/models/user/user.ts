import mongoose, { type Model } from 'mongoose';
import bcrypt from 'bcryptjs';

// A login method linked to the account, e.g. { provider: 'google', providerId: '<Google user id>' }.
export interface IUserIdentity {
    provider: string;
    providerId: string;
}

export interface IUser {
    name: string;
    email: string;
    password?: string;
    // Provider of the latest SSO login ('local' until there is one), as shown to clients.
    authProvider: string;
    // Legacy: before identities, only the latest provider's id was kept here. Still read so those accounts are
    // recognized on their next login; no longer written.
    providerId: string | null;
    identities: IUserIdentity[];
}

interface IUserMethods {
    comparePassword(candidatePassword: string): Promise<boolean>;
}

type UserModel = Model<IUser, {}, IUserMethods>;

const identitySchema = new mongoose.Schema<IUserIdentity>(
    {
        provider: { type: String, required: true },
        providerId: { type: String, required: true },
    },
    { _id: false }
);

const userSchema = new mongoose.Schema<IUser, UserModel, IUserMethods>(
    {
        name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: {
            type: String,
            select: false,
        },
        authProvider: {
            type: String,
            default: 'local',
            trim: true,
            lowercase: true,
        },
        providerId: {
            type: String,
            default: null,
        },
        identities: {
            type: [identitySchema],
            default: [],
        },
    },
    { timestamps: true }
);

// A provider identity belongs to one account at most. Partial, because accounts without identities (password-only,
// or not logged in since identities were added) would otherwise all collide on the missing value.
userSchema.index(
    { 'identities.provider': 1, 'identities.providerId': 1 },
    { unique: true, partialFilterExpression: { 'identities.provider': { $exists: true } } }
);

userSchema.pre('save', async function onSave(next) {
    if (!this.isModified('password') || !this.password) {
        return next();
    }

    this.password = await bcrypt.hash(this.password, 10);
    return next();
});

userSchema.method('comparePassword', async function comparePassword(candidatePassword: string): Promise<boolean> {
    if (!this.password) {
        return false;
    }

    return bcrypt.compare(candidatePassword, this.password);
});

export default mongoose.model<IUser, UserModel>('User', userSchema);
