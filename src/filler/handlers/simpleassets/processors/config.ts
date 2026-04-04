import { SimpleAssetsUpdatePriority } from '../index.js';
import DataProcessor from '../../../processor.js';
import { ContractDBTransaction } from '../../../database.js';
import { EosioContractRow } from '../../../../types/eosio.js';
import { ShipBlock } from '../../../../types/ship.js';
import { TokenConfigsTableRow } from '../types/tables.js';
import SimpleAssetsHandler from '../index.js';

export function configProcessor(core: SimpleAssetsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.simpleassets_account;

    destructors.push(processor.onContractRow(
        contract, 'tokenconfigs',
        async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<TokenConfigsTableRow>): Promise<void> => {
            if (!delta.present) {
                throw new Error('SimpleAassets: tokenconfigs row was deleted. Should not be possible by contract');
            }

            if (core.tokenconfigs.version !== delta.value.version) {
                await db.update('simpleassets_config', {
                    version: delta.value.version
                }, {
                    str: 'contract = $1',
                    values: [contract]
                }, ['contract']);
            }

            core.tokenconfigs = delta.value;
        }, SimpleAssetsUpdatePriority.TABLE_CONFIG.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}
