import { workerData } from 'node:worker_threads';
import { Serialize } from 'eosjs';

import logger from '../utils/winston.js';
import { deserializeEosioType } from '../utils/eosio.js';

type DeserializeRow = { type: string; data: Uint8Array | string | null; abi?: any };

const args = workerData as { abi: any };

logger.info('Launching deserialization worker...');

const eosjsTypes: any = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), args.abi);

export default function deserializeRows(param: DeserializeRow[]): any[] {
    const result: any[] = [];

    for (const row of param) {
        if (row.data === null) {
            throw new Error('Empty data received on deserialize worker');
        }

        if (row.abi) {
            const abiTypes = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), row.abi);

            result.push(deserializeEosioType(row.type, row.data, abiTypes));
        } else {
            result.push(deserializeEosioType(row.type, row.data, eosjsTypes));
        }
    }

    return result;
}
