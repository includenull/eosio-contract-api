import DataProcessor from '../../../processor.js';
import { ContractDBTransaction } from '../../../database.js';
import { EosioContractRow } from '../../../../types/eosio.js';
import { ShipBlock } from '../../../../types/ship.js';
import { eosioTimestampToDate, splitEosioToken } from '../../../../utils/eosio.js';
import { BalancesTableRow } from '../types/tables.js';
import AtomicMarketHandler, { AtomicMarketUpdatePriority } from '../index.js';

export function balanceProcessor(core: AtomicMarketHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicmarket_account;

    destructors.push(processor.onContractRow(
        contract, 'balances',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<BalancesTableRow>): Promise<void> => {
            await db.delete('atomicmarket_balances', {
                str: 'market_contract = $1 AND owner = $2',
                values: [contract, delta.value.owner]
            });

            if (delta.present && delta.value.quantities.length > 0) {
                await db.insert('atomicmarket_balances', delta.value.quantities.map(quantity => {
                    const token = splitEosioToken(quantity);

                    return {
                        market_contract: contract,
                        owner: delta.value.owner,
                        token_symbol: token.token_symbol,
                        amount: token.amount,
                        updated_at_block: block.block_num,
                        updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                    };
                }), ['market_contract', 'owner']);
            }
        }, AtomicMarketUpdatePriority.TABLE_BALANCES.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}
