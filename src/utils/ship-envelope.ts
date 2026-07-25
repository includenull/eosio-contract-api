import { ABI, Bytes, Serializer } from '@wharfkit/antelope';

export type ShipBlockPosition = {
    block_num: number;
    block_id: string;
};

export type ParsedShipBlocksResult = {
    resultType: string;
    version: number;
    head: ShipBlockPosition;
    last_irreversible: ShipBlockPosition;
    this_block?: ShipBlockPosition;
    prev_block?: ShipBlockPosition;
    block?: Uint8Array;
    traces?: Uint8Array;
    deltas?: Uint8Array;
};

const BLOCKS_RESULT_VERSIONS: Record<string, number> = {
    get_blocks_result_v0: 0,
    get_blocks_result_v1: 1,
    get_blocks_result_v2: 2,
};

function toUint8Array(value: unknown): Uint8Array | undefined {
    if (!value) {
        return undefined;
    }

    if (value instanceof Uint8Array) {
        return value;
    }

    const bytes = value as { array?: Uint8Array };
    if (bytes.array instanceof Uint8Array) {
        return bytes.array;
    }

    return undefined;
}

function toBlockPosition(value: unknown): ShipBlockPosition | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }

    const row = value as {
        block_num?: { value?: { toString(): string } } | number | bigint;
        block_id?: { hexString?: string; toString(): string };
    };

    const blockNum = row.block_num;
    const blockId = row.block_id;

    if (!blockNum || !blockId) {
        return undefined;
    }

    return {
        block_num: typeof blockNum === 'object' ? Number(blockNum.value?.toString() ?? blockNum) : Number(blockNum),
        block_id: typeof blockId.hexString === 'string' ? blockId.hexString : blockId.toString(),
    };
}

function toBinaryField(value: unknown): Uint8Array | undefined {
    if (Array.isArray(value) && typeof value[0] === 'string') {
        return undefined;
    }

    return toUint8Array(value);
}

export function parseShipBlocksResult(data: Uint8Array | Buffer, abi: ABI): ParsedShipBlocksResult | null {
    const bytes = Bytes.from(data instanceof Buffer ? new Uint8Array(data) : data);
    const decoded = Serializer.decode({ data: bytes, abi, type: 'result' }) as [string, Record<string, unknown>];

    const resultType = decoded[0];
    const version = BLOCKS_RESULT_VERSIONS[resultType];

    if (version === undefined) {
        return null;
    }

    const response = decoded[1];
    const head = toBlockPosition(response.head);
    const lastIrreversible = toBlockPosition(response.last_irreversible);

    if (!head || !lastIrreversible) {
        throw new Error('Invalid get_blocks_result: missing head or last_irreversible');
    }

    return {
        resultType,
        version,
        head,
        last_irreversible: lastIrreversible,
        this_block: toBlockPosition(response.this_block),
        prev_block: toBlockPosition(response.prev_block),
        block: toBinaryField(response.block),
        traces: toBinaryField(response.traces),
        deltas: toBinaryField(response.deltas),
    };
}
