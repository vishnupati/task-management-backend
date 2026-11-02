import mongoose, { type Types } from 'mongoose';

export interface ITask {
    userId: Types.ObjectId;
    clientTaskId?: string;
    title: string;
    description?: string;
    status: string;
}

const taskSchema = new mongoose.Schema<ITask>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    // Idempotency key for creates. The task _id is derived from it (see services/task.ts), so a
    // client retry or a Kafka redelivery of the same create collides on _id instead of duplicating.
    clientTaskId: {
        type: String,
    },
    title: {
        type: String,
        required: true,
    },
    description: String,
    status: {
        type: String,
        default: 'pending'
    },
}, { timestamps: true });

// Backs the per-user list sorted newest first, and any userId-only lookup.
taskSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model<ITask>('Task', taskSchema);
