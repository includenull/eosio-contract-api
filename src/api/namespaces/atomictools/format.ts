import { Bytes, KeyType, PublicKey } from '@wharfkit/antelope';

export function formatLink(row: any): any {
    const data = {...row};

    const pk = PublicKey.from({
        type: KeyType.from(data['key_type']),
        compressed: Bytes.from(data['key_data']).array,
    });

    data['public_key'] = pk.type === KeyType.K1 ? pk.toLegacyString('EOS') : pk.toString();

    delete data['key_type'];
    delete data['key_data'];

    return data;
}
