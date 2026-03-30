const { body, param } = require('express-validator');

const validateTaskCreate = [
    body('title').notEmpty().withMessage('Title is required'),
    body('description').notEmpty().withMessage('Description is required'),
    body('status').optional().notEmpty().withMessage('Status cannot be empty'),
];

const validateTaskUpdate = [
    param('id').isMongoId().withMessage('Valid id is required'),
    body('title').optional().notEmpty().withMessage('Title is required'),
    body('description').optional().notEmpty().withMessage('Description is required'),
    body('status').optional().notEmpty().withMessage('Status is required'),
];

const validateTaskDelete = [
    param('id').isMongoId().withMessage('Valid id is required'),
];

const validateTaskGetById = [
    param('id').isMongoId().withMessage('Valid id is required'),
];

module.exports = { validateTaskCreate, validateTaskUpdate, validateTaskDelete, validateTaskGetById };