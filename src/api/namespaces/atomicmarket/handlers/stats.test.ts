import {initAtomicMarketTest} from '../test.js';
import {getTestContext} from '../../../../utils/test.js';
import {getTemplateStatsAction} from './stats.js';
import {SaleApiState} from '../index.js';


const {client, txit} = initAtomicMarketTest();

describe('AtomicMarket Stats API', () => {
    describe('getTemplateStatsAction', () => {
        txit('gets the templates sales and volume', async () => {
            await client.createContractReader();

            await client.createToken({token_symbol: 'TOKEN1'});
            const {template_id} = await client.createTemplate();
            const {template_id: templateId2} = await client.createTemplate();

            const context = getTestContext(client);

            await client.createFullSale({
                final_price: 1,
                listing_price: 1, listing_symbol: 'TOKEN1',
                settlement_symbol: 'TOKEN1', state: SaleApiState.SOLD,
                taker_marketplace: 'X',
            }, {template_id});

            await client.createFullSale({
                final_price: 1,
                listing_price: 1,
                listing_symbol: 'TOKEN1',
                settlement_symbol: 'TOKEN1',
                state: SaleApiState.SOLD,
                taker_marketplace: 'X',
            }, {template_id});

            await client.refreshStatsMarket();

            const response = await getTemplateStatsAction({symbol: 'TOKEN1'}, context);

            expect(response.results.length).toBe(2);
            expect(response.results.find((r: any) => r.template.template_id === template_id)).toMatchObject({
                volume: '2',
                sales: '2'
            });

            expect(response.results.find((r: any) => r.template.template_id === templateId2)).toMatchObject({
                volume: '0',
                sales: '0'
            });
        });

        describe('with template_id filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {template_id} = await client.createTemplate();
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', template_id: template_id}, context);


                expect(response.results.length).toBe(1);
                expect(response.results[0]).toMatchObject({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.template_id).toBe(template_id);
            });
        });

        describe('with schema_name filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {schema_name, collection_name} = await client.createSchema();
                const {template_id} = await client.createTemplate({schema_name, collection_name});
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', schema_name}, context);


                expect(response.results.length).toBe(1);
                expect(response.results[0]).toMatchObject({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.template_id).toBe(template_id);
            });
        });

        describe('with collection_name filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {collection_name} = await client.createCollection();
                await client.createTemplate({collection_name});
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', collection_name}, context);


                expect(response.results.length).toBe(1);
                expect(response.results[0]).toMatchObject({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.collection.collection_name).toBe(collection_name);
            });
        });

        describe('with search filter', () => {
            txit('gets the templates sales and volume even if they dont have sales', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                const context = getTestContext(client);
                // Included
                const {template_id} = await client.createTemplate({immutable_data: {name: 'test'}});
                // Not included
                await client.createTemplate();

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({symbol: 'TOKEN1', search: 'test'}, context);


                expect(response.results.length).toBe(1);
                expect(response.results[0]).toMatchObject({
                    volume: '0', sales: '0',
                });
                expect(response.results[0].template.template_id).toBe(template_id);
            });
        });

        describe('with time after and before filter', () => {
            txit('gets the templates sales and volume even if they dont have sales in the period defined', async () => {
                await client.createContractReader();

                await client.createToken({token_symbol: 'TOKEN1'});
                // Included
                const {template_id} = await client.createTemplate();
                // Not included
                const {template_id: template_id2} = await client.createTemplate();

                const now = Date.now();

                const context = getTestContext(client);

                // Included
                await client.createFullSale({
                    final_price: 1,
                    listing_price: 1, listing_symbol: 'TOKEN1',
                    settlement_symbol: 'TOKEN1', state: SaleApiState.SOLD,
                    updated_at_time: now,
                    taker_marketplace: 'X',
                }, {template_id});



                // Not included
                await client.createFullSale({
                    final_price: 1,
                    listing_price: 1,
                    listing_symbol: 'TOKEN1',
                    settlement_symbol: 'TOKEN1',
                    state: SaleApiState.SOLD,
                    updated_at_time: now - 20,
                    taker_marketplace: 'X',
                }, {template_id: template_id2});

                // Not included
                await client.createFullSale({
                    final_price: 1,
                    listing_price: 1,
                    listing_symbol: 'TOKEN1',
                    settlement_symbol: 'TOKEN1',
                    state: SaleApiState.SOLD,
                    updated_at_time: now + 20,
                    taker_marketplace: 'X',
                }, {template_id: template_id2});

                await client.refreshStatsMarket();

                const response = await getTemplateStatsAction({
                    symbol: 'TOKEN1',
                    before: (now + 10).toString(),
                    after: (now - 10).toString()
                }, context);

                expect(response.results.length).toBe(2);
                const t1Result = response.results.find((t: { template: { template_id: string} }) => t.template.template_id === template_id);
                const t2Result = response.results.find((t: { template: { template_id: string} }) => t.template.template_id === template_id2);


                expect(t1Result).toMatchObject({
                    volume: '1', sales: '1',
                });

                expect(t2Result).toMatchObject({
                    volume: '0', sales: '0',
                });
            });
        });
    });

    afterAll(async () => await client.end());
});
