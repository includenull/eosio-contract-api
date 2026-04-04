import {initAtomicMarketTest} from '../test.js';
import {RequestValues} from '../../utils.js';
import {getTestContext} from '../../../../utils/test.js';
import {getTemplateBuyOffersAction} from './template-buyoffers.js';

// TODO add more tests
describe('template buy offer handler', () => {
    const {client, txit} = initAtomicMarketTest();

    async function getBuyOffersIds(values: RequestValues): Promise<Array<number>> {
        const testContext = getTestContext(client);

        const result = await getTemplateBuyOffersAction(values, testContext);

        return result.map((s: any) => s.buyoffer_id);
    }

    describe('getTemplateBuyOffers', () => {

        txit('orders by asset name', async () => {
            const buyOffer1 = await client.createTemplateBuyOffer();
            const buyOffer2 = await client.createTemplateBuyOffer();
            const buyOffer3 = await client.createTemplateBuyOffer();

            const asset1 = await client.createAsset({
                mutable_data: {name: 'Z'},
                template_id: buyOffer1.template_id,
            });
            await client.createTemplateBuyOfferAssets({
                asset_id: asset1.asset_id,
                buyoffer_id: buyOffer1.buyoffer_id,
            });

            const asset2 = await client.createAsset({
                immutable_data: {name: 'A'},
                template_id: buyOffer2.template_id,
            });
            await client.createTemplateBuyOfferAssets({
                asset_id: asset2.asset_id,
                buyoffer_id: buyOffer2.buyoffer_id,
            });

            await client.createTemplate({
                template_id: buyOffer1.template_id,
            });

            await client.createTemplate({
                template_id: buyOffer2.template_id,
            });

            await client.createTemplate({
                template_id: buyOffer3.template_id,
                immutable_data: {name: 'H'}
            });

            expect(await getBuyOffersIds({sort: 'name', order: 'asc'}))
                .toEqual([buyOffer2.buyoffer_id, buyOffer3.buyoffer_id, buyOffer1.buyoffer_id]);
        });

    });

    afterAll(async () => {
        await client.end();
    });
});
