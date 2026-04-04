import DataProcessor, { ProcessingState } from './processor.js';
import { ShipBlock } from '../types/ship.js';
import { EosioActionTrace, EosioContractRow, EosioTransaction } from '../types/eosio.js';
import ConnectionManager from '../connections/manager.js';
import logger from '../utils/winston.js';
import { arrayChunk } from '../utils/index.js';

export type NotificationData = {
    channel: string,
    type: 'trace' | 'delta' | 'fork',
    data: {block: ShipBlock, tx?: EosioTransaction, trace?: EosioActionTrace, delta?: EosioContractRow}
};

function prepareNotificationBlock(block: ShipBlock): any {
    const result = {};
    const whitelist = ['block_id', 'block_num', 'timestamp', 'producer'];

    for (const key of whitelist) {
        // @ts-ignore
        result[key] = block[key];
    }

    return result;
}

export default class ApiNotificationSender {
    channelName: string;
    notifications: Array<NotificationData>;

    constructor(private readonly connection: ConnectionManager, private readonly processor: DataProcessor, private readonly readerName: string) {
        this.channelName = ['eosio-contract-api', this.connection.chain.name, this.readerName, 'api'].join(':');
        this.notifications = [];
    }

    sendActionTrace(channel: string, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<any>): void {
        this.notifications.push({channel, type: 'trace', data: {block: prepareNotificationBlock(block), tx, trace}});
    }

    sendContractRow(channel: string, block: ShipBlock, delta: EosioContractRow): void {
        this.notifications.push({channel, type: 'delta', data: {block: prepareNotificationBlock(block), delta}});
    }

    sendFork(block: ShipBlock): void {
        this.notifications.push({channel: null, type: 'fork', data: {block: prepareNotificationBlock(block)}});
    }

    async publish(): Promise<void> {
        if (this.notifications.length === 0) {
            return;
        }

        if (this.processor.getState() === ProcessingState.HEAD) {
            try {
                const chunks = arrayChunk(this.notifications, 50);

                for (const chunk of chunks) {
                    await this.connection.redis.ioRedis.publish(this.channelName, JSON.stringify(chunk));
                }
            } catch (e) {
                logger.warn('Failed to send API notifications', e);
            }
        }

        this.notifications = [];
    }
}
