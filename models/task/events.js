// Shared contract between the task API (producer) and workers/event-consumer.js (consumer).
const TASK_EVENTS = {
    CREATE: 'task_create_request',
    UPDATE: 'task_update_request',
    DELETE: 'task_delete_request',
};

// Only these fields are client-writable; userId, _id and clientTaskId are always set by the server.
const MUTABLE_TASK_FIELDS = ['title', 'description', 'status'];

const pickMutableTaskFields = (source = {}) =>
    MUTABLE_TASK_FIELDS.reduce((fields, field) => {
        if (source[field] !== undefined) {
            fields[field] = source[field];
        }

        return fields;
    }, {});

module.exports = { TASK_EVENTS, MUTABLE_TASK_FIELDS, pickMutableTaskFields };
