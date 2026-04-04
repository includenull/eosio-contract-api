import { Client } from 'pg';
import { it } from 'vitest';
import { DB } from '../api/server.js';
import { RequestValues } from '../api/namespaces/utils.js';
import { AtomicMarketContext } from '../api/namespaces/atomicmarket/index.js';
import { IConnectionsConfig } from '../types/config.js';
import { initListValidator } from '../api/namespaces/lists.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const connectionConfig: IConnectionsConfig = require('../../config/connections.config.json');

export class TestClient extends Client implements DB {

    private id: number = 1;

    constructor() {
        super({
            ...connectionConfig.postgres,
            database: `${connectionConfig.postgres.database}-test`,
        });

        // eslint-disable-next-line no-console
        this.connect().catch(console.error);
    }

    getId(): number {
        return ++this.id;
    }

    getName(): string {
        const replacements: Record<string, string> = {
            '6': 'a',
            '7': 'b',
            '8': 'c',
            '9': 'd',
            '0': 'e',
        };
        return `n${String(this.getId()).split('').map(char => replacements[char] ?? char).join('')}`;
    }

    async init(): Promise<void> {}

    async createContractCode(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return await this.insert('contract_codes', {
            account: 'account',
            block_num: this.getId(),
            block_time: this.getId(),
            ...values,
        });
    }

    async createContractReader(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return await this.insert('contract_readers', {
            name: 'test-default',
            block_num: this.getId(),
            block_time: this.getId(),
            live: false,
            updated: this.getId(),
            ...values,
        });
    }

    async createList(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return this.insert('lists', {
            list_name: 'list1',
            ...values,
        });
    }

    async createListItem(values: Record<string, any> = {}): Promise<Record<string, any>> {
        return this.insert('list_items', {
            item_name: 'item1',
            ...values,
        });
    }

    async createFullList(listValues: Record<string, any> = {}, itemValues: Record<string, any> = {}): Promise<Record<string, any>> {
        const list = await this.createList(listValues);

        const listItem = await this.createListItem({
            ...itemValues,
            list_id: list.id,
        });

        return {
            list,
            listItem,
        };
    }

    protected async insert(table: string, data: Record<string, any>): Promise<Record<string, any>> {
        data = data || {};

        const columns = Object.keys(data);

        const columnsSQL = (columns.length ? '('+columns.join(',')+')' : '');
        const valuesSQL = (columns.length ? `VALUES (${columns.map((c, i) => `$${i + 1}`).join(',')})` : 'DEFAULT VALUES');
        const values = columns.map(c => data[c]);

        const sql = `INSERT INTO ${table} ${columnsSQL} ${valuesSQL} RETURNING *`;

        const {rows} = await this.query(sql, values);

        return rows[0];
    }

    async fetchOne<T = any>(queryText: string, values: any[] = []): Promise<T> {
        const {rows} = await this.query(queryText, values);

        return rows[0];
    }

}

type TxItFn = (this: any, client: TestClient) => Promise<void>;

export function createTxIt(client: TestClient): any {
    async function runTxTest(fn: TxItFn, self: any): Promise<any> {
        await client.query('BEGIN');

        initListValidator(client);

        try {
            await client.init();

            return await fn.call(self, client);
        } finally {
            await client.query('ROLLBACK');
        }
    }

    function txit(title: string, fn: TxItFn): ReturnType<typeof it> {
        return it(title, async function (): Promise<void> {
            await runTxTest(fn, this);
        });
    }

    txit.skip = (title: string, fn: TxItFn): ReturnType<typeof it.skip> =>
        it.skip(title, async function (): Promise<void> {
            await runTxTest(fn, this);
        });

    txit.only = (title: string, fn: TxItFn): ReturnType<typeof it.only> =>
        it.only(title, async function (): Promise<void> {
            await runTxTest(fn, this);
        });

    return txit;
}

export function getTestContext(db: DB, pathParams: RequestValues = {}): AtomicMarketContext {
    return {
        pathParams,
        db,
        coreArgs: {
            atomicmarket_account: 'amtest',
            atomicassets_account: 'aatest',
            delphioracle_account: 'dotest',

            connected_reader: '',

            socket_features: {
                asset_update: false,
            },
        },
    };
}
