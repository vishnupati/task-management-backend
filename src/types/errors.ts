// A MongoDB unique-index violation.
export interface DuplicateKeyError {
    code: 11000;
    keyPattern?: Record<string, unknown>;
}
