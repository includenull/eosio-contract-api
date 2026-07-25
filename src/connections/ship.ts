import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import Piscina from 'piscina';
import PQueue from 'p-queue';
import { ABI } from '@wharfkit/antelope';
import WebSocket from 'ws';

import logger from '../utils/logger.js';
import {
    BlockRequestType,
    IBlockReaderOptions, ShipBlockResponse
} from '../types/ship.js';
import { deserializeEosioType, serializeEosioType } from '../utils/eosio.js';
import { parseShipBlocksResult } from '../utils/ship-envelope.js';
import { createShipSidecarPool, ShipSidecarPool } from './ship-sidecar-client.js';
import { ShipSidecarFilterRules } from '../utils/ship-filter.js';

export type BlockConsumer = (block: ShipBlockResponse) => any;

type PendingSidecarBlocksResult = {
    type: string;
    response: {
        head: any;
        last_irreversible: any;
        this_block?: any;
        prev_block?: any;
    };
    version: number;
    preprocessed: { block: any; traces: any[]; deltas: any[] };
};

export default class StateHistoryBlockReader {
    currentArgs: BlockRequestType;
    deltaWhitelist: string[];

    shipAbi: ABI | null;
    tables: Map<string, string>;

    blocksQueue: PQueue;

    private ws: any;

    private connected: boolean;
    private connecting: boolean;
    private stopped: boolean;

    private deserializeWorkers: Piscina | undefined;
    private sidecarPool: ShipSidecarPool | undefined;
    private sidecarFilterRules: ShipSidecarFilterRules | undefined;
    private nextSidecarBlockNum: number | null = null;
    private pendingSidecarResults = new Map<number, PendingSidecarBlocksResult>();

    private unconfirmed: number;
    private consumer: BlockConsumer;

    constructor(
        private readonly endpoint: string,
        private options: IBlockReaderOptions = {min_block_confirmation: 1, ds_threads: 4, allow_empty_deltas: false, allow_empty_traces: false, allow_empty_blocks: false}
    ) {
        this.connected = false;
        this.connecting = false;
        this.stopped = true;

        this.blocksQueue = new PQueue({concurrency: 1, autoStart: true});
        this.deserializeWorkers = undefined;

        this.consumer = null;

        this.shipAbi = null;
        this.tables = new Map();

        this.deltaWhitelist = [];
    }

    setOptions(options?: Partial<IBlockReaderOptions>, deltas?: string[]): void {
        if (options) {
            this.options = {...this.options, ...options};
        }

        if (deltas) {
            this.deltaWhitelist = deltas;
        }
    }

