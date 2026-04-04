
import {encodeDatabaseJson} from './utils.js';

describe('utils', () => {
    describe('encodeDatabaseJson', () => {
        it('replaces NULL(\\u0000) characters for blank space', () => {
            expect(encodeDatabaseJson({
                a: '\u0000',
                b: 'b',
                c: 1,
            })).toBe(JSON.stringify({
                a: ' ',
                b: 'b',
                c: 1,
            }));
        });
    });
});