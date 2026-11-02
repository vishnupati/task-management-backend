import type { NextFunction, Request, Response } from 'express';
import { validationResult } from 'express-validator';

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        const details = errors.array();
        // `message` matches the shape of every other error response so clients can show it directly.
        return res.status(400).json({ message: details[0]?.msg, errors: details });
    }

    return next();
};
