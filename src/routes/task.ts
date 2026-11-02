import express from 'express';
import { validateTaskCreate, validateTaskUpdate, validateTaskDelete, validateTaskGetById } from '../validators';
import { getTasks, getTaskById, createTask, updateTask, deleteTask } from '../controllers';
import { authenticate, validateRequest } from '../middlewares';

const router = express.Router();

router.use(authenticate);

router.get('/', getTasks);
router.get('/:id', validateTaskGetById, validateRequest, getTaskById);
router.post('/', validateTaskCreate, validateRequest, createTask);
router.patch('/:id', validateTaskUpdate, validateRequest, updateTask);
router.delete('/:id', validateTaskDelete, validateRequest, deleteTask);

export default router;
