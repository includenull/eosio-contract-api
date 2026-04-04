import ConnectionManager from '../connections/manager.js';
import logger from '../utils/logger.js';
import { IConnectionsConfig, IServerConfig } from '../types/config.js';
import Api from '../api/api.js';
import {MetricsServer} from '../metrics/server.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const serverConfig: IServerConfig = require('../../config/server.config.json');

let connectionConfig: IConnectionsConfig = {postgres: {}, redis: {}, chain: {}} as IConnectionsConfig;

try {
     
    connectionConfig = require('../../config/connections.config.json');
} catch {
    logger.warn('No connections.config.json found. Falling back to environment variables');
}

logger.info('Starting API Server...');

process.on('unhandledRejection', error => {
    logger.error('Unhandled Rejection', error);
});

process.on('uncaughtException', error => {
    logger.error('Uncaught Exception', error);
});

const connection = new ConnectionManager(connectionConfig);

(async (): Promise<void> => {
    await connection.connect();

    connection.chain.checkChainId().then(result => {
        if (!result) {
            logger.error('Chain Id in config mismatches node chain id. Stopping API...');

            process.exit(1);
        }
    }).catch(error => {
        logger.error('Failed to query chain id on startup. Ignoring it but please check the config for the correct endpoint', error);
    });

    if (!(await connection.database.tableExists('dbinfo'))) {
        logger.error('Tables not initialized yet. Stopping API...');

        process.exit(1);
    }

    try {
        const server = new Api(serverConfig, connection);
        if (serverConfig.metrics_port) {
            new MetricsServer(serverConfig.metrics_port, connection, 'api').serve();
        }
        await server.listen();
    } catch (e) {
        logger.error('Failed to start server', e);
    }
})();
