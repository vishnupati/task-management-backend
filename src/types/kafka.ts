import type { EachMessagePayload, IHeaders } from 'kafkajs';

export interface PublishOptions {
    topic: string;
    event: string;
    message: unknown;
    key?: string | null;
    headers?: IHeaders;
}

// A record sent as-is, without serializing or adding headers.
export interface RecordToPublish {
    topic: string;
    key?: Buffer | string | null;
    value: Buffer | string | null;
    headers?: IHeaders;
}

// What the worker uses of a consumed record.
export type ConsumedMessage = Pick<EachMessagePayload, 'topic' | 'partition' | 'message'>;
