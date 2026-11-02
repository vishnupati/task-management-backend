// Shared contract between services/task.ts (producer) and workers/event-consumer.ts (consumer).
export const TASK_EVENTS = {
    CREATE: 'task_create_request',
    UPDATE: 'task_update_request',
    DELETE: 'task_delete_request',
} as const;

export type TaskEventType = (typeof TASK_EVENTS)[keyof typeof TASK_EVENTS];

const TASK_EVENT_TYPES: readonly string[] = Object.values(TASK_EVENTS);

export const isTaskEventType = (value: unknown): value is TaskEventType =>
    typeof value === 'string' && TASK_EVENT_TYPES.includes(value);

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Messages arrive from outside the process (an older or newer producer, a manual replay), so the consumer checks
// the shape at runtime before using it.
export const isTaskEventMessage = (value: unknown): value is TaskEventMessage =>
    isRecord(value) &&
    typeof value.taskId === 'string' && value.taskId !== '' &&
    typeof value.userId === 'string' && value.userId !== '' &&
    typeof value.requestedAt === 'string' &&
    (value.clientTaskId === undefined || typeof value.clientTaskId === 'string') &&
    (value.data === undefined || isRecord(value.data));

export const pickMutableTaskFields =(source: Readonly<Record<string, unknown>> = {}): MutableTaskFields =>
    MUTABLE_TASK_FIELDS.reduce<MutableTaskFields>((fields, field) => {
        if (source[field] !== undefined) {
            fields[field] = source[field];
        }

        return fields;
    }, {});
