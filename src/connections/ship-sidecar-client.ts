import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode } from '@msgpack/msgpack';

import logger from '../utils/logger.js';

const MAGIC = 0x48504953;
const VERSION = 2;

const OP_PING = 0;
const OP_DESERIALIZE = 1;
const OP_DESERIALIZE_BATCH = 2;
const OP_DESERIALIZE_BLOCK = 3;
const OP_SET_ABI = 4;
const OP_DESERIALIZE_CONTRACT_BATCH = 5;
const OP_PROCESS_SHIP_MESSAGE = 6;
const OP_SET_FILTERS = 7;
const OP_SET_SHIP_ABI = 8;
const OP_SHUTDOWN = 255;

const FORMAT_TEXT = 0;
const FORMAT_MSGPACK = 1;

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
};

export type ContractDeserializeRow = {
    contract: string;
    type: string;
    data: Uint8Array | string;
};

export type ShipBlockDeserializeRequest = {
    blockType?: string;
    block?: Uint8Array | string;
    traces?: Uint8Array | string;
    deltas?: Uint8Array | string;
    deltaWhitelist?: string[];
};

export type ShipBlockDeserializeResponse = {
    block: unknown | null;
    traces: unknown[] | null;
    deltas: unknown[] | null;
    deltas_processed?: boolean;
};

export type ShipTraceFilter = {
    contract: string;
    action: string;
};

export type ShipTableFilter = {
    code: string;
    table: string;
};

export type ShipSidecarFilters = {
    deltaTypes: string[];
    traceFilters: ShipTraceFilter[];
    tableFilters: ShipTableFilter[];
};

export type ShipProcessMessageRequest = {
    shipBytes: Uint8Array | Buffer;
};

export type ShipProcessMessageResponse = ShipBlockDeserializeResponse & {
    result_type: string;
    version: number;
    head: { block_num: number; block_id: string };
    last_irreversible: { block_num: number; block_id: string };
    this_block?: { block_num: number; block_id: string } | null;
    prev_block?: { block_num: number; block_id: string } | null;
};

