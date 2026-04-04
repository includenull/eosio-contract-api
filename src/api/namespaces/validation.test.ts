import { filterQueryArgs } from './validation.js';
import { ApiError } from '../error.js';
import { toInt } from '../../utils/index.js';

describe('filterQueryArgs', () => {

    it('removes values that are not defined in the filter', async () => {
        const result = await filterQueryArgs({a: 1, b: 2} as any, {a: {type: 'string'}});

        expect(Object.keys(result)).toEqual(['a']);
    });

    it('returns the default value when the value is null', async () => {
        const result = await filterQueryArgs({a: null}, {a: {type: 'string', default: 1}});

        expect(result.a).toBe(1);
    });

    it('returns the default value when the value is undefined', async () => {
        const result = await filterQueryArgs({a: undefined}, {a: {type: 'string', default: 1}});

        expect(result.a).toBe(1);
    });

    it('returns the default value for arrays when the value is an empty string', async () => {
        const result = await filterQueryArgs({a: ''}, {a: {type: 'string[]', default: [1]}});

        expect(result.a).toEqual([1]);
    });

    it('returns an empty array for arrays when the value is an empty string', async () => {
        const result = await filterQueryArgs({a: ''}, {a: {type: 'string[]'}});

        expect(result.a).toEqual([]);
    });

    it('returns an empty array for arrays when the value is not set', async () => {
        const result = await filterQueryArgs({}, {a: {type: 'int[]'}});

        expect(result.a).toEqual([]);
    });

    it('throws error when value is not in allowedValues', async () => {
        try {
            await filterQueryArgs({a: 'A'}, {a: {type: 'string', allowedValues: ['a']}});
            throw new Error('expected rejection');
        } catch (e) {
            expect(e).toBeInstanceOf(ApiError);
            expect((e as ApiError).code).toBe(400);
            expect((e as ApiError).message).toBe('Invalid value for parameter a');
        }
    });

    it('throws error when array value is not in allowedValues', async () => {
        try {
            await filterQueryArgs({a: 'b'}, {a: {type: 'int[]', allowedValues: ['B']}});
            throw new Error('expected rejection');
        } catch (e) {
            expect((e as ApiError).message).toBe('Invalid value for parameter a');
            expect(e).toBeInstanceOf(ApiError);
            expect((e as ApiError).code).toBe(400);
        }
    });

    it('throws error when array value is not valid', async () => {
        for (const value of ['a', '1,a', '1,,2']) {
            try {
                await filterQueryArgs({a: value}, {a: {type: 'int[]'}});
                throw new Error('expected rejection');
            } catch (e) {
                expect((e as ApiError).message).toBe('Invalid value for parameter a');
                expect(e).toBeInstanceOf(ApiError);
                expect((e as ApiError).code).toBe(400);
            }
        }
    });

    it('allows valid values that are in allowedValues', async () => {
        for (const value of ['a']) {
            const {a} = await filterQueryArgs({a: value}, {a: {type: 'string', allowedValues: ['a']}});
            expect(a).toEqual(value);
        }
    });

    describe('int type', () => {

        it('allows valid int values', async () => {
            for (const value of ['1', '9223372036854775807', '-1']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'int'}});
                expect(a).toEqual(toInt(value));
            }
        });

        it('allows valid array int values', async () => {
            for (const value of ['1,9223372036854775807,-1']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'int[]'}});
                expect(a).toEqual(value.split(',').map(toInt));
            }
        });

        it('throws errors for invalid int values', async () => {
            for (const value of ['a', '1.1', '1a']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'int'}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

        it('throws error when int values are out of bounds', async () => {
            for (const value of ['1', '4']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'int', min: 2, max: 3}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

    });

    describe('string type', () => {

        it('allows valid string values', async () => {
            for (const value of ['a']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'string'}});
                expect(a).toEqual(value);
            }
        });

        it('allows valid array string values', async () => {
            for (const value of ['a,2']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'string[]'}});
                expect(a).toEqual(value.split(','));
            }
        });

        it('throws error when string values are out of bounds', async () => {
            for (const value of ['a', 'abcd']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'string', min: 2, max: 3}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

    });

    describe('float type', () => {

        it('allows valid float values', async () => {
            for (const value of ['0.1', '1', '1.1', '-0.1']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'float'}});
                expect(a).toEqual(parseFloat(value));
            }
        });

        it('allows valid array float values', async () => {
            for (const value of ['0.1,1,1.1,-0.1']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'float[]'}});
                expect(a).toEqual(value.split(',').map(parseFloat));
            }
        });

        it('throws errors for invalid float values', async () => {
            for (const value of ['a', '..1', '1a', '1..']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'float'}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

        it('throws error when float values are out of bounds', async () => {
            for (const value of ['1.3', '3.5']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'float', min: 1.4, max: 3.4}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

    });

    describe('bool type', () => {

        it('allows valid bool values', async () => {
            for (const value of ['true', '1', 'false', '0']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'bool'}});
                expect(a).toEqual(['true', '1'].includes(value));
            }
        });

        it('allows valid array bool values', async () => {
            const {a} = await filterQueryArgs({a: 'true,1,false,0'}, {a: {type: 'bool[]'}});

            expect(a).toEqual([true, true, false, false]);
        });

        it('throws errors for invalid bool values', async () => {
            for (const value of ['a', 'FALSE', 'TRUE', '2']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'bool'}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

    });

    describe('name type', () => {

        it('allows valid name values', async () => {
            for (const value of ['a', '12345.abcdezj']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'name'}});
                expect(a).toEqual(value);
            }
        });

        it('allows valid array name values', async () => {
            for (const value of ['a,12345.abcdezj']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'name[]'}});
                expect(a).toEqual(value.split(','));
            }
        });

        it('throws errors for invalid name values', async () => {
            for (const value of ['6', '12345.abcdezz', '12345.abcdezja']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'name'}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

    });

    describe('id type', () => {

        it('allows valid id values', async () => {
            for (const value of ['123', 'null', '99999999999999999999999999999999999999999999999999999999999999999999999999']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'id'}});
                expect(a).toEqual(value);
            }
        });

        it('allows valid array name values', async () => {
            for (const value of ['123,null,99999999999999999999999999999999999999999999999999999999999999999999999999']) {
                const {a} = await filterQueryArgs({a: value}, {a: {type: 'id[]'}});
                expect(a).toEqual(value.split(','));
            }
        });

        it('throws errors for invalid id values', async () => {
            for (const value of ['1e9', 'a']) {
                try {
                    await filterQueryArgs({a: value}, {a: {type: 'id'}});
                    throw new Error('expected rejection');
                } catch (e) {
                    expect((e as ApiError).message).toBe('Invalid value for parameter a');
                    expect(e).toBeInstanceOf(ApiError);
                    expect((e as ApiError).code).toBe(400);
                }
            }
        });

    });
});
