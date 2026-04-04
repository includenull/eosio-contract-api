import express from 'express';

import { ApiNamespace } from '../interfaces.js';
import { HTTPServer } from '../../server.js';
import { AssetApi } from './routes/assets.js';
import { collectionsEndpoints } from './routes/collections.js';
import { configEndpoints } from './routes/config.js';
import { schemasEndpoints } from './routes/schemas.js';
import { templatesEndpoints } from './routes/templates.js';
import { atomicassetsComponents } from './openapi.js';
import { formatAsset, formatOffer, formatTransfer } from './format.js';
import { TransferApi } from './routes/transfers.js';
import { OfferApi } from './routes/offers.js';
import { accountsEndpoints } from './routes/accounts.js';
import ApiNotificationReceiver from '../../notification.js';
import { burnEndpoints } from './routes/burns.js';
import { ActionHandlerContext } from '../../actionhandler.js';
import {ILimits} from '../../../types/config.js';

export type AtomicAssetsNamespaceArgs = {
    connected_reader: string;

    atomicassets_account: string;

    socket_features?: {
        asset_update?: boolean
    };

    limits?: ILimits;
};

export type AtomicAssetsContext = ActionHandlerContext<AtomicAssetsNamespaceArgs>;

export class AtomicAssetsNamespace extends ApiNamespace {
    static namespaceName = 'atomicassets';

    declare args: AtomicAssetsNamespaceArgs;

    async init(): Promise<void> {
        if (typeof this.args.atomicassets_account !== 'string') {
            throw new Error('Argument missing in atomicassets api namespace: atomicassets_account');
        }

        if (!this.args.socket_features) {
            this.args.socket_features = {
                asset_update: true,
            };
        }
    }

    async router(server: HTTPServer): Promise<express.Router> {
        const router = express.Router();

        server.docs.addSchemas(atomicassetsComponents);

        if (server.web.limiter) {
            server.web.express.use(this.path, server.web.limiter);
        }

        const endpointsDocs: any[] = [];

        const assetApi = new AssetApi(
            this, server, 'Asset',
            'atomicassets_assets_master', formatAsset
        );
        const transferApi = new TransferApi(
            this, server, 'Transfer',
            'atomicassets_transfers_master', formatTransfer,
            'atomicassets_assets_master', formatAsset
        );
        const offerApi = new OfferApi(
            this, server, 'Offer',
            'atomicassets_offers_master', formatOffer,
            'atomicassets_assets_master', formatAsset
        );

        endpointsDocs.push(assetApi.multipleAssetEndpoints(router));
        endpointsDocs.push(assetApi.singleAssetEndpoints(router));
        endpointsDocs.push(collectionsEndpoints(this, server, router));
        endpointsDocs.push(schemasEndpoints(this, server, router));
        endpointsDocs.push(templatesEndpoints(this, server, router));

        endpointsDocs.push(offerApi.endpoints(router));
        endpointsDocs.push(transferApi.endpoints(router));
        endpointsDocs.push(accountsEndpoints(this, server, router));
        endpointsDocs.push(burnEndpoints(this, server, router));
        endpointsDocs.push(configEndpoints(this, server, router));

        for (const doc of endpointsDocs) {
            if (doc.tag) {
                server.docs.addTags([doc.tag]);
            }

            if (doc.paths) {
                const paths: any = {};

                for (const path of Object.keys(doc.paths)) {
                    paths[this.path + path] = doc.paths[path];
                }

                server.docs.addPaths(paths);
            }
        }

        router.all(['/docs', '/docs/swagger'], (req, res) => res.redirect('/docs'));

        return router;
    }

    async socket(server: HTTPServer): Promise<void> {
        const notification = new ApiNotificationReceiver(this.connection, this.args.connected_reader);

        const assetApi = new AssetApi(
            this, server, 'Asset',
            'atomicassets_assets_master', formatAsset
        );
        const transferApi = new TransferApi(
            this, server, 'Transfer',
            'atomicassets_transfers_master', formatTransfer,
            'atomicassets_assets_master', formatAsset
        );
        const offerApi = new OfferApi(
            this, server, 'Offer',
            'atomicassets_offers_master', formatOffer,
            'atomicassets_assets_master', formatAsset
        );

        assetApi.sockets(notification);
        transferApi.sockets(notification);
        offerApi.sockets(notification);
    }
}
