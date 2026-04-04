import { ApiNamespace } from './interfaces.js';
import { AtomicAssetsNamespace } from './atomicassets/index.js';
import { AtomicMarketNamespace } from './atomicmarket/index.js';
import { AtomicToolsNamespace } from './atomictools/index.js';

export const namespaces: (typeof ApiNamespace)[] = [
    AtomicAssetsNamespace,
    AtomicMarketNamespace,
    AtomicToolsNamespace
];
