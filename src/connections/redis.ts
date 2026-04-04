import Redis from 'ioredis';

export default class RedisConnection {
    /** General commands: cache, rate limit, publish, ping. */
    readonly ioRedis: Redis;
    /** Dedicated pub/sub subscriber (must not share connection with command traffic). */
    readonly ioRedisSub: Redis;

    private initialized = false;

    constructor(host: string, port: number) {
        this.ioRedis = new Redis({ host, port });
        this.ioRedisSub = this.ioRedis.duplicate();
    }

    async connect(): Promise<void> {
        if (this.initialized) {
            return;
        }

        await this.ioRedis.ping();
        await this.ioRedisSub.ping();

        this.initialized = true;
    }

    async disconnect(): Promise<void> {
        await this.ioRedisSub.quit();
        await this.ioRedis.quit();
    }

}
