import { AssetFiller } from '../atomicassets/filler.js';
import { formatAsset } from '../atomicassets/format.js';
import { DB } from '../../server.js';

export async function fillLinks(db: DB, assetContract: string, links: any[]): Promise<any[]> {
    const assetIDs: string[] = [];

    for (const link of links) {
        assetIDs.push(...link.assets);
    }

    const filler = new AssetFiller(db, assetContract, assetIDs, formatAsset, 'atomicassets_assets_master');

    return await Promise.all(links.map(async (link) => {
        link.assets = await filler.fill(link.assets);

        return link;
    }));
}
