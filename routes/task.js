const express = require('express');
const router = express.Router();
const { validateTaskCreate, validateTaskUpdate , validateTaskDelete, validateTaskGetById } = require('../models/task/validator');
const { getTasks, getTaskById, createTask, updateTask, deleteTask } = require('../controllers/task');

router.get('/', getTasks);
router.get('/:id', validateTaskGetById, getTaskById);
router.post('/', validateTaskCreate, createTask);
router.patch('/:id', validateTaskUpdate, updateTask);
router.delete('/:id', validateTaskDelete, deleteTask);

module.exports = router;    