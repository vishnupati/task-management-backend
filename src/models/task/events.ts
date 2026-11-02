// Shared contract between services/task.ts (producer) and workers/event-consumer.ts (consumer).
export const TASK_EVENTS = {
    CREATE: 'task_create_request',
    UPDATE: 'task_update_request',
    DELETE: 'task_delete_request',
} as const;

export type TaskEventType = (typeof TASK_EVENTS)[keyof typeof TASK_EVENTS];

// Only these fields are client-writable; userId, _id and clientTaskId are always set by the server.
export const MUTABLE_TASK_FIELDS = ['title', 'description', 'status'] as const;

export type MutableTaskField = (typeof MUTABLE_TASK_FIELDS)[number];

// Values are copied as-is: the API validates them before publishing, and mongoose validates them on write.
export type MutableTaskFields = Partial<Record<MutableTaskField, unknown>>;

// Value of a message on the task-events topic.
export interface TaskEventMessage {
    taskId: string;
    userId: string;
    requestedAt: string;
    clientTaskId?: string;
    data?: MutableTaskFields;
}

export const pickMutableTaskFields = (source: Readonly<Record<string, unknown>> = {}): MutableTaskFields =>
    MUTABLE_TASK_FIELDS.reduce<MutableTaskFields>((fields, field) => {
        if (source[field] !== undefined) {
            fields[field] = source[field];
        }

        return fields;
    }, {});
