import { body, param } from 'express-validator';
import { MUTABLE_TASK_FIELDS } from './events';

export const validateTaskCreate = [
    body('title').isString().withMessage('Title must be a string').bail().notEmpty().withMessage('Title is required'),
    body('description').optional().isString().withMessage('Description must be a string'),
    body('status').optional().isString().withMessage('Status must be a string').bail().notEmpty().withMessage('Status cannot be empty'),
    body('clientTaskId')
        .optional()
        .isString()
        .isLength({ min: 1, max: 128 })
        .withMessage('clientTaskId must be a string of 1-128 characters'),
];

export const validateTaskUpdate = [
    param('id').isMongoId().withMessage('Valid id is required'),
    body('title').optional().isString().withMessage('Title must be a string').bail().notEmpty().withMessage('Title is required'),
    body('description').optional().isString().withMessage('Description must be a string').bail().notEmpty().withMessage('Description is required'),
    body('status').optional().isString().withMessage('Status must be a string').bail().notEmpty().withMessage('Status is required'),
    body().custom((value) => {
        if (value && MUTABLE_TASK_FIELDS.some((field) => value[field] !== undefined)) {
            return true;
        }

        throw new Error(`At least one of ${MUTABLE_TASK_FIELDS.join(', ')} is required`);
    }),
];

export const validateTaskDelete = [
    param('id').isMongoId().withMessage('Valid id is required'),
];

export const validateTaskGetById = [
    param('id').isMongoId().withMessage('Valid id is required'),
];
