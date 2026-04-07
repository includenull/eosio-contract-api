import { createRequire } from 'node:module';

import { ABI, Bytes, Serializer } from '@wharfkit/antelope';

type AbieosModule = typeof import('@eosrio/node-abieos');

const require = createRequire(import.meta.url);
let abieosModule: AbieosModule | null | undefined;

function tryLoadAbieos(): AbieosModule | null {
    if (abieosModule !== undefined) {
        return abieosModule;
    }

    try {
        abieosModule = require('@eosrio/node-abieos') as AbieosModule;
    } catch {
        abieosModule = null;
    }

    return abieosModule;
}

function deserializeAbiWithWharfKit(data: Uint8Array): ABI {
    return Serializer.decode({ data: Bytes.from(data), type: ABI });
}

export function deserializeAbi(data: Uint8Array): ABI {
    const abieosMod = tryLoadAbieos();
    if (abieosMod) {
        try {
            const abieos = abieosMod.Abieos.getInstance();
            const buf = Buffer.from(data);
            const json =
                abieos.binToJson('', 'abi_def', buf) ??
                abieos.binToJson('__abi', 'abi_def', buf);
            return ABI.from(json as Parameters<typeof ABI.from>[0]);
        } catch {
            // Fall back to WharfKit if ABIEOS isn't available/compatible at runtime.
        }
    }

    return deserializeAbiWithWharfKit(data);
}

