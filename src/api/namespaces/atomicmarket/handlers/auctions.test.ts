
import {initAtomicMarketTest} from '../test.js';
import {RequestValues} from '../../utils.js';
import {getTestContext} from '../../../../utils/test.js';
import {getAuctionsAction} from './auctions.js';

// TODO add more tests
describe('auction handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getAuctionsIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getAuctionsAction(values, testContext);

        return result.map((s: any) => s.auction_id);
    }

    describe('getAuctions', () => {
        txit('returns empty on no auctions', async () => {
            expect(await getAuctionsIds({})).toEqual([]);
        });

        txit('returns all auctions without filters', async () => {
            const auction = await client.createAuction();
            const auction2 = await client.createAuction();

            expect((await getAuctionsIds({})).sort())
                .toEqual([auction.auction_id, auction2.auction_id].sort());
        });

        describe('with template_blacklist args', () => {
            txit('filter out auctions the given template matching the blacklist', async () => {
                const auction = await client.createAuction();
                const asset = await client.createAsset({
                    template_id: (await client.createTemplate()).template_id,
                });
                await client.createAuctionAssets({
                    asset_id: asset.asset_id,
                    auction_id: auction.auction_id,
                });

                // excluded
                const auction2 = await client.createAuction();
                const asset2 = await client.createAsset({
                    template_id: (await client.createTemplate()).template_id,
                });
                await client.createAuctionAssets({
                    asset_id: asset2.asset_id,
                    auction_id: auction2.auction_id,
                });

                expect(await getAuctionsIds({template_blacklist: [asset2.template_id].join(',')}))
                    .toEqual([auction.auction_id]);
            });
        });

        txit('orders by asset name', async () => {

            const auction1 = await client.createAuction();
            const auction2 = await client.createAuction();
            const auction3 = await client.createAuction();

            const asset1 = await client.createAsset({
                mutable_data: {name: 'Z'},
            });
            await client.createAuctionAssets({
                asset_id: asset1.asset_id,
                auction_id: auction1.auction_id,
            });

            const asset2 = await client.createAsset({
                immutable_data: {name: 'A'},
            });
            await client.createAuctionAssets({
                asset_id: asset2.asset_id,
                auction_id: auction2.auction_id,
            });

            const asset3 = await client.createAsset({
                template_id: (await client.createTemplate({
                    immutable_data: {name: 'H'}
                })).template_id,
            });
            await client.createAuctionAssets({
                asset_id: asset3.asset_id,
                auction_id: auction3.auction_id,
            });

            expect(await getAuctionsIds({sort: 'name', order: 'asc'}))
                .toEqual([auction2.auction_id, auction3.auction_id, auction1.auction_id]);
        });

    });

    afterAll(async () => {
        await client.end();
    });
});
