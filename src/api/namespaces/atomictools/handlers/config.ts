import { RequestValues } from '../../utils.js';
import { AtomicToolsContext } from '../index.js';

export async function getConfigAction(params: RequestValues, ctx: AtomicToolsContext): Promise<any> {
    const configQuery = await ctx.db.query(
        'SELECT * FROM atomictools_config WHERE tools_contract = $1',
        [ctx.coreArgs.atomictools_account]
    );

    return {
        atomictools_contract: ctx.coreArgs.atomictools_account,
        atomicassets_contract: ctx.coreArgs.atomicassets_account,
        version: configQuery.rows[0].version
    };
}
