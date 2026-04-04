import AtomicAssetsHandler, { AtomicAssetsUpdatePriority } from '../index.js';
import DataProcessor from '../../../processor.js';
import { ContractDBTransaction } from '../../../database.js';
import { EosioContractRow } from '../../../../types/eosio.js';
import { ShipBlock } from '../../../../types/ship.js';
import { eosioTimestampToDate, splitEosioToken } from '../../../../utils/eosio.js';
import { BalancesTableRow } from '../types/tables.js';

export function balanceProcessor(core: AtomicAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.atomicassets_account;

    destructors.push(processor.onContractRow(
        contract, 'balances',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<BalancesTableRow>): Promise<void> => {
            await db.delete('atomicassets_balances', {
                str: 'contract = $1 AND owner = $2',
                values: [contract, delta.value.owner]
            });

            if (delta.present && delta.value.quantities.length > 0) {
                await db.insert('atomicassets_balances', delta.value.quantities.map(quantity => {
                    const token = splitEosioToken(quantity);

                    return {
                        contract: contract,
                        owner: delta.value.owner,
                        token_symbol: token.token_symbol,
                        amount: token.amount,
                        updated_at_block: block.block_num,
                        updated_at_time: eosioTimestampToDate(block.timestamp).getTime(),
                    };
                }), ['contract', 'owner']);
            }
        }, AtomicAssetsUpdatePriority.TABLE_BALANCES.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}
