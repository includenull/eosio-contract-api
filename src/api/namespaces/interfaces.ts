import express from 'express';

import ConnectionManager from '../../connections/manager.js';
import { HTTPServer } from '../server.js';

export abstract class ApiNamespace {
    static namespaceName = '';

    protected constructor(
        readonly path: string,
        readonly connection: ConnectionManager,
        readonly args: {[key: string]: any}
    ) { }

    abstract init(): Promise<void>;
    abstract router(server: HTTPServer): Promise<express.Router>;
    abstract socket(server: HTTPServer): Promise<void>;
}
