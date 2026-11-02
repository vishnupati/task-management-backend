import mongoose, { type Model } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser {
    name: string;
    email: string;
    password?: string;
    authProvider: string;
    providerId: string | null;
}

interface IUserMethods {
    comparePassword(candidatePassword: string): Promise<boolean>;
}

type UserModel = Model<IUser, {}, IUserMethods>;

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
    },
    { timestamps: true }
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
