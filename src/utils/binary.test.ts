import { deserializeUInt, serializeUInt } from './binary.js';
import { deserializeEosioName, serializeEosioName } from './eosio.js';

describe('binary utility', () => {
    it('uint serialization', async () => {
        const unsignedNumber = BigInt(0xFF00_0000);
        const signedNumber = BigInt(-16777216);

        expect(serializeUInt(unsignedNumber, 4).toString(10)).toBe(signedNumber.toString(10));
        expect(deserializeUInt(signedNumber, 4).toString(10)).toBe(unsignedNumber.toString(10));
    });

    it('eosio name serialization', async () => {
        expect(serializeEosioName('eosio').toString()).toBe('15347797');
        expect(deserializeEosioName('15347797').toString()).toBe('eosio');

        expect(serializeEosioName('eosio.token').toString()).toBe('46868006049558613');
        expect(deserializeEosioName('46868006049558613').toString()).toBe('eosio.token');

        expect(serializeEosioName('pinknetworkx').toString()).toBe('-3395250964074485845');
        expect(deserializeEosioName('-3395250964074485845').toString()).toBe('pinknetworkx');
    });
});