export function resolveDefaultSidecarPath(): string {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const base = join(root, 'native', 'ship-sidecar', 'build');

    const candidates = platform() === 'win32'
        ? [
            join(base, 'Release', 'ship-sidecar.exe'),
            join(base, 'Debug', 'ship-sidecar.exe'),
            join(base, 'ship-sidecar.exe'),
        ]
        : [
            join(base, 'ship-sidecar'),
            join(base, 'Release', 'ship-sidecar'),
        ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return candidates[0];
}

function writeU32LE(buffer: Buffer, offset: number, value: number): void {
    buffer.writeUInt32LE(value, offset);
}

function writeBytesChunk(target: Buffer, offset: number, data: Buffer): number {
    writeU32LE(target, offset, data.length);
    data.copy(target, offset + 4);
    return 4 + data.length;
}

function buildStringBytes(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    const out = Buffer.allocUnsafe(4 + bytes.length);
    writeU32LE(out, 0, bytes.length);
    bytes.copy(out, 4);
    return out;
}

function buildBinaryChunk(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(4 + data.length);
    writeU32LE(out, 0, data.length);
    data.copy(out, 4);
    return out;
}

function appendStringList(chunks: Buffer[], values: string[]): void {
    const header = Buffer.allocUnsafe(4);
    writeU32LE(header, 0, values.length);
    chunks.push(header);

    for (const value of values) {
        chunks.push(buildStringBytes(value));
    }
}

function appendTraceFilters(chunks: Buffer[], filters: ShipTraceFilter[]): void {
    const header = Buffer.allocUnsafe(4);
    writeU32LE(header, 0, filters.length);
    chunks.push(header);

    for (const filter of filters) {
        chunks.push(buildStringBytes(filter.contract));
        chunks.push(buildStringBytes(filter.action));
    }
}

function appendTableFilters(chunks: Buffer[], filters: ShipTableFilter[]): void {
    const header = Buffer.allocUnsafe(4);
    writeU32LE(header, 0, filters.length);
    chunks.push(header);

    for (const filter of filters) {
        chunks.push(buildStringBytes(filter.code));
        chunks.push(buildStringBytes(filter.table));
    }
}

function buildFiltersPayload(filters: ShipSidecarFilters): Buffer {
    const chunks: Buffer[] = [];
    appendStringList(chunks, filters.deltaTypes);
    appendTraceFilters(chunks, filters.traceFilters);
    appendTableFilters(chunks, filters.tableFilters);
    return Buffer.concat(chunks);
}

function buildFrame(requestId: number, op: number, payload: Buffer): Buffer {
    const frame = Buffer.allocUnsafe(20 + payload.length);
    writeU32LE(frame, 0, MAGIC);
    writeU32LE(frame, 4, VERSION);
    writeU32LE(frame, 8, requestId);
    writeU32LE(frame, 12, op);
    writeU32LE(frame, 16, payload.length);
    if (payload.length > 0) {
        payload.copy(frame, 20);
    }
    return frame;
}

class InboundAccumulator {
    private chunks: Buffer[] = [];
    private chunkIndex = 0;
    private byteOffset = 0;
    private totalLength = 0;

    append(chunk: Buffer): void {
        if (chunk.length === 0) {
            return;
        }

        this.chunks.push(chunk);
        this.totalLength += chunk.length;
    }

    available(): number {
        return this.totalLength;
    }

    peekU32(byteOffset: number): number | null {
        const bytes = this.peekSlice(byteOffset, 4);
        if (!bytes) {
            return null;
        }

        return bytes.readUInt32LE(0);
    }

    peekSlice(byteOffset: number, size: number): Buffer | null {
        if (byteOffset + size > this.totalLength) {
            return null;
        }

        let remainingSkip = byteOffset;
        let chunkIndex = this.chunkIndex;
        let offset = this.byteOffset;

        while (chunkIndex < this.chunks.length && remainingSkip > 0) {
            const chunk = this.chunks[chunkIndex];
            const available = chunk.length - offset;
            if (remainingSkip >= available) {
                remainingSkip -= available;
                chunkIndex += 1;
                offset = 0;
            } else {
                offset += remainingSkip;
                remainingSkip = 0;
            }
        }

        if (chunkIndex >= this.chunks.length) {
            return null;
        }

        const first = this.chunks[chunkIndex];
        const firstLen = Math.min(size, first.length - offset);
        if (firstLen === size) {
            return first.subarray(offset, offset + size);
        }

        const out = Buffer.allocUnsafe(size);
        let written = 0;
        let currentIndex = chunkIndex;
        let currentOffset = offset;

        while (written < size && currentIndex < this.chunks.length) {
            const chunk = this.chunks[currentIndex];
            const copyLen = Math.min(size - written, chunk.length - currentOffset);
            chunk.copy(out, written, currentOffset, currentOffset + copyLen);
            written += copyLen;
            currentIndex += 1;
            currentOffset = 0;
        }

        return out;
    }

    consume(size: number): void {
        if (size <= 0) {
            return;
        }

        this.totalLength -= size;

        while (size > 0 && this.chunkIndex < this.chunks.length) {
            const chunk = this.chunks[this.chunkIndex];
            const available = chunk.length - this.byteOffset;
            if (size >= available) {
                size -= available;
                this.chunkIndex += 1;
                this.byteOffset = 0;
            } else {
                this.byteOffset += size;
                size = 0;
            }
        }

        if (this.chunkIndex > 0) {
            this.chunks = this.chunks.slice(this.chunkIndex);
            this.chunkIndex = 0;
        }
    }
}

class ShipSidecarWorker {
    private process: ChildProcessWithoutNullStreams | null = null;
    private readonly pending = new Map<number, PendingRequest>();
    private readonly inbound = new InboundAccumulator();
    private nextRequestId = 1;
    private closed = false;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly executablePath: string,
        private readonly workerId: number
    ) {}

    async start(): Promise<void> {
        if (!existsSync(this.executablePath)) {
            throw new Error(
                `ship-sidecar binary not found at ${this.executablePath}. ` +
                'Run yarn build:sidecar first.'
            );
        }

        this.process = spawn(this.executablePath, ['--stdio', '--threads', '1'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        this.process.stdout.on('data', (chunk: Buffer) => {
            this.inbound.append(chunk);
            this.drainInbound();
        });

        this.process.on('exit', () => {
            this.closed = true;
            this.failAll(new Error(`ship-sidecar worker #${this.workerId} exited`));
        });

        await this.ping();
    }

    async stop(): Promise<void> {
        if (!this.process || this.closed) {
            return;
        }

        try {
            await this.request(OP_SHUTDOWN, Buffer.alloc(0));
        } catch {
            // ignore shutdown errors
        }

        this.process.kill();
        this.process = null;
        this.closed = true;
    }

    async deserialize(type: string, data: Uint8Array | string): Promise<unknown> {
        const payload = Buffer.concat([
            buildStringBytes(type),
            buildBinaryChunk(normalizeBinary(data)),
        ]);
        return this.request(OP_DESERIALIZE, payload);
    }

    async deserializeBatch(rows: Array<{ type: string; data: Uint8Array | string }>): Promise<unknown[]> {
        const chunks: Buffer[] = [Buffer.allocUnsafe(4)];
        writeU32LE(chunks[0], 0, rows.length);

        for (const row of rows) {
            chunks.push(buildStringBytes(row.type));
            chunks.push(buildBinaryChunk(normalizeBinary(row.data)));
        }

        return this.request(OP_DESERIALIZE_BATCH, Buffer.concat(chunks)) as Promise<unknown[]>;
    }

    async deserializeBlock(request: ShipBlockDeserializeRequest): Promise<ShipBlockDeserializeResponse> {
        const whitelist = request.deltaWhitelist ?? [];
        const chunks: Buffer[] = [
            buildStringBytes(request.blockType ?? ''),
            buildBinaryChunk(request.block ? normalizeBinary(request.block) : Buffer.alloc(0)),
            buildBinaryChunk(request.traces ? normalizeBinary(request.traces) : Buffer.alloc(0)),
            buildBinaryChunk(request.deltas ? normalizeBinary(request.deltas) : Buffer.alloc(0)),
            Buffer.allocUnsafe(4),
        ];

        writeU32LE(chunks[4], 0, whitelist.length);
        for (const name of whitelist) {
            chunks.push(buildStringBytes(name));
        }

        return this.request(OP_DESERIALIZE_BLOCK, Buffer.concat(chunks)) as Promise<ShipBlockDeserializeResponse>;
    }

    async processShipMessage(request: ShipProcessMessageRequest): Promise<ShipProcessMessageResponse> {
        return this.request(
            OP_PROCESS_SHIP_MESSAGE,
            normalizeBinary(request.shipBytes)
        ) as Promise<ShipProcessMessageResponse>;
    }

    async setFilters(filters: ShipSidecarFilters): Promise<void> {
        await this.request(OP_SET_FILTERS, buildFiltersPayload(filters));
    }

    async setShipAbi(abiJson: string): Promise<void> {
        await this.request(OP_SET_SHIP_ABI, buildStringBytes(abiJson));
    }

    async setAbi(contract: string, abiJson: string): Promise<void> {
        const payload = Buffer.concat([
            buildStringBytes(contract),
            buildStringBytes(abiJson),
        ]);
        await this.request(OP_SET_ABI, payload);
    }

    async deserializeContractBatch(rows: ContractDeserializeRow[]): Promise<unknown[]> {
        const chunks: Buffer[] = [Buffer.allocUnsafe(4)];
        writeU32LE(chunks[0], 0, rows.length);

        for (const row of rows) {
            chunks.push(buildStringBytes(row.contract));
            chunks.push(buildStringBytes(row.type));
            chunks.push(buildBinaryChunk(normalizeBinary(row.data)));
        }

        return this.request(OP_DESERIALIZE_CONTRACT_BATCH, Buffer.concat(chunks)) as Promise<unknown[]>;
    }

    private async ping(): Promise<void> {
        const json = await this.request(OP_PING, Buffer.alloc(0));
        if (!json || typeof json !== 'object' || !(json as { pong?: boolean }).pong) {
            throw new Error(`ship-sidecar worker #${this.workerId} ping failed`);
        }
    }

    private request(op: number, payload: Buffer): Promise<unknown> {
        if (!this.process?.stdin.writable) {
            return Promise.reject(new Error(`ship-sidecar worker #${this.workerId} is not running`));
        }

        const requestId = this.nextRequestId++;
        const pendingPromise = new Promise<unknown>((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
        });

        const frame = buildFrame(requestId, op, payload);
        const writePromise = this.writeQueue
            .then(() => this.writeFrame(frame))
            .catch((error) => {
                const pending = this.pending.get(requestId);
                if (pending) {
                    this.pending.delete(requestId);
                    pending.reject(error instanceof Error ? error : new Error(String(error)));
                }
            });

        this.writeQueue = writePromise.then((): void => undefined, (): void => undefined);
        return pendingPromise;
    }

    private writeFrame(frame: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            const stdin = this.process!.stdin;
            const ok = stdin.write(frame, (error) => {
                if (error) {
                    reject(error);
                }
            });

            if (ok) {
                resolve();
                return;
            }

            stdin.once('drain', resolve);
            stdin.once('error', reject);
        });
    }

    private drainInbound(): void {
        while (this.inbound.available() >= 20) {
            const magic = this.inbound.peekU32(0);
            const version = this.inbound.peekU32(4);

            if (magic !== MAGIC || version !== VERSION) {
                this.failAll(new Error(`invalid ship-sidecar response header on worker #${this.workerId}`));
                return;
            }

            const requestId = this.inbound.peekU32(8)!;
            const bodyLength = this.inbound.peekU32(16)!;
            const totalLength = 20 + bodyLength;

            if (this.inbound.available() < totalLength) {
                return;
            }

            const body = this.inbound.peekSlice(20, bodyLength)!;
            this.inbound.consume(totalLength);

            const pending = this.pending.get(requestId);
            if (!pending) {
                continue;
            }

            this.pending.delete(requestId);

            if (body.length < 12) {
                pending.reject(new Error('invalid ship-sidecar response body'));
                continue;
            }

            const status = body.readUInt32LE(0);
            const format = body.readUInt32LE(4);
            const payloadLength = body.readUInt32LE(8);
            const payload = body.subarray(12, 12 + payloadLength);

            if (status !== 0) {
                pending.reject(new Error(payload.toString('utf8') || 'ship-sidecar request failed'));
                continue;
            }

            try {
                if (format === FORMAT_MSGPACK) {
                    pending.resolve(decode(payload));
                } else if (format === FORMAT_TEXT) {
                    pending.resolve(JSON.parse(payload.toString('utf8')));
                } else {
                    pending.reject(new Error(`unsupported sidecar response format ${format}`));
                }
            } catch (error) {
                pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear();
    }
}

export class ShipSidecarPool {
    private workers: ShipSidecarWorker[] = [];
    private nextWorker = 0;
    private readonly registeredAbis = new Map<string, string>();
    private registeredFiltersKey: string | null = null;
    private registeredShipAbi: string | null = null;

    constructor(
        private readonly executablePath: string,
        private readonly poolSize: number
    ) {}

    async start(): Promise<void> {
        this.workers = [];

        for (let i = 0; i < this.poolSize; i++) {
            const worker = new ShipSidecarWorker(this.executablePath, i);
            await worker.start();
            this.workers.push(worker);
        }

        logger.info(
            `Ship sidecar pool started (${this.poolSize} processes, msgpack v2): ${this.executablePath}`
        );
    }

    async stop(): Promise<void> {
        await Promise.all(this.workers.map(worker => worker.stop()));
        this.workers = [];
        this.nextWorker = 0;
        this.registeredAbis.clear();
        this.registeredFiltersKey = null;
        this.registeredShipAbi = null;
    }

    async deserialize(type: string, data: Uint8Array | string): Promise<unknown> {
        return this.pickWorker().deserialize(type, data);
    }

    async deserializeBatch(rows: Array<{ type: string; data: Uint8Array | string }>): Promise<unknown[]> {
        return this.pickWorker().deserializeBatch(rows);
    }

    async deserializeBlock(request: ShipBlockDeserializeRequest): Promise<ShipBlockDeserializeResponse> {
        return this.pickWorker().deserializeBlock(request);
    }

    async processShipMessage(request: ShipProcessMessageRequest): Promise<ShipProcessMessageResponse> {
        return this.pickWorker().processShipMessage(request);
    }

    async setFilters(filters: ShipSidecarFilters): Promise<void> {
        const key = JSON.stringify(filters);
        if (this.registeredFiltersKey === key) {
            return;
        }

        await Promise.all(this.workers.map(worker => worker.setFilters(filters)));
        this.registeredFiltersKey = key;
    }

    async setShipAbi(abiJson: string): Promise<void> {
        if (this.registeredShipAbi === abiJson) {
            return;
        }

        await Promise.all(this.workers.map(worker => worker.setShipAbi(abiJson)));
        this.registeredShipAbi = abiJson;
    }

    async registerAbi(contract: string, abiJson: string): Promise<void> {
        const cached = this.registeredAbis.get(contract);
        if (cached === abiJson) {
            return;
        }

        await Promise.all(this.workers.map(worker => worker.setAbi(contract, abiJson)));
        this.registeredAbis.set(contract, abiJson);
    }

    async deserializeContractBatchOrdered(rows: ContractDeserializeRow[]): Promise<unknown[]> {
        if (rows.length === 0) {
            return [];
        }

        if (this.workers.length === 1) {
            return this.workers[0].deserializeContractBatch(rows);
        }

        const chunkSize = Math.ceil(rows.length / this.workers.length);
        const tasks: Array<Promise<unknown[]>> = [];

        for (let i = 0; i < this.workers.length; i++) {
            const start = i * chunkSize;
            const chunk = rows.slice(start, start + chunkSize);
            if (chunk.length === 0) {
                continue;
            }
            tasks.push(this.workers[i].deserializeContractBatch(chunk));
        }

        const chunks = await Promise.all(tasks);
        return chunks.flat();
    }

    private pickWorker(): ShipSidecarWorker {
        const worker = this.workers[this.nextWorker];
        this.nextWorker = (this.nextWorker + 1) % this.workers.length;
        return worker;
    }
}

function normalizeBinary(data: Uint8Array | string): Buffer {
    if (typeof data === 'string') {
        return Buffer.from(data, 'hex');
    }

    return Buffer.from(data);
}

export async function createShipSidecarPool(
    poolSize: number,
    executablePath?: string
): Promise<ShipSidecarPool> {
    const pool = new ShipSidecarPool(executablePath ?? resolveDefaultSidecarPath(), poolSize);
    await pool.start();
    return pool;
}

export const ShipSidecarClient = ShipSidecarPool;
export const createShipSidecarClient = createShipSidecarPool;
