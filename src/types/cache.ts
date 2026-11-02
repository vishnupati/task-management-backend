export interface CacheKey {
    key: string;
    versionKey: string;
}

export type CacheStatus = 'HIT' | 'MISS' | 'BYPASS';

export interface ReadThroughOptions<T> extends CacheKey {
    load: () => PromiseLike<T>;
    ttlSeconds?: number;
}

export interface ReadThroughResult {
    body: string | null;
    status: CacheStatus;
}
