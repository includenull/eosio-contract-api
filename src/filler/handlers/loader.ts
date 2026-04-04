import { ContractHandler } from './interfaces.js';

import AtomicAssetsHandler from './atomicassets/index.js';
import AtomicMarketHandler from './atomicmarket/index.js';
import AtomicToolsHandler from './atomictools/index.js';
import DelphiOracleHandler from './delphioracle/index.js';
import SimpleAssetsHandler from './simpleassets/index.js';

export const handlers: (typeof ContractHandler)[] = [
    AtomicAssetsHandler,
    AtomicMarketHandler,
    AtomicToolsHandler,
    DelphiOracleHandler,
    SimpleAssetsHandler
];
