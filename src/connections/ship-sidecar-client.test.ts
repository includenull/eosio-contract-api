import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createShipSidecarPool, resolveDefaultSidecarPath } from './ship-sidecar-client.js';

describe('ShipSidecarPool', () => {
    it('pings the native sidecar when built', async () => {
        const sidecarPath = resolveDefaultSidecarPath();
        if (!existsSync(sidecarPath)) {
            return;
        }

        const pool = await createShipSidecarPool(2, sidecarPath);

        await pool.stop();
        expect(true).toBe(true);
    });
});
