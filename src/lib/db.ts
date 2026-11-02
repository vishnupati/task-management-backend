import mongoose from 'mongoose';
import { config } from '../config';
import { getErrorMessage } from '../utils';

const connectDB = async (): Promise<void> => {
    try {
        await mongoose.connect(config.mongo.uri);
        console.log('MongoDB connected');
    } catch (error) {
        console.error('MongoDB connection error:', getErrorMessage(error));
        throw error; // Throw instead of exit
    }
};

export default connectDB;
