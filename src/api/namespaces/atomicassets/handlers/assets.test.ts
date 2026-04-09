import { RequestValues } from '../../utils.js';
import { initAtomicAssetsTest } from '../test.js';
import { getTestContext } from '../../../../utils/test.js';
import { getRawAssetsAction } from './assets.js';

const {client, txit} = initAtomicAssetsTest();

async function getAssetIds(values: RequestValues): Promise<Array<number> | string> {
    const testContext = getTestContext(client);

    return await getRawAssetsAction(values, testContext);
}

async function getAssetCount(values: RequestValues): Promise<string> {
    const testContext = getTestContext(client);

    return await getRawAssetsAction({...values, count: 'true'}, testContext) as string;
}

describe('AtomicAssets Assets API', () => {

    describe('getRawAssetsAction V1', () => {

        txit('works without filters', async () => {

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({}))
                .toEqual([asset_id]);
        });

        txit('filters by authorized collection account', async () => {
            await client.createAsset();

            const {collection_name} = await client.createCollection({authorized_accounts: ['z']});
            const {asset_id} = await client.createAsset({collection_name});

            expect(await getAssetIds({authorized_account: 'z'}))
                .toEqual([asset_id]);
        });

        txit('filters by hiding template accounts', async () => {
            const {asset_id} = await client.createAsset();

            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id, owner: 'x'});
            await client.createAsset({template_id});

            expect(await getAssetIds({hide_templates_by_accounts: 'x'}))
                .toEqual([asset_id]);
        });

        txit('filters by duplicate templates for the same owner', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({only_duplicate_templates: 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by having backed tokens', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();
            await client.createAssetBackedToken({asset_id});

            expect(await getAssetIds({has_backed_tokens: 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by not having backed tokens', async () => {
            const {asset_id: asset_id2} = await client.createAsset();
            await client.createAssetBackedToken({asset_id: asset_id2});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({has_backed_tokens: 'false'}))
                .toEqual([asset_id]);
        });

        txit('filters by excluding offers', async () => {
            const {asset_id: asset_id2} = await client.createAsset();
            await client.createOfferAsset({asset_id: asset_id2});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({hide_offers: 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by template mint', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({template_mint: '3'}))
                .toEqual([asset_id]);
        });

        txit('filters by minimum template mint', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({min_template_mint: '2'}))
                .toEqual([asset_id]);
        });

        txit('filters by minimum template mint (treating no template as 1)', async () => {
            const {asset_id: asset_id2} = await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({min_template_mint: '1'}))
                .toEqual([asset_id, asset_id2]);
        });

        txit('filters by maximum template mint', async () => {
            await client.createAsset({
                template_mint: 4,
                template_id: (await client.createTemplate()).template_id,
            });

            // includes assets without template
            const {asset_id: asset_id2} = await client.createAsset();

            const {asset_id} = await client.createAsset({
                template_mint: 3,
                template_id: (await client.createTemplate()).template_id,
            });

            expect(await getAssetIds({max_template_mint: '3'}))
                .toEqual([asset_id, asset_id2]);
        });

        txit('filters by template blacklist', async () => {
            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id});

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate()).template_id,
            });

            // assets without template should not be filtered out
            const {asset_id: asset_id2} = await client.createAsset();

            expect(await getAssetIds({template_blacklist: `${template_id},-1`}))
                .toEqual([asset_id2, asset_id]);
        });

        txit('filters by template whitelist', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate();
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({template_whitelist: `${template_id},-1`}))
                .toEqual([asset_id]);
        });

        txit('filters by asset_id', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({asset_id: `${asset_id},-1`}))
                .toEqual([asset_id]);
        });

        txit('filters by owner', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({owner: 'x'});

            expect(await getAssetIds({owner: 'x'}))
                .toEqual([asset_id]);
        });

        txit('filters by template', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate();
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({template_id: `${template_id},-1`}))
                .toEqual([asset_id]);
        });

        txit('filters by not having a template', async () => {
            const {template_id} = await client.createTemplate();
            await client.createAsset({template_id});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({template_id: 'null'}))
                .toEqual([asset_id]);
        });

        txit('filters by collection name', async () => {
            await client.createAsset();

            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {asset_id} = await client.createAsset({collection_name});

            expect(await getAssetIds({collection_name: 'x,abc'}))
                .toEqual([asset_id]);
        });

        txit('filters by schema name', async () => {
            await client.createAsset();

            const {asset_id, schema_name} = await client.createAsset();

            expect(await getAssetIds({schema_name: `${schema_name},abc`}))
                .toEqual([asset_id]);
        });

        txit('filters by being burned', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({owner: null});

            expect(await getAssetIds({burned: 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by not being burned', async () => {
            await client.createAsset({owner: null});

            const {asset_id} = await client.createAsset({owner: 'x'});

            expect(await getAssetIds({burned: 'false'}))
                .toEqual([asset_id]);
        });

        txit('filters by being transferable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({transferable: false})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({transferable: true})).template_id,
            });

            expect(await getAssetIds({is_transferable: 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by not being transferable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({transferable: true})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({transferable: false})).template_id,
            });

            expect(await getAssetIds({is_transferable: 'false'}))
                .toEqual([asset_id]);
        });

        txit('filters by being burnable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({burnable: false})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({burnable: true})).template_id,
            });

            expect(await getAssetIds({is_burnable: 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by not being burnable', async () => {
            await client.createAsset({
                template_id: (await client.createTemplate({burnable: true})).template_id,
            });

            const {asset_id} = await client.createAsset({
                template_id: (await client.createTemplate({burnable: false})).template_id,
            });

            expect(await getAssetIds({is_burnable: 'false'}))
                .toEqual([asset_id]);
        });

        txit('filters by collection blacklist', async () => {
            const {collection_name} = await client.createCollection({collection_name: 'x'});
            await client.createAsset({collection_name});

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({collection_blacklist: 'x,abc'}))
                .toEqual([asset_id]);
        });

        txit('filters by collection whitelist', async () => {
            await client.createAsset();

            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {asset_id} = await client.createAsset({collection_name});

            expect(await getAssetIds({collection_whitelist: 'x,abc'}))
                .toEqual([asset_id]);
        });

        txit('filters by text data', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({'prop': 'TheValue'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'data:text.prop': 'TheValue'}))
                .toEqual([asset_id]);
        });

        txit('filters by number template_data', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({'prop': 1})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'template_data:number.prop': 1}))
                .toEqual([asset_id]);
        });

        txit('filters by bool mutable_data', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({mutable_data: JSON.stringify({'prop': 1})});

            expect(await getAssetIds({'mutable_data:bool.prop': 'true'}))
                .toEqual([asset_id]);
        });

        txit('filters by untyped immutable_data', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({immutable_data: JSON.stringify({'prop': 'this'})});

            expect(await getAssetIds({'immutable_data.prop': 'this'}))
                .toEqual([asset_id]);
        });

        txit('filters by match_immutable_name', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getAssetIds({'match_immutable_name': 'par%_tial'}))
                .toEqual([asset_id]);
        });

        txit('filters by match_mutable_name', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset({mutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});

            expect(await getAssetIds({'match_mutable_name': 'par%_tial'}))
                .toEqual([asset_id]);
        });

        txit('filters by match (template name)', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'match': 'par%_tial'}))
                .toEqual([asset_id]);
        });

        txit('filters by search (template name)', async () => {
            await client.createAsset();

            const {template_id} = await client.createTemplate({immutable_data: JSON.stringify({name: 'prefix_par%_tial_postfix'})});
            const {asset_id} = await client.createAsset({template_id});

            expect(await getAssetIds({'search': 'par%_tial'}))
                .toEqual([asset_id]);
        });

        txit('returns count', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();

            const result = await getAssetCount({ids: `${asset_id}`});

            expect(result).toBe('1');
        });

        txit('returns count from aggregate table without filters', async () => {
            await client.createAsset({owner: null});
            await client.createAsset();

            expect(await getAssetCount({})).toBe('2');
        });

        txit('returns count from aggregate table for burned filter', async () => {
            await client.createAsset({owner: null});
            await client.createAsset();

            expect(await getAssetCount({burned: 'true'})).toBe('1');
            expect(await getAssetCount({burned: 'false'})).toBe('1');
        });

        txit('returns count from aggregate table for collection and template filters', async () => {
            const {collection_name} = await client.createCollection({collection_name: 'x'});
            const {template_id} = await client.createTemplate({collection_name});

            await client.createAsset({collection_name, template_id});
            await client.createAsset({collection_name});
            await client.createAsset();

            expect(await getAssetCount({collection_name})).toBe('2');
            expect(await getAssetCount({template_id})).toBe('1');
            expect(await getAssetCount({template_id: 'null'})).toBe('2');
        });

        txit('falls back to raw count for owner filter', async () => {
            await client.createAsset({owner: 'alice'});
            await client.createAsset({owner: 'bob'});

            expect(await getAssetCount({owner: 'alice'})).toBe('1');
        });

        txit('orders ascending', async () => {
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset();

            expect(await getAssetIds({order: 'asc'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('orders descending', async () => {
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset();

            expect(await getAssetIds({order: 'desc'}))
                .toEqual([asset_id2, asset_id1]);
        });

        txit('orders by asset_id', async () => {
            const asset_id2 = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            await client.createAsset({asset_id: asset_id2});

            expect(await getAssetIds({sort: 'asset_id'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('orders by updated time', async () => {
            const updated_at_time = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset({updated_at_time});

            expect(await getAssetIds({sort: 'updated'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('orders by transferred time', async () => {
            const transferred_at_time = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            const {asset_id: asset_id2} = await client.createAsset({transferred_at_time});

            expect(await getAssetIds({sort: 'transferred'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('orders by minted', async () => {
            const asset_id2 = `${client.getId()}`;
            const {asset_id: asset_id1} = await client.createAsset();

            await client.createAsset({asset_id: asset_id2});

            expect(await getAssetIds({sort: 'minted'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('orders by template_mint', async () => {
            const {asset_id: asset_id1} = await client.createAsset({template_mint: 2});

            const {asset_id: asset_id2} = await client.createAsset({template_mint: 1});

            expect(await getAssetIds({sort: 'template_mint'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('orders by name', async () => {
            const {template_id: template_id1} = await client.createTemplate({immutable_data: JSON.stringify({name: 'B'})});
            const {asset_id: asset_id1} = await client.createAsset({template_id: template_id1});

            const {template_id: template_id2} = await client.createTemplate({immutable_data: JSON.stringify({name: 'A'})});
            const {asset_id: asset_id2} = await client.createAsset({template_id: template_id2});

            expect(await getAssetIds({sort: 'name'}))
                .toEqual([asset_id1, asset_id2]);
        });

        txit('paginates', async () => {
            const {asset_id} = await client.createAsset();

            await client.createAsset();

            expect(await getAssetIds({page: '2', limit: '1'}))
                .toEqual([asset_id]);
        });

        txit('filters by id (asset_id)', async () => {
            await client.createAsset();

            const {asset_id} = await client.createAsset();

            expect(await getAssetIds({ids: `${asset_id},-1`}))
                .toEqual([asset_id]);
        });

        txit('filters by id range (asset_id)', async () => {
            await client.createAsset();

            const lower_bound = `${client.getId()}`;

            const {asset_id} = await client.createAsset();
            const upper_bound = `${client.getId()}`;

            await client.createAsset();

            expect(await getAssetIds({lower_bound, upper_bound}))
                .toEqual([asset_id]);
        });

        txit('filters by date range', async () => {
            await client.createAsset();

            const after = `${client.getId()}`;

            const {asset_id} = await client.createAsset();
            const before = `${client.getId()}`;

            await client.createAsset();

            expect(await getAssetIds({after, before}))
                .toEqual([asset_id]);
        });
    });

    afterAll(async () => {
        await client.end();
    });
});
