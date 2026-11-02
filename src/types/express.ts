import type { AuthUser } from './auth';

declare global {
    namespace Express {
        interface Request {
            // Set by the authenticate middleware (middlewares/auth.ts).
            user?: AuthUser;
        }
    }
}
