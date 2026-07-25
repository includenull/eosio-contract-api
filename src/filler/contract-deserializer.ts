import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { ABI } from '@wharfkit/antelope';
import Piscina from 'piscina';

import { ContractDeserializeRow, ShipSidecarPool } from '../connections/ship-sidecar-client.js';
import { deserializeEosioType } from '../utils/eosio.js';

export type ContractDeserializeRequest = {
    contract: string;
    type: string;
    data: Uint8Array | string;
    abi: ABI;
};

type WorkerRow = {
    type: string;
    data: Uint8Array | string;
    abi: ReturnType<ABI['toJSON']>;
};

const emptyShipAbi = {
    version: 'eosio::abi/1.2',
    types: [],
    structs: [],
    actions: [],
    tables: [],
    ricardian_clauses: [],
} as Parameters<typeof ABI.from>[0];

export default class ContractDeserializer {
    private piscina: Piscina | undefined;
    private readonly poolSize: number;

    constructor(
        private readonly getSidecarPool: () => ShipSidecarPool | undefined,
        contractThreads: number,
        useSidecar: boolean
    ) {
        const requested = Math.floor(Number(contractThreads));
        const cpus = availableParallelism() || 4;
        this.poolSize = Math.max(1, Math.min(requested, cpus));

        if (!useSidecar && this.poolSize > 1) {
            this.piscina = new Piscina({
                filename: fileURLToPath(new URL('../workers/deserializer.js', import.meta.url)),
                minThreads: this.poolSize,
                maxThreads: this.poolSize,
                idleTimeout: Infinity,
                workerData: { abi: emptyShipAbi },
            });
        }
    }

    async destroy(): Promise<void> {
        if (this.piscina) {
            await this.piscina.destroy();
            this.piscina = undefined;
        }
    }

    async registerAbi(contract: string, abi: ABI): Promise<void> {
        const sidecarPool = this.getSidecarPool();
        if (!sidecarPool) {
            return;
        }

        await sidecarPool.registerAbi(contract, JSON.stringify(abi.toJSON()));
    }

    async deserializeBatch(requests: ContractDeserializeRequest[]): Promise<unknown[]> {
        if (requests.length === 0) {
            return [];
        }

        const sidecarPool = this.getSidecarPool();
        if (sidecarPool) {
            return this.deserializeViaSidecar(sidecarPool, requests);
        }

        if (this.piscina) {
            return this.deserializeViaPiscina(requests);
        }

        return requests.map(request => deserializeEosioType(request.type, request.data, request.abi, false));
    }

    private async deserializeViaSidecar(
        sidecarPool: ShipSidecarPool,
        requests: ContractDeserializeRequest[]
    ): Promise<unknown[]> {
        const contracts = new Map<string, ABI>();

        for (const request of requests) {
            if (!contracts.has(request.contract)) {
                contracts.set(request.contract, request.abi);
            }
        }

        await Promise.all(
            [...contracts.entries()].map(([contract, abi]) => sidecarPool.registerAbi(contract, JSON.stringify(abi.toJSON())))
        );

        const rows: ContractDeserializeRow[] = requests.map(request => ({
            contract: request.contract,
            type: request.type,
            data: request.data,
        }));

        return sidecarPool.deserializeContractBatchOrdered(rows);
    }

    private async deserializeViaPiscina(requests: ContractDeserializeRequest[]): Promise<unknown[]> {
        const rows: WorkerRow[] = requests.map(request => ({
            type: request.type,
            data: request.data,
            abi: request.abi.toJSON(),
        }));

        if (this.poolSize <= 1 || rows.length <= 1) {
            return this.piscina!.run(rows);
        }

        const chunkSize = Math.ceil(rows.length / this.poolSize);
        const tasks: Array<Promise<unknown[]>> = [];

        for (let i = 0; i < this.poolSize; i++) {
            const chunk = rows.slice(i * chunkSize, (i + 1) * chunkSize);
            if (chunk.length === 0) {
                continue;
            }

            tasks.push(this.piscina!.run(chunk));
        }

        const chunks = await Promise.all(tasks);
        return chunks.flat();
    }
}
