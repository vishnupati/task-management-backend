const { Server } = require('socket.io');

let io;

const initWebSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: "*", // Adjust in production
            methods: ["GET", "POST"]
        }
    });

    io.on('connection', (socket) => {
        console.log('User connected to WebSocket:', socket.id);

        // Join a room based on userId for targeted events
        socket.on('join', (userId) => {
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

const getIO = () => {
    if (!io) {
        throw new Error('WebSocket not initialized');
    }
    return io;
};

const emitToUser = (userId, event, data) => {
    const ioInstance = getIO();
    ioInstance.to(`user:${userId}`).emit(event, data);
};

module.exports = {
    initWebSocket,
    getIO,
    emitToUser
};
