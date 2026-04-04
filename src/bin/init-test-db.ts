import { upgradeDb } from '../filler/upgrade-db.js';
import PostgresConnection from '../connections/postgres.js';
import logger from '../utils/logger.js';
import { IConnectionsConfig } from '../types/config.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const connectionConfig: IConnectionsConfig = require('../../config/connections.config.json');

async function main(): Promise<void> {
    const pg = connectionConfig.postgres;
    const db = `${pg.database}-test`;

    const tmpConnection = new PostgresConnection(pg.host, pg.port, pg.user, pg.password, pg.database);
    logger.info(`Dropping test db with name ${db}`);
    await tmpConnection.query(`DROP DATABASE IF EXISTS "${db}"`);
    logger.info(`Creating test db with name ${db}`);
    await tmpConnection.query(`CREATE DATABASE "${db}"`);

    const connection = new PostgresConnection(pg.host, pg.port, pg.user, pg.password, db);

    await upgradeDb(connection);

    process.exit(0);
}

main().catch(err => {
    logger.error(err);
    process.exit(1);
});
