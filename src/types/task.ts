export interface QueuedTaskCreate {
    taskId: string;
    clientTaskId: string;
    eventId: string;
}

// Route params of /api/tasks/:id.
export type TaskIdParams = { id: string };
