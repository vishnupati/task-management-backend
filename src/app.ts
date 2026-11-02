import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import taskRoutes from './routes/task';
import authRoutes from './routes/auth';

// The Express app only: it doesn't listen or connect to anything, so tests can import it.
// Connections, listening and shutdown live in server.ts.
const app = express();

// Credentialed CORS must be an allowlist: reflecting every origin lets any website read
// authenticated responses using the visitor's cookies.
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));
app.use('/api/auth', authRoutes);
app.use('/api/tasks', taskRoutes);
app.get('/', (req, res) => {
    res.send('Hello World');
});

export default app;
