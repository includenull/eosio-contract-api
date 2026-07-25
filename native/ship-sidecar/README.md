# SHIP deserialize sidecar

Native C++ process using [abieos](https://github.com/AntelopeIO/abieos) for SHIP binary deserialization. Node communicates over stdin/stdout with a length-prefixed binary protocol (v2, MessagePack payloads).

## Phase 2 features

- **MessagePack responses** instead of JSON strings (`@msgpack/msgpack` decode on Node)
- **Process pool** — one sidecar process per `ds_ship_threads` (parallel like Piscina)
- **Block batch IPC** — one call deserializes block + traces + deltas
- **Native delta whitelist** — `contract_row` rows deserialized in C++ using the SHIP delta whitelist
- **Contract ABI decode** — register contract ABIs and batch-deserialize action/row payloads in C++
- **Envelope bypass (Node)** — with sidecar enabled, SHIP websocket frames are parsed with `Serializer.decode` only (no `objectify` / `arrayToHex` on trace and delta blobs)

## Phase 3 features

- **Combined IPC (`op 6`)** — raw SHIP websocket frame in, filtered block/traces/deltas + metadata out (one sidecar call per block)
- **Trace allowlist** — only deserialize action traces registered by handlers (+ `eosio:setabi` / `setcode`)
- **Table allowlist** — only deserialize `contract_row` deltas for watched `(code, table)` pairs
- **Slimmer traces** — drops `console` and empty optional fields before msgpack encode
- **ABI preload** — watched contract ABIs loaded at reader startup
- **Scoped ABI persistence** — `setabi` / `setcode` DB writes only for watched contracts

## Build

```bash
yarn build:sidecar
yarn install   # pulls @msgpack/msgpack
yarn build
```

## Enable in filler

```json
{
  "ds_use_sidecar": true,
  "ds_ship_threads": 10,
  "ds_contract_threads": 10
}
```

`ds_contract_threads` controls parallel contract ABI deserialize when sidecar is disabled (Piscina workers). With sidecar enabled, contract deserialize uses the same sidecar process pool as SHIP.

## Protocol v2

Request header (20 bytes, LE): magic `SHIP`, version `2`, request_id, op, payload_len.

Response body: status u32, format u32 (`1` = msgpack), payload_len u32, payload.

Ops: `0` ping, `1` deserialize, `2` batch, `3` deserialize block, `4` set ABI, `5` deserialize contract batch, `6` process ship message, `255` shutdown.

Block op payload: block_type, block_bytes, traces_bytes, deltas_bytes, whitelist_count, whitelist[].

Process ship message payload: raw ship `result` bytes, delta type whitelist, trace filters `(contract, action)`, table filters `(code, table)`.

Response msgpack object includes `{ head, this_block, block, traces, deltas, deltas_processed: true, ... }` for op 6.

Set ABI payload: contract name, ABI JSON string.

Contract batch payload: row_count, then per row: contract, type, binary data.
