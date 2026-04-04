import { ABI, APIClient, Bytes, Serializer } from '@wharfkit/antelope';

import type { UInt32 } from '@wharfkit/antelope';

function intToNumber(v: UInt32 | number): number {
    if (typeof v === 'number') {
        return v;
    }

    return v.toNumber();
}

function rowToPlain(row: unknown): any {
    if (row === null || typeof row !== 'object') {
        return row;
    }
    const r = row as { toJSON?: () => unknown };
    if (typeof r.toJSON === 'function') {
        return r.toJSON();
    }

    return Serializer.objectify(row as Parameters<typeof Serializer.objectify>[0]);
}

export type ChainRpcShim = {
    get_info(): Promise<{
        chain_id: string;
        head_block_num: number;
        head_block_time: string;
        last_irreversible_block_num: number;
    }>;
    get_abi(account: string): Promise<{ account_name: string; abi?: ABI.Def }>;
    get_table_rows(params: Record<string, unknown>): Promise<{ rows: any[]; more: boolean }>;
};

function createRpcShim(client: APIClient): ChainRpcShim {
    return {
        async get_info(): Promise<{
            chain_id: string;
            head_block_num: number;
            head_block_time: string;
            last_irreversible_block_num: number;
        }> {
            const i = await client.v1.chain.get_info();

            return {
                chain_id: String(i.chain_id),
                head_block_num: intToNumber(i.head_block_num),
                head_block_time: i.head_block_time.toString(),
                last_irreversible_block_num: intToNumber(i.last_irreversible_block_num),
            };
        },

        async get_abi(account: string): Promise<{ account_name: string; abi?: ABI.Def }> {
            return client.v1.chain.get_abi(account);
        },

        async get_table_rows(params: Record<string, unknown>): Promise<{ rows: any[]; more: boolean }> {
            const r = await client.v1.chain.get_table_rows({
                json: params.json !== false,
                code: String(params.code),
                table: String(params.table),
                scope: params.scope !== undefined ? String(params.scope) : String(params.code),
                limit: params.limit !== undefined ? Number(params.limit) : undefined,
                lower_bound: params.lower_bound as never,
                upper_bound: params.upper_bound as never,
                reverse: params.reverse as boolean | undefined,
                index_position: params.index_position as never,
                key_type: params.key_type as never,
                show_payer: params.show_payer as boolean | undefined,
            });

            return {
                rows: r.rows.map(rowToPlain),
                more: r.more,
            };
        },
    };
}

export default class ChainApi {
    readonly client: APIClient;
    private readonly rpcShim: ChainRpcShim;

    constructor(readonly endpoint: string, readonly name: string, readonly chainId: string) {
        this.client = new APIClient({ url: endpoint });
        this.rpcShim = createRpcShim(this.client);
    }

    get rpc(): ChainRpcShim {
        return this.rpcShim;
    }

    deserializeAbi(data: Uint8Array): ABI {
        return Serializer.decode({ data: Bytes.from(data), type: ABI });
    }

    async post(path: string, body: unknown): Promise<unknown> {
        const request = await fetch(this.endpoint + path, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        return request.json();
    }

    async checkChainId(): Promise<boolean> {
        const info = await this.client.v1.chain.get_info();

        return String(info.chain_id) === this.chainId;
    }
}
