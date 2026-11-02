import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

let io: Server | undefined;

export const initWebSocket = (server: HttpServer): Server => {
    io = new Server(server, {
        cors: {
            origin: "*", // Adjust in production
            methods: ["GET", "POST"]
        }
    });

    io.on('connection', (socket) => {
        console.log('User connected to WebSocket:', socket.id);

        // Join a room based on userId for targeted events
        socket.on('join', (userId: string) => {
            if (userId) {
                socket.join(`user:${userId}`);
                console.log(`User ${userId} joined room user:${userId}`);
            }
        });

        socket.on('disconnect', () => {
            console.log('User disconnected from WebSocket:', socket.id);
        });
    });

    return io;
};

export const getIO = (): Server => {
    if (!io) {
        throw new Error('WebSocket not initialized');
    }
    return io;
};

export const emitToUser = (userId: string, event: string, data: unknown): void => {
    const ioInstance = getIO();
    ioInstance.to(`user:${userId}`).emit(event, data);
};
