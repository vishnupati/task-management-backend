import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import routes from './routes';

// The Express app only: it doesn't listen or connect to anything, so tests can import it.
// Connections, listening and shutdown live in server.ts.
const app = express();

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Credentialed CORS must be an allowlist: reflecting every origin lets any website read
// authenticated responses using the visitor's cookies.
app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
}));
app.use('/api', routes);

export default app;
