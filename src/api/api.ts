import express from 'express';

import { ApiNamespace } from './namespaces/interfaces.js';
import { HTTPServer } from './server.js';
import { IServerConfig } from '../types/config.js';
import ConnectionManager from '../connections/manager.js';
import { getNamespaces } from './namespaces/index.js';

export default class Api {
    private readonly namespaces: ApiNamespace[];
    private readonly server: HTTPServer;

    constructor(private readonly config: IServerConfig, private readonly connection: ConnectionManager) {
        this.namespaces = getNamespaces(config.namespaces, connection);
        this.server = new HTTPServer(config, connection);
    }

    async listen(): Promise<void> {
        for (const namespace of this.namespaces) {
            await namespace.init();
            this.server.web.express.use(namespace.path, await namespace.router(this.server));
            await namespace.socket(this.server);
        }

        this.server.docs.render();

        this.server.web.express.use((_: express.Request, res: express.Response) => {
            res.status(404).json({
                success: false, message: 'Endpoint not found'
            });
        });

        this.server.listen();
    }
}
