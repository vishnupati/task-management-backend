const { body, param } = require('express-validator');

const validateTaskCreate = [
    body('title').notEmpty().withMessage('Title is required'),
    body('description').notEmpty().withMessage('Description is required'),
    body('status').notEmpty().withMessage('Status is required'),
];

const validateTaskUpdate = [
    param('id').notEmpty().withMessage('Id is required'),
    body('title').optional().notEmpty().withMessage('Title is required'),
    body('description').optional().notEmpty().withMessage('Description is required'),
    body('status').optional().notEmpty().withMessage('Status is required'),
    ];

const validateTaskDelete = [
    param('id').notEmpty().withMessage('Id is required'),
];

const validateTaskGetById = [
    param('id').notEmpty().withMessage('Id is required'),
];

module.exports = { validateTaskCreate, validateTaskUpdate , validateTaskDelete, validateTaskGetById };