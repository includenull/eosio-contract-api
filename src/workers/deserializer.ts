import { workerData } from 'node:worker_threads';
import { ABI } from '@wharfkit/antelope';

import logger from '../utils/logger.js';
import { deserializeEosioType } from '../utils/eosio.js';

type DeserializeRow = { type: string; data: Uint8Array | string | null; abi?: unknown };

const args = workerData as { abi: unknown };

logger.debug('Deserialization worker ready');

const shipAbi = ABI.from(args.abi as Parameters<typeof ABI.from>[0]);

export default function deserializeRows(param: DeserializeRow[]): any[] {
    const result: any[] = [];

    for (const row of param) {
        if (row.data === null) {
            throw new Error('Empty data received on deserialize worker');
        }

        if (row.abi) {
            const rowAbi = ABI.from(row.abi as Parameters<typeof ABI.from>[0]);

            result.push(deserializeEosioType(row.type, row.data, rowAbi));
        } else {
            result.push(deserializeEosioType(row.type, row.data, shipAbi));
        }
    }

    return result;
}
