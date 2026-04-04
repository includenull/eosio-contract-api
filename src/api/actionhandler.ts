import { DB } from './server.js';
import { RequestValues } from './namespaces/utils.js';

export interface ActionHandlerContext<T> {
    pathParams: RequestValues,
    db: DB,
    coreArgs: T
}

export type ActionHandler = (params: RequestValues, ctx: ActionHandlerContext<any>) => Promise<any>;
