import { Router } from 'express';
import authRoutes from './auth';
import taskRoutes from './task';

// Every API route; app.ts mounts this under /api.
const router = Router();

// Auth APIs: /api/auth/...
router.use('/auth', authRoutes);

// Task APIs: /api/tasks/...
router.use('/tasks', taskRoutes);

router.get('/', (req, res) => {
    res.send('Hello World');
});

export default router;
