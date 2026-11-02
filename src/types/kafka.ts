import type { IHeaders } from 'kafkajs';

export interface PublishOptions {
    topic: string;
    event: string;
    message: unknown;
    key?: string | null;
    headers?: IHeaders;
}
