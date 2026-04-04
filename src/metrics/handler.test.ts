import * as os from 'os';

import {connectionConfig} from '../utils/test.js';
import {MetricsCollectorHandler} from './handler.js';
import {Registry} from 'prom-client';
import ConnectionManager from '../connections/manager.js';

describe('FillerMetricCollector', () => {
    const connections = new ConnectionManager({
        ...connectionConfig,
        postgres: {
            ...connectionConfig.postgres,
            database: `${connectionConfig.postgres.database}-test`,
        }
    });


    beforeAll(async () => {
        await connections.connect();
    });

    it('returns the metrics', async () => {
        const handler = new MetricsCollectorHandler(connections, 'filler', os.hostname());

        const metrics = [
            'eos_contract_api_sql_live',
            'eos_contract_api_pool_clients_count',
            'eos_contract_api_waiting_pool_clients_count',
            'eos_contract_api_idle_pool_clients_count',
            'eos_contract_api_readers_blocks_behind_count',
            'eos_contract_api_readers_time_behind_chain_sec',
            'eos_contract_api_redis_live',
        ];
        const res = await handler.getMetrics(new Registry());

        expect(metrics.every(s => res.includes(s))).toBe(true);
    });

    it('skips the metrics using the collect from option', async () => {
        const handler = new MetricsCollectorHandler(connections, 'filler', os.hostname(), {
            readers: false,
            redis_connection: false,
            psql_pool: false
        });

        const metrics = [
            'eos_contract_api_pool_clients_count',
            'eos_contract_api_waiting_pool_clients_count',
            'eos_contract_api_idle_pool_clients_count',
            'eos_contract_api_readers_blocks_behind_count',
            'eos_contract_api_readers_time_behind_chain_sec',
            'eos_contract_api_redis_live',
        ];
        const res = await handler.getMetrics(new Registry());

        expect(metrics.every(s => !res.includes(s))).toBe(true);
        expect(res.includes('eos_contract_api_sql_live')).toBe(true);
    });

    afterAll(async () => {
        await connections.disconnect();
    });
});
