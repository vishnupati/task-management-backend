const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    title: String,
    description: String,
    status: {
        type: String,
        default: 'pending'
    },
}, { timestamps: true });

module.exports = mongoose.model('Task', taskSchema);

