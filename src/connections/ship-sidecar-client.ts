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
const OP_SHUTDOWN = 255;

const FORMAT_TEXT = 0;
const FORMAT_MSGPACK = 1;

type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
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

function readU32(buffer: Buffer, offset: number): number {
    return buffer.readUInt32LE(offset);
}

class ShipSidecarWorker {
    private process: ChildProcessWithoutNullStreams | null = null;
    private readonly pending = new Map<number, PendingRequest>();
    private inboundBuffer = Buffer.alloc(0);
    private nextRequestId = 1;
    private closed = false;
    private requestChain: Promise<void> = Promise.resolve();

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
            this.inboundBuffer = Buffer.concat([this.inboundBuffer, chunk]);
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

        const execute = async (): Promise<unknown> => {
            const requestId = this.nextRequestId++;

            return new Promise((resolve, reject) => {
                this.pending.set(requestId, { resolve, reject });

                const header = Buffer.allocUnsafe(20);
                writeU32LE(header, 0, MAGIC);
                writeU32LE(header, 4, VERSION);
                writeU32LE(header, 8, requestId);
                writeU32LE(header, 12, op);
                writeU32LE(header, 16, payload.length);

                this.process!.stdin.write(Buffer.concat([header, payload]));
            });
        };

        const result = this.requestChain.then(execute, execute);
        this.requestChain = result.then((): void => undefined, (): void => undefined);
        return result;
    }

    private drainInbound(): void {
        while (this.inboundBuffer.length >= 20) {
            const magic = readU32(this.inboundBuffer, 0);
            const version = readU32(this.inboundBuffer, 4);

            if (magic !== MAGIC || version !== VERSION) {
                this.failAll(new Error(`invalid ship-sidecar response header on worker #${this.workerId}`));
                return;
            }

            const requestId = readU32(this.inboundBuffer, 8);
            const bodyLength = readU32(this.inboundBuffer, 16);
            const totalLength = 20 + bodyLength;

            if (this.inboundBuffer.length < totalLength) {
                return;
            }

            const body = this.inboundBuffer.subarray(20, totalLength);
            this.inboundBuffer = this.inboundBuffer.subarray(totalLength);

            const pending = this.pending.get(requestId);
            if (!pending) {
                continue;
            }

            this.pending.delete(requestId);

            if (body.length < 12) {
                pending.reject(new Error('invalid ship-sidecar response body'));
                continue;
            }

            const status = readU32(body, 0);
            const format = readU32(body, 4);
            const payloadLength = readU32(body, 8);
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
