import AtomicToolsHandler, { AtomicToolsUpdatePriority } from '../index.js';
import DataProcessor from '../../../processor.js';
import { ContractDBTransaction } from '../../../database.js';
import { ShipBlock } from '../../../../types/ship.js';
import { EosioActionTrace, EosioTransaction } from '../../../../types/eosio.js';
import { CancelLinkActionData, ClaimLinkActionData, LogLinkStartActionData, LogNewLinkActionData } from '../types/actions.js';

export function logProcessor(core: AtomicToolsHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];

    destructors.push(processor.onActionTrace(
        core.args.atomictools_account, 'lognewlink',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewLinkActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                link_id: trace.act.data.link_id
            });
        }, AtomicToolsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        core.args.atomictools_account, 'loglinkstart',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogLinkStartActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                link_id: trace.act.data.link_id
            });
        }, AtomicToolsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        core.args.atomictools_account, 'cancellink',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<CancelLinkActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                link_id: trace.act.data.link_id
            });
        }, AtomicToolsUpdatePriority.LOGS.valueOf()
    ));

    destructors.push(processor.onActionTrace(
        core.args.atomictools_account, 'claimlink',
        async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<ClaimLinkActionData>): Promise<void> => {
            await db.logTrace(block, tx, trace, {
                link_id: trace.act.data.link_id,
                claimer_signature: trace.act.data.link_id
            });
        }, AtomicToolsUpdatePriority.LOGS.valueOf()
    ));

    return (): any => destructors.map(fn => fn());
}
