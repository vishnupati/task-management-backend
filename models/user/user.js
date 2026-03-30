const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
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

userSchema.methods.comparePassword = function comparePassword(candidatePassword) {
    if (!this.password) {
        return false;
    }

    return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);