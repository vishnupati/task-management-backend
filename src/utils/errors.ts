import type { DuplicateKeyError } from '../types';

const DUPLICATE_KEY_ERROR: DuplicateKeyError['code'] = 11000;

export const getErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

// Matched on the code alone, as MongoDB unique-index violations can surface from the driver or through mongoose.
export const isDuplicateKeyError = (error: unknown): error is DuplicateKeyError =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === DUPLICATE_KEY_ERROR;
