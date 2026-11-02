import mongoose from 'mongoose';
import { getErrorMessage } from '../utils/errors';

const connectDB = async (): Promise<void> => {
    try {
        // An unset MONGO_URI fails here as an invalid connection string.
        await mongoose.connect(process.env.MONGO_URI ?? '');
        console.log('MongoDB connected');
    } catch (error) {
        console.error('MongoDB connection error:', getErrorMessage(error));
        throw error; // Throw instead of exit
    }
};

export default connectDB;
