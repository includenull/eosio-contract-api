import express from 'express';

import { ApiNamespace } from '../interfaces.js';
import { HTTPServer } from '../../server.js';
import { AssetApi } from '../atomicassets/routes/assets.js';
import { OfferApi } from '../atomicassets/routes/offers.js';
import { TransferApi } from '../atomicassets/routes/transfers.js';
import { auctionsEndpoints, auctionSockets } from './routes/auctions.js';
import { salesEndpoints, salesSockets } from './routes/sales.js';
import { atomicmarketComponents } from './openapi.js';
import { configEndpoints } from './routes/config.js';
import { marketplacesEndpoints } from './routes/marketplaces.js';
import { formatOffer, formatTransfer } from '../atomicassets/format.js';
import { formatListingAsset, buildAssetFillerHook } from './format.js';
import { pricesEndpoints } from './routes/prices.js';
import { statsEndpoints } from './routes/stats.js';
import ApiNotificationReceiver from '../../notification.js';
import { buyoffersEndpoints, buyofferSockets } from './routes/buyoffers.js';
import { assetsEndpoints } from './routes/assets.js';
import { ActionHandlerContext } from '../../actionhandler.js';
import { ILimits } from '../../../types/config.js';
import { templateBuyoffersEndpoints } from './routes/template-buyoffers.js';

export interface AtomicMarketNamespaceArgs {
    connected_reader: string;

    atomicmarket_account: string;
    // optional
    atomicassets_account: string;
    delphioracle_account: string;

    socket_features?: {
        asset_update?: boolean;
    };
    api_features?: {
        disable_v1_sales?: boolean;
    };
    limits?: ILimits;
}

export enum SaleApiState {
    WAITING = 0,
    LISTED = 1,
    CANCELED = 2,
    SOLD = 3,
    INVALID = 4
}

export enum AuctionApiState {
    WAITING = 0, // Auction created but assets were not transferred yet
    LISTED = 1, // Auction pending and open to bids
    CANCELED = 2, // Auction was canceled
    SOLD = 3, // Auction has been sold
    INVALID = 4 // Auction ended but no bid was made
}

export enum BuyofferApiState {
    PENDING = 0,
    DECLINED = 1,
    CANCELED = 2,
    ACCEPTED = 3,
    INVALID = 4
}

export enum TemplateBuyofferApiState {
    LISTED = 0,
    CANCELED = 1,
    SOLD = 2
}

export type AtomicMarketContext = ActionHandlerContext<AtomicMarketNamespaceArgs>;

export class AtomicMarketNamespace extends ApiNamespace {
    static namespaceName = 'atomicmarket';

    declare args: AtomicMarketNamespaceArgs;

    async init(): Promise<void> {
        if (typeof this.args.atomicmarket_account !== 'string') {
            throw new Error('Argument missing in atomicmarket api namespace: atomicmarket_account');
        }

        const query = await this.connection.database.query(
            'SELECT * FROM atomicmarket_config WHERE market_contract = $1',
            [this.args.atomicmarket_account]
        );

        if (query.rowCount === 0) {
            if (typeof this.args.atomicassets_account !== 'string' || typeof this.args.delphioracle_account !== 'string') {
                throw new Error('AtomicMarket API is not initialized yet (reader not running)');
            }
        } else {
            this.args.atomicassets_account = query.rows[0].assets_contract;
            this.args.delphioracle_account = query.rows[0].delphi_contract;
        }

        if (!this.args.socket_features) {
            this.args.socket_features = {
                asset_update: true,
            };
        }
    }

    async router(server: HTTPServer): Promise<express.Router> {
        const router = express.Router();

        server.docs.addSchemas(atomicmarketComponents);

        if (server.web.limiter) {
            server.web.express.use(this.path, server.web.limiter);
        }

        const endpointsDocs = [];

        endpointsDocs.push(salesEndpoints(this, server, router));
        endpointsDocs.push(auctionsEndpoints(this, server, router));
        endpointsDocs.push(buyoffersEndpoints(this, server, router));
        endpointsDocs.push(templateBuyoffersEndpoints(this, server, router));
        endpointsDocs.push(marketplacesEndpoints(this, server, router));
        endpointsDocs.push(pricesEndpoints(this, server, router));
        endpointsDocs.push(statsEndpoints(this, server, router));
        endpointsDocs.push(configEndpoints(this, server, router));

        const assetApi = new AssetApi(
            this, server, 'ListingAsset',
            'atomicassets_assets_master',
            formatListingAsset, buildAssetFillerHook({
                fetchSales: true,
                fetchAuctions: true,
                fetchTemplateBuyoffers: true,
                fetchPrices: true,
            }),
        );
        const transferApi = new TransferApi(
            this, server, 'ListingTransfer',
            'atomicassets_transfers_master', formatTransfer,
            'atomicassets_assets_master',
            formatListingAsset, buildAssetFillerHook({
                fetchSales: true,
                fetchAuctions: true,
                fetchTemplateBuyoffers: true,
                fetchPrices: true,
            })
        );
        const offerApi = new OfferApi(
            this, server, 'ListingOffer',
            'atomicassets_offers_master', formatOffer,
            'atomicassets_assets_master',
            formatListingAsset, buildAssetFillerHook({
                fetchSales: true,
                fetchAuctions: true,
                fetchTemplateBuyoffers: true,
                fetchPrices: true,
            }),
        );

        endpointsDocs.push(assetsEndpoints(this, server, router));
        endpointsDocs.push(assetApi.singleAssetEndpoints(router));
        endpointsDocs.push(transferApi.endpoints(router));
        endpointsDocs.push(offerApi.endpoints(router));

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

        salesSockets(this, server, notification);
        auctionSockets(this, server, notification);
        buyofferSockets(this, server, notification);
    }
}
