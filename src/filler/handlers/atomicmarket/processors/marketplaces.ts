import DataProcessor from '../../../processor.js';
import { ContractDBTransaction } from '../../../database.js';
import { EosioContractRow } from '../../../../types/eosio.js';
import { ShipBlock } from '../../../../types/ship.js';
import { eosioTimestampToDate } from '../../../../utils/eosio.js';
import { MarketplacesTableRow } from '../types/tables.js';
import AtomicMarketHandler, { AtomicMarketUpdatePriority } from '../index.js';

export function marketplaceProcessor(core: AtomicMarketHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicmarket_account;

    destructors.push(processor.onContractRow(
        contract, 'marketplaces',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<MarketplacesTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('AtomicMarket: Marketplace deleted. Should not be possible');
            }

            await db.replace('atomicmarket_marketplaces', {
                market_contract: core.args.atomicmarket_account,
                marketplace_name: delta.value.marketplace_name,
                creator: delta.value.creator,
                created_at_block: block.block_num,
                created_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['market_contract', 'marketplace_name'], ['created_at_block', 'created_at_time']);
        }, AtomicMarketUpdatePriority.TABLE_MARKETPLACES.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}