    connect(): void {
        if (!this.connected && !this.connecting && !this.stopped) {
            logger.info(`Connecting to ship endpoint ${this.endpoint}`);
            logger.info(`Ship connect options ${JSON.stringify({...this.currentArgs, have_positions: 'removed'})}`);

            this.connecting = true;

            this.ws = new WebSocket(this.endpoint, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 * 1024 });

            this.ws.on('open', () => this.onConnect());
            this.ws.on('message', (data: any) => this.onMessage(data));
            this.ws.on('close', () => this.onClose());
            this.ws.on('error', (e: Error) => { logger.error('Websocket error', e); });
        }
    }

    reconnect(): void {
        if (this.stopped) {
            return;
        }

        setTimeout(() => {
            logger.info('Reconnecting to Ship...');

            this.connect();
        }, 5000);
    }

    send(request: [string, any]): void {
        this.ws.send(serializeEosioType('request', request, this.shipAbi!));
    }

    setMinBlockConfirmation(minBlockConfirmation: number): void {
        this.options.min_block_confirmation = Math.max(1, minBlockConfirmation);
    }

    setSidecarFilterRules(rules: ShipSidecarFilterRules): void {
        this.sidecarFilterRules = rules;
        logger.info(
            'Ship sidecar filters: ' + rules.traceFilters.length + ' trace rules, ' +
            rules.tableFilters.length + ' table rules'
        );

        void this.applySidecarFilters().catch((error) => {
            logger.error('Failed to apply ship sidecar filters', error);
            this.ws?.close();
        });
    }

    private async applySidecarFilters(): Promise<void> {
        if (!this.sidecarPool || !this.sidecarFilterRules) {
            return;
        }

        await this.sidecarPool.setFilters(this.sidecarFilterRules);
    }

    onConnect(): void {
        this.connected = true;
        this.connecting = false;
    }

    onMessage(data: any): void {
        try {
            if (!this.shipAbi) {
                void this.initializeShipConnection(data).catch((error) => {
                    logger.error('Failed to initialize ship deserializer', error);
                    this.ws.close();
                });
                return;
            }

            this.handleShipResult(data);
        } catch (e) {
            logger.error(e);

            this.ws.close();
        }
    }

    private async initializeShipConnection(data: any): Promise<void> {
        logger.info('Receiving ABI from ship...');

        this.shipAbi = ABI.from(JSON.parse(data));

        if (this.options.ds_use_sidecar) {
            const requested = Math.floor(Number(this.options.ds_threads));
            const cpus = availableParallelism() || 4;
            const poolSize = Math.max(1, Math.min(requested, cpus));

            this.sidecarPool = await createShipSidecarPool(
                poolSize,
                this.options.ds_sidecar_path
            );

            await this.applySidecarFilters();

            if (poolSize !== requested) {
                logger.warn(
                    `Sidecar thread count capped to ${poolSize} (${requested} requested, ${cpus} CPUs available)`
                );
            }
        } else if (this.options.ds_threads > 0) {
            const requested = Math.floor(Number(this.options.ds_threads));
            const cpus = availableParallelism() || 4;
            const poolSize = Math.max(1, Math.min(requested, cpus));

            this.deserializeWorkers = new Piscina({
                filename: fileURLToPath(new URL('../workers/deserializer.js', import.meta.url)),
                minThreads: poolSize,
                maxThreads: poolSize,
                idleTimeout: Infinity,
                workerData: { abi: this.shipAbi.toJSON() }
            });

            if (poolSize !== requested) {
                logger.warn(
                    `Deserialize pool capped to ${poolSize} workers (${requested} requested, ${cpus} CPUs available)`
                );
            } else {
                logger.info(`Deserialize worker pool: ${poolSize} threads`);
            }
        }

        for (const table of this.shipAbi.tables) {
            this.tables.set(String(table.name), table.type);
        }

        if (!this.stopped) {
            this.requestBlocks();
        }
    }

    private handleShipResult(data: any): void {
        try {
                if (this.sidecarPool) {
                    this.handleShipResultViaSidecar(data);
                    return;
                }

                const [type, response] = deserializeEosioType('result', data, this.shipAbi);

                this.enqueueBlocksResult(type, response);
        } catch (e) {
            logger.error(e);

            this.ws.close();
        }
    }

    private handleShipResultViaSidecar(data: Uint8Array | Buffer): void {
        void this.processShipResultViaSidecar(data).catch((error) => {
            logger.error('Failed to process ship result via sidecar', error);
            this.ws.close();
        });
    }

    private resetSidecarOrdering(startBlockNum: number): void {
        this.nextSidecarBlockNum = startBlockNum;
        this.pendingSidecarResults.clear();
    }

    private stageSidecarBlocksResult(blockNum: number, payload: PendingSidecarBlocksResult): void {
        if (this.nextSidecarBlockNum === null) {
            this.nextSidecarBlockNum = blockNum;
        }

        if (blockNum < this.nextSidecarBlockNum) {
            this.pendingSidecarResults.clear();
            this.nextSidecarBlockNum = blockNum;
        }

        this.pendingSidecarResults.set(blockNum, payload);
        this.flushSidecarBlocksResults();
    }

    private flushSidecarBlocksResults(): void {
        if (this.nextSidecarBlockNum === null) {
            return;
        }

        while (this.pendingSidecarResults.has(this.nextSidecarBlockNum)) {
            const payload = this.pendingSidecarResults.get(this.nextSidecarBlockNum)!;
            this.pendingSidecarResults.delete(this.nextSidecarBlockNum);
            this.enqueueBlocksResult(payload.type, payload.response, payload.version, payload.preprocessed);
            this.nextSidecarBlockNum += 1;
        }
    }

    private async processShipResultViaSidecar(data: Uint8Array | Buffer): Promise<void> {
        if (!this.sidecarPool || !this.sidecarFilterRules) {
            throw new Error('Sidecar filter rules are not configured');
        }

        const parsed = parseShipBlocksResult(data, this.shipAbi!);
        if (!parsed) {
            const [type, response] = deserializeEosioType('result', data, this.shipAbi!);
            logger.warn('Not supported message received', { type, response });
            return;
        }

        const result = await this.sidecarPool.processShipMessage({
            resultType: parsed.resultType,
            version: parsed.version,
            head: parsed.head,
            last_irreversible: parsed.last_irreversible,
            this_block: parsed.this_block,
            prev_block: parsed.prev_block,
            block: parsed.block,
            traces: parsed.traces,
            deltas: parsed.deltas,
        });

        const payload: PendingSidecarBlocksResult = {
            type: result.result_type,
            response: {
                head: result.head,
                last_irreversible: result.last_irreversible,
                this_block: result.this_block ?? undefined,
                prev_block: result.prev_block ?? undefined,
            },
            version: result.version,
            preprocessed: {
                block: this.extractBlockPayload(result.block, result.version),
                traces: result.traces ?? [],
                deltas: result.deltas ?? [],
            },
        };

        const blockNum = parsed.this_block?.block_num ?? result.this_block?.block_num;
        if (blockNum === undefined) {
            this.enqueueBlocksResult(payload.type, payload.response, payload.version, payload.preprocessed);
            return;
        }

        this.stageSidecarBlocksResult(blockNum, payload);
    }

    private extractBlockPayload(block: unknown, resultVersion: number): any {
        if (!block) {
            return null;
        }

        if (resultVersion === 0) {
            return block;
        }

        if (Array.isArray(block) && block[0] === 'signed_block_v1') {
            return block[1];
        }

        throw new Error('Unsupported block type received ' + String(Array.isArray(block) ? block[0] : typeof block));
    }

    private enqueueBlocksResult(
        type: string,
        response: any,
        resultVersion?: number,
        preprocessed?: { block: any; traces: any[]; deltas: any[] }
    ): void {
        if (['get_blocks_result_v0', 'get_blocks_result_v1', 'get_blocks_result_v2'].indexOf(type) < 0) {
            logger.warn('Not supported message received', { type, response });
            return;
        }

        const config: { [key: string]: { version: number } } = {
            get_blocks_result_v0: { version: 0 },
            get_blocks_result_v1: { version: 1 },
            get_blocks_result_v2: { version: 2 },
        };

        const version = resultVersion ?? config[type].version;

        let block: any = null;
        let traces: any = [];
        let deltas: any = [];

        if (response.this_block) {
            if (preprocessed) {
                block = Promise.resolve(preprocessed.block);
                traces = Promise.resolve(preprocessed.traces);
                deltas = Promise.resolve(preprocessed.deltas);
            } else if (this.sidecarPool) {
                const sidecarResult = this.deserializeBlockViaSidecar(type, version, response);
                block = sidecarResult.then(result => result.block);
                traces = sidecarResult.then(result => result.traces);
                deltas = sidecarResult.then(result => result.deltas);
            } else if (response.block) {
                if (version === 2) {
                    block = this.deserializeParallel('signed_block_variant', response.block)
                        .then((res: any) => {
                            if (res[0] === 'signed_block_v1') {
                                return res[1];
                            }

                            throw new Error('Unsupported block type received ' + res[0]);
                        });
                } else if (version === 1) {
                    if (response.block[0] === 'signed_block_v1') {
                        block = response.block[1];
                    } else {
                        block = Promise.reject(new Error('Unsupported block type received ' + response.block[0]));
                    }
                } else if (version === 0) {
                    block = this.deserializeParallel('signed_block', response.block);
                } else {
                    block = Promise.reject(new Error('Unsupported result type received ' + type));
                }
            } else if (this.currentArgs.fetch_block) {
                if (this.options.allow_empty_blocks) {
                    logger.warn('Block #' + response.this_block.block_num + ' does not contain block data');
                } else {
                    logger.error('Block #' + response.this_block.block_num + ' does not contain block data');
                    this.blocksQueue.pause();
                    return;
                }
            }

            if (!this.sidecarPool && response.traces) {
                traces = this.deserializeParallel('transaction_trace[]', response.traces);
            } else if (!this.sidecarPool && this.currentArgs.fetch_traces) {
                if (this.options.allow_empty_traces) {
                    logger.warn('Block #' + response.this_block.block_num + ' does not contain trace data');
                } else {
                    logger.error('Block #' + response.this_block.block_num + ' does not contain trace data');
                    this.blocksQueue.pause();
                    return;
                }
            }

            if (!this.sidecarPool && response.deltas) {
                deltas = this.deserializeParallel('table_delta[]', response.deltas)
                    .then(res => this.deserializeDeltas(res));
            } else if (!this.sidecarPool && this.currentArgs.fetch_deltas) {
                if (this.options.allow_empty_deltas) {
                    logger.warn('Block #' + response.this_block.block_num + ' does not contain delta data');
                } else {
                    logger.error('Block #' + response.this_block.block_num + ' does not contain delta data');
                    this.blocksQueue.pause();
                    return;
                }
            }
        }

        this.blocksQueue.add(async () => {
            if (response.this_block) {
                this.currentArgs.start_block_num = response.this_block.block_num + 1;
            } else {
                this.currentArgs.start_block_num += 1;
            }

            if (response.this_block && response.last_irreversible) {
                this.currentArgs.have_positions = this.currentArgs.have_positions.filter(
                    row => row.block_num > response.last_irreversible.block_num && row.block_num < response.this_block.block_num
                );

                if (response.this_block.block_num > response.last_irreversible.block_num) {
                    this.currentArgs.have_positions.push(response.this_block);
                }
            }

            let deserializedTraces = [];
            let deserializedDeltas = [];

            try {
                deserializedTraces = await traces;
            } catch (error) {
                logger.error('Failed to deserialize traces at block #' + response.this_block.block_num, error);

                this.blocksQueue.clear();
                this.blocksQueue.pause();

                throw error;
            }

            try {
                deserializedDeltas = await deltas;
            } catch (error) {
                logger.error('Failed to deserialize deltas at block #' + response.this_block.block_num, error);

                this.blocksQueue.clear();
                this.blocksQueue.pause();

                throw error;
            }

            try {
                await this.processBlock({
                    this_block: response.this_block,
                    head: response.head,
                    last_irreversible: response.last_irreversible,
                    prev_block: response.prev_block,
                    block: Object.assign(
                        { ...response.this_block },
                        await block,
                        { last_irreversible: response.last_irreversible },
                        { head: response.head }
                    ),
                    traces: deserializedTraces,
                    deltas: deserializedDeltas,
                });
            } catch (error) {
                logger.error('Ship blocks queue stopped due to an error at #' + response.this_block.block_num, error);

                this.blocksQueue.clear();
                this.blocksQueue.pause();

                throw error;
            }

            this.unconfirmed += 1;

            if (this.unconfirmed >= this.options.min_block_confirmation) {
                this.send(['get_blocks_ack_request_v0', { num_messages: this.unconfirmed }]);
                this.unconfirmed = 0;
            }
        }).then();
    }

    async onClose(): Promise<void> {
        logger.error('Ship Websocket disconnected');

        if (this.ws) {
            await this.ws.terminate();
            this.ws = null;
        }

        this.shipAbi = null;
        this.tables = new Map();

        this.connected = false;
        this.connecting = false;

        this.nextSidecarBlockNum = null;
        this.pendingSidecarResults.clear();
        this.blocksQueue.clear();

        if (this.deserializeWorkers) {
            await this.deserializeWorkers.destroy();
            this.deserializeWorkers = undefined;
        }

        if (this.sidecarPool) {
            await this.sidecarPool.stop();
            this.sidecarPool = undefined;
        }

        this.reconnect();
    }

    requestBlocks(): void {
        this.unconfirmed = 0;

        this.send(['get_blocks_request_v0', this.currentArgs]);
    }

    startProcessing(request: BlockRequestType = {}, deltas: string[] = []): void {
        this.currentArgs = {
            start_block_num: 0,
            end_block_num: 0xffffffff,
            max_messages_in_flight: 1,
            have_positions: [],
            irreversible_only: false,
            fetch_block: false,
            fetch_traces: false,
            fetch_deltas: false,
            ...request
        };
        this.deltaWhitelist = deltas;
        this.stopped = false;
        this.resetSidecarOrdering(this.currentArgs.start_block_num);

        if (this.connected && this.shipAbi) {
            this.requestBlocks();
        }

        this.blocksQueue.start();

        this.connect();
    }

    stopProcessing(): void {
        this.stopped = true;

        this.ws.close();

        this.blocksQueue.clear();
        this.blocksQueue.pause();
    }

    async processBlock(block: ShipBlockResponse): Promise<void> {
        if (!block.this_block) {
            if (this.currentArgs.start_block_num >= this.currentArgs.end_block_num) {
                logger.warn(
                    'Empty block #' + this.currentArgs.start_block_num + ' received. Reader finished reading.'
                );
            } else if (this.currentArgs.start_block_num % 10000 === 0) {
                logger.warn(
                    'Empty block #' + this.currentArgs.start_block_num + ' received. ' +
                    'Node was likely started with a snapshot and you tried to process a block range ' +
                    'before the snapshot. Catching up until init block.'
                );
            }

            return;
        }

        if (this.consumer) {
            await this.consumer(block);
        }

        return;
    }

    consume(consumer: BlockConsumer): void {
        this.consumer = consumer;
    }

    getSidecarPool(): ShipSidecarPool | undefined {
        return this.sidecarPool;
    }

    private async deserializeBlockViaSidecar(
        _resultType: string,
        resultVersion: number,
        response: any
    ): Promise<{ block: any; traces: any[]; deltas: any[] }> {
        let blockType = '';
        let blockData: Uint8Array | undefined;

        if (response.block) {
            if (resultVersion === 2 || resultVersion === 1) {
                blockType = 'signed_block_variant';
                blockData = response.block instanceof Uint8Array
                    ? response.block
                    : undefined;
            } else if (resultVersion === 0) {
                blockType = 'signed_block';
                blockData = response.block instanceof Uint8Array
                    ? response.block
                    : undefined;
            }
        } else if (this.currentArgs.fetch_block && !this.options.allow_empty_blocks) {
            throw new Error('Block #' + response.this_block.block_num + ' does not contain block data');
        }

        if (this.currentArgs.fetch_traces && !response.traces && !this.options.allow_empty_traces) {
            throw new Error('Block #' + response.this_block.block_num + ' does not contain trace data');
        }

        if (this.currentArgs.fetch_deltas && !response.deltas && !this.options.allow_empty_deltas) {
            throw new Error('Block #' + response.this_block.block_num + ' does not contain delta data');
        }

        const sidecarResult = await this.sidecarPool!.deserializeBlock({
            blockType: blockType || undefined,
            block: blockData,
            traces: response.traces,
            deltas: response.deltas,
            deltaWhitelist: this.deltaWhitelist,
        });

        let block: any = null;

        if (sidecarResult.block) {
            if (blockType === 'signed_block_variant') {
                const variantBlock = sidecarResult.block as [string, any];
                if (variantBlock[0] === 'signed_block_v1') {
                    block = variantBlock[1];
                } else {
                    throw new Error('Unsupported block type received ' + variantBlock[0]);
                }
            } else {
                block = sidecarResult.block;
            }
        } else if (resultVersion === 1 && Array.isArray(response.block) && response.block[0] === 'signed_block_v1') {
            block = response.block[1];
        }

        const traces = (sidecarResult.traces ?? []) as any[];
        const deltas = sidecarResult.deltas_processed
            ? ((sidecarResult.deltas ?? []) as any[])
            : sidecarResult.deltas
                ? await this.deserializeDeltas(sidecarResult.deltas as any[])
                : [];

        return { block, traces, deltas };
    }

    private async deserializeParallel(type: string, data: Uint8Array): Promise<any> {
        if (this.sidecarPool) {
            return this.sidecarPool.deserialize(type, data);
        }

        if (this.options.ds_threads > 0) {
            const pool = this.deserializeWorkers;
            if (!pool) {
                throw new Error('Piscina deserialize pool not initialized');
            }

            const batch = await pool.run([{type, data}]);

            return batch[0];
        }

        return deserializeEosioType(type, data, this.shipAbi!);
    }

    private async deserializeArrayParallel(rows: Array<{type: string, data: Uint8Array}>): Promise<any> {
        if (this.sidecarPool) {
            return this.sidecarPool.deserializeBatch(rows);
        }

        if (this.options.ds_threads > 0) {
            const pool = this.deserializeWorkers;
            if (!pool) {
                throw new Error('Piscina deserialize pool not initialized');
            }

            return await pool.run(rows);
        }

        return rows.map(row => deserializeEosioType(row.type, row.data, this.shipAbi!));
    }

    private async deserializeDeltas(deltas: any[]): Promise<any> {
        return await Promise.all(deltas.map(async (delta: any) => {
            if (delta[0] === 'table_delta_v0' || delta[0] === 'table_delta_v1') {
                if (this.deltaWhitelist.indexOf(delta[1].name) >= 0) {
                    const deserialized = await this.deserializeArrayParallel(delta[1].rows.map((row: any) => ({
                        type: delta[1].name, data: row.data
                    })));

                    return [
                        delta[0],
                        {
                            ...delta[1],
                            rows: delta[1].rows.map((row: any, index: number) => ({
                                present: !!row.present, data: deserialized[index]
                            }))
                        }
                    ];
                }

                return delta;
            }

            throw Error('Unsupported table delta type received ' + delta[0]);
        }));
    }
}
