const express = require('express');
const router = express.Router();
const { validateTaskCreate, validateTaskUpdate, validateTaskDelete, validateTaskGetById } = require('../models/task/validator');
const { getTasks, getTaskById, createTask, updateTask, deleteTask } = require('../controllers/task');
const { authenticate } = require('../middlewares/auth');
const { validateRequest } = require('../middlewares/validate-request');

router.use(authenticate);

router.get('/', getTasks);
router.get('/:id', validateTaskGetById, validateRequest, getTaskById);
router.post('/', validateTaskCreate, validateRequest, createTask);
router.patch('/:id', validateTaskUpdate, validateRequest, updateTask);
router.delete('/:id', validateTaskDelete, validateRequest, deleteTask);

module.exports = router;    