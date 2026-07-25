#pragma once

#include "hex_utils.hpp"
#include "json_msgpack.hpp"
#include "name_utils.hpp"

#include <abieos.h>

#include <cstdint>
#include <cstring>
#include <ctime>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace ship_sidecar {

constexpr uint64_t kShipContract = 2;

struct TraceFilterRule {
    std::string contract;
    std::string action;
};

struct TableFilterRule {
    std::string code;
    std::string table;
};

class EosBinReader {
public:
    EosBinReader(const char* data, size_t size) : pos_(data), end_(data + size) {}

    bool eof() const { return pos_ >= end_; }

    bool readVaruint32(uint32_t& value) {
        value = 0;
        int shift = 0;
        while (true) {
            if (pos_ >= end_) {
                return false;
            }
            const uint8_t byte = static_cast<uint8_t>(*pos_++);
            value |= static_cast<uint32_t>(byte & 0x7f) << shift;
            if ((byte & 0x80) == 0) {
                return true;
            }
            shift += 7;
            if (shift > 28) {
                return false;
            }
        }
    }

    bool readU8(uint8_t& value) {
        if (pos_ >= end_) {
            return false;
        }
        value = static_cast<uint8_t>(*pos_++);
        return true;
    }

    bool readU16(uint16_t& value) {
        if (static_cast<size_t>(end_ - pos_) < 2) {
            return false;
        }
        std::memcpy(&value, pos_, 2);
        pos_ += 2;
        return true;
    }

    bool readU32(uint32_t& value) {
        if (static_cast<size_t>(end_ - pos_) < 4) {
            return false;
        }
        std::memcpy(&value, pos_, 4);
        pos_ += 4;
        return true;
    }

    bool readU64(uint64_t& value) {
        if (static_cast<size_t>(end_ - pos_) < 8) {
            return false;
        }
        std::memcpy(&value, pos_, 8);
        pos_ += 8;
        return true;
    }

    bool readI64(int64_t& value) {
        uint64_t raw = 0;
        if (!readU64(raw)) {
            return false;
        }
        value = static_cast<int64_t>(raw);
        return true;
    }

    bool readName(uint64_t& value) {
        return readU64(value);
    }

    bool readBytes(std::vector<char>& out) {
        uint32_t size = 0;
        if (!readVaruint32(size) || static_cast<size_t>(end_ - pos_) < size) {
            return false;
        }
        out.assign(pos_, pos_ + size);
        pos_ += size;
        return true;
    }

    bool skipBytes() {
        std::vector<char> ignored;
        return readBytes(ignored);
    }

    bool readChecksum256(std::string& hex_out) {
        if (static_cast<size_t>(end_ - pos_) < 32) {
            return false;
        }
        hex_out = bytesToHex(pos_, 32);
        pos_ += 32;
        return true;
    }

    bool skipChecksum256() {
        if (static_cast<size_t>(end_ - pos_) < 32) {
            return false;
        }
        pos_ += 32;
        return true;
    }

    bool skipString() {
        return skipBytes();
    }

    bool skipName() {
        uint64_t ignored = 0;
        return readName(ignored);
    }

    bool skipPermissionLevels() {
        uint32_t count = 0;
        if (!readVaruint32(count)) {
            return false;
        }
        for (uint32_t i = 0; i < count; ++i) {
            if (!skipName() || !skipName()) {
                return false;
            }
        }
        return true;
    }

    bool skipAccountDeltas() {
        uint32_t count = 0;
        if (!readVaruint32(count)) {
            return false;
        }
        for (uint32_t i = 0; i < count; ++i) {
            int64_t ignored = 0;
            if (!skipName() || !readI64(ignored)) {
                return false;
            }
        }
        return true;
    }

    bool skipOptionalString() {
        uint8_t present = 0;
        if (!readU8(present)) {
            return false;
        }
        return !present || skipString();
    }

    bool skipOptionalU64() {
        uint8_t present = 0;
        if (!readU8(present)) {
            return false;
        }
        if (!present) {
            return true;
        }
        uint64_t ignored = 0;
        return readU64(ignored);
    }

    bool skipOptionalAccountDelta() {
        uint8_t present = 0;
        if (!readU8(present)) {
            return false;
        }
        if (!present) {
            return true;
        }
        int64_t ignored = 0;
        return skipName() && readI64(ignored);
    }

    bool skipActionReceiptBody() {
        if (!skipName() || !skipChecksum256()) {
            return false;
        }
        uint64_t ignored = 0;
        if (!readU64(ignored) || !readU64(ignored)) {
            return false;
        }
        uint32_t auth_count = 0;
        if (!readVaruint32(auth_count)) {
            return false;
        }
        for (uint32_t i = 0; i < auth_count; ++i) {
            if (!skipName() || !readU64(ignored)) {
                return false;
            }
        }
        uint32_t code_sequence = 0;
        uint32_t abi_sequence = 0;
        return readVaruint32(code_sequence) && readVaruint32(abi_sequence);
    }

    bool skipActionReceiptVariant() {
        uint32_t variant_index = 0;
        if (!readVaruint32(variant_index) || variant_index != 0) {
            return false;
        }
        return skipActionReceiptBody();
    }

    const char* cursor() const { return pos_; }

    size_t remaining() const { return static_cast<size_t>(end_ - pos_); }

    bool advance(size_t count) {
        if (remaining() < count) {
            return false;
        }
        pos_ += count;
        return true;
    }

private:
    const char* pos_;
    const char* end_;
};

inline size_t abieosMinDecodeSize(
    abieos_context* context,
    uint64_t contract,
    const char* type,
    const char* data,
    size_t max_size
) {
    if (max_size == 0) {
        return 0;
    }

    size_t lo = 1;
    size_t hi = max_size;
    size_t result = 0;

    while (lo <= hi) {
        const size_t mid = (lo + hi) / 2;
        const char* json = abieos_bin_to_json(context, contract, type, data, mid);
        if (json) {
            result = mid;
            if (mid == 0) {
                break;
            }
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    return result;
}

inline bool skipExtensions(EosBinReader& reader);
inline bool skipSignatures(EosBinReader& reader);
inline bool skipActionTraceVariant(EosBinReader& reader);
inline bool skipTransactionTraceTail(
    abieos_context* context,
    EosBinReader& reader,
    const char** failure_step = nullptr
);

inline bool skipBytesArray(EosBinReader& reader) {
    uint32_t count = 0;
    if (!reader.readVaruint32(count)) {
        return false;
    }
    for (uint32_t i = 0; i < count; ++i) {
        if (!reader.skipBytes()) {
            return false;
        }
    }
    return true;
}

inline bool skipAction(EosBinReader& reader) {
    return reader.skipName() && reader.skipName() && reader.skipPermissionLevels() && reader.skipBytes();
}

inline bool skipActionArray(EosBinReader& reader) {
    uint32_t count = 0;
    if (!reader.readVaruint32(count)) {
        return false;
    }
    for (uint32_t i = 0; i < count; ++i) {
        if (!skipAction(reader)) {
            return false;
        }
    }
    return true;
}

inline bool skipPrunableData(EosBinReader& reader) {
    uint8_t present = 0;
    if (!reader.readU8(present)) {
        return false;
    }
    if (present == 0) {
        return true;
    }

    uint32_t variant_index = 0;
    if (!reader.readVaruint32(variant_index)) {
        return false;
    }

    if (variant_index == 0) {
        return skipSignatures(reader) && skipBytesArray(reader);
    }

    return variant_index == 1;
}

inline bool skipPartialTransactionV0(EosBinReader& reader) {
    uint32_t expiration = 0;
    uint16_t ref_block_num = 0;
    uint32_t ref_block_prefix = 0;
    uint32_t max_net_usage_words = 0;
    uint8_t max_cpu_usage_ms = 0;
    uint32_t delay_sec = 0;

    if (!reader.readU32(expiration) || !reader.readU16(ref_block_num) || !reader.readU32(ref_block_prefix) ||
        !reader.readVaruint32(max_net_usage_words) || !reader.readU8(max_cpu_usage_ms) ||
        !reader.readVaruint32(delay_sec) || !skipExtensions(reader) || !skipSignatures(reader) ||
        !skipBytesArray(reader)) {
        return false;
    }

    return true;
}

inline bool skipPartialTransactionV1(EosBinReader& reader) {
    uint32_t expiration = 0;
    uint16_t ref_block_num = 0;
    uint32_t ref_block_prefix = 0;
    uint32_t max_net_usage_words = 0;
    uint8_t max_cpu_usage_ms = 0;
    uint32_t delay_sec = 0;

    if (!reader.readU32(expiration) || !reader.readU16(ref_block_num) || !reader.readU32(ref_block_prefix) ||
        !reader.readVaruint32(max_net_usage_words) || !reader.readU8(max_cpu_usage_ms) ||
        !reader.readVaruint32(delay_sec) || !skipActionArray(reader) || !skipActionArray(reader) ||
        !skipExtensions(reader) || !skipPrunableData(reader)) {
        return false;
    }

    return true;
}

inline bool skipOptionalPartialTransaction(abieos_context* context, EosBinReader& reader) {
    const char* field_start = reader.cursor();
    const size_t field_remaining = reader.remaining();
    if (field_remaining == 0) {
        return false;
    }

    const uint8_t present = static_cast<uint8_t>(field_start[0]);
    if (present == 0) {
        return reader.advance(1);
    }

    const size_t decoded =
        abieosMinDecodeSize(context, kShipContract, "partial_transaction?", field_start, field_remaining);
    if (decoded == 0 || decoded > field_remaining) {
        return false;
    }

    return reader.advance(decoded);
}

inline bool skipOptionalTransactionTrace(abieos_context* context, EosBinReader& reader) {
    const char* field_start = reader.cursor();
    const size_t field_remaining = reader.remaining();
    if (field_remaining == 0) {
        return false;
    }

    const uint8_t present = static_cast<uint8_t>(field_start[0]);
    if (present == 0) {
        return reader.advance(1);
    }

    const size_t decoded =
        abieosMinDecodeSize(context, kShipContract, "transaction_trace?", field_start, field_remaining);
    if (decoded == 0 || decoded > field_remaining) {
        return false;
    }

    return reader.advance(decoded);
}

inline bool skipTransactionTraceTail(
    abieos_context* context,
    EosBinReader& reader,
    const char** failure_step
) {
    if (!reader.skipOptionalAccountDelta()) {
        if (failure_step) {
            *failure_step = "account_ram_delta";
        }
        return false;
    }

    if (!reader.skipOptionalString()) {
        if (failure_step) {
            *failure_step = "except";
        }
        return false;
    }

    if (!reader.skipOptionalU64()) {
        if (failure_step) {
            *failure_step = "error_code";
        }
        return false;
    }

    if (!skipOptionalTransactionTrace(context, reader)) {
        if (failure_step) {
            *failure_step = "failed_dtrx_trace";
        }
        return false;
    }

    if (!skipOptionalPartialTransaction(context, reader)) {
        if (failure_step) {
            *failure_step = "partial";
        }
        return false;
    }

    return true;
}

inline std::string formatBlockTimestamp(uint32_t slot) {
    const int64_t total_ms = static_cast<int64_t>(946684800000LL) + static_cast<int64_t>(slot) * 500LL;
    const time_t seconds = static_cast<time_t>(total_ms / 1000);
    const int millis = static_cast<int>(total_ms % 1000);

    std::tm tm_value {};
#if defined(_WIN32)
    gmtime_s(&tm_value, &seconds);
#else
    gmtime_r(&seconds, &tm_value);
#endif

    char buffer[32];
    std::snprintf(
        buffer,
        sizeof(buffer),
        "%04d-%02d-%02dT%02d:%02d:%02d.%03d",
        tm_value.tm_year + 1900,
        tm_value.tm_mon + 1,
        tm_value.tm_mday,
        tm_value.tm_hour,
        tm_value.tm_min,
        tm_value.tm_sec,
        millis);
    return buffer;
}

inline void appendMsgpackHexString(std::vector<char>& out, const char* data, size_t size) {
    const std::string hex = bytesToHex(data, size);
    appendMsgpackString(out, hex.c_str(), hex.size());
}

inline void appendMsgpackUInt64String(std::vector<char>& out, uint64_t value) {
    char buffer[32];
    const int len = std::snprintf(buffer, sizeof(buffer), "%llu", static_cast<unsigned long long>(value));
    appendMsgpackString(out, buffer, static_cast<size_t>(len));
}

inline bool traceAllowedBinary(
    const std::string& contract,
    const std::string& action,
    const std::vector<TraceFilterRule>& filters
) {
    if (filters.empty()) {
        return true;
    }
    for (const auto& filter : filters) {
        if (filter.contract == contract && (filter.action == "*" || filter.action == action)) {
            return true;
        }
    }
    return false;
}

inline bool tableAllowedBinary(
    const std::string& code,
    const std::string& table,
    const std::vector<TableFilterRule>& filters
) {
    if (filters.empty()) {
        return true;
    }
    for (const auto& filter : filters) {
        if (filter.code == code && (filter.table == "*" || filter.table == table)) {
            return true;
        }
    }
    return false;
}

struct SlimActionTrace {
    uint32_t action_ordinal = 0;
    uint32_t creator_action_ordinal = 0;
    bool has_receipt = false;
    std::string receipt_receiver;
    std::string act_digest;
    uint64_t global_sequence = 0;
    std::string receiver;
    std::string account;
    std::string action;
    std::vector<std::pair<std::string, std::string>> authorization;
    std::vector<char> act_data;
};

inline bool skipExtensions(EosBinReader& reader) {
    uint32_t count = 0;
    if (!reader.readVaruint32(count)) {
        return false;
    }
    for (uint32_t i = 0; i < count; ++i) {
        uint16_t type = 0;
        if (!reader.readU16(type) || !reader.skipBytes()) {
            return false;
        }
    }
    return true;
}

inline bool skipSignatures(EosBinReader& reader) {
    uint32_t count = 0;
    if (!reader.readVaruint32(count)) {
        return false;
    }
    for (uint32_t i = 0; i < count; ++i) {
        if (!reader.skipBytes()) {
            return false;
        }
    }
    return true;
}

inline bool skipOptionalActionReceipt(EosBinReader& reader) {
    uint8_t present = 0;
    if (!reader.readU8(present)) {
        return false;
    }
    if (present == 0) {
        return true;
    }

    const char* start = reader.cursor();
    const size_t remaining = reader.remaining();
    if (remaining == 0) {
        return false;
    }

    // action_receipt is a single-member variant, so the index is often omitted.
    if (remaining >= 1) {
        const uint8_t first = static_cast<uint8_t>(start[0]);
        if (first <= 1) {
            EosBinReader with_index(start, remaining);
            if (with_index.skipActionReceiptVariant()) {
                return reader.advance(static_cast<size_t>(with_index.cursor() - start));
            }
        }
    }

    EosBinReader body_only(start, remaining);
    if (body_only.skipActionReceiptBody()) {
        return reader.advance(static_cast<size_t>(body_only.cursor() - start));
    }

    return false;
}

inline bool skipActionTraceCommonTail(EosBinReader& reader) {
    uint8_t context_free = 0;
    int64_t elapsed = 0;
    if (!reader.readU8(context_free) || !reader.readI64(elapsed) || !reader.skipString()) {
        return false;
    }
    if (!reader.skipAccountDeltas()) {
        return false;
    }
    if (!reader.skipOptionalString()) {
        return false;
    }
    return reader.skipOptionalU64();
}

inline bool skipActionTraceV0Body(EosBinReader& reader) {
    uint32_t ignored = 0;
    if (!reader.readVaruint32(ignored) || !reader.readVaruint32(ignored)) {
        return false;
    }
    if (!skipOptionalActionReceipt(reader)) {
        return false;
    }
    if (!reader.skipName()) {
        return false;
    }
    if (!skipAction(reader)) {
        return false;
    }
    return skipActionTraceCommonTail(reader);
}

inline bool skipActionTraceVariant(EosBinReader& reader) {
    uint32_t variant_index = 0;
    if (!reader.readVaruint32(variant_index)) {
        return false;
    }

    if (variant_index == 0) {
        return skipActionTraceV0Body(reader);
    }

    if (variant_index == 1) {
        return skipActionTraceV0Body(reader) && reader.skipBytes();
    }

    return false;
}

inline bool parseActionReceiptBody(EosBinReader& reader, SlimActionTrace& out) {
    uint64_t receipt_receiver = 0;
    if (!reader.readName(receipt_receiver) || !reader.readChecksum256(out.act_digest) ||
        !reader.readU64(out.global_sequence)) {
        return false;
    }
    out.receipt_receiver = nameToString(receipt_receiver);

    uint64_t recv_sequence = 0;
    if (!reader.readU64(recv_sequence)) {
        return false;
    }

    uint32_t auth_count = 0;
    if (!reader.readVaruint32(auth_count)) {
        return false;
    }
    for (uint32_t i = 0; i < auth_count; ++i) {
        if (!reader.skipName() || !reader.readU64(recv_sequence)) {
            return false;
        }
    }

    uint32_t code_sequence = 0;
    uint32_t abi_sequence = 0;
    return reader.readVaruint32(code_sequence) && reader.readVaruint32(abi_sequence);
}

inline bool parseOptionalActionReceipt(EosBinReader& reader, SlimActionTrace& out) {
    uint8_t has_receipt = 0;
    if (!reader.readU8(has_receipt)) {
        return false;
    }

    out.has_receipt = has_receipt != 0;
    if (!out.has_receipt) {
        return true;
    }

    const char* start = reader.cursor();
    const size_t remaining = reader.remaining();
    if (remaining == 0) {
        return false;
    }

    if (remaining >= 1) {
        const uint8_t first = static_cast<uint8_t>(start[0]);
        if (first <= 1) {
            EosBinReader with_index(start, remaining);
            uint32_t receipt_variant = 0;
            if (with_index.readVaruint32(receipt_variant) && receipt_variant == 0) {
                SlimActionTrace trial;
                if (parseActionReceiptBody(with_index, trial)) {
                    reader.advance(static_cast<size_t>(with_index.cursor() - start));
                    out.receipt_receiver = std::move(trial.receipt_receiver);
                    out.act_digest = std::move(trial.act_digest);
                    out.global_sequence = trial.global_sequence;
                    return true;
                }
            }
        }
    }

    EosBinReader body_only(start, remaining);
    if (!parseActionReceiptBody(body_only, out)) {
        return false;
    }

    return reader.advance(static_cast<size_t>(body_only.cursor() - start));
}

inline bool parseActionTraceV0(EosBinReader& reader, SlimActionTrace& out) {
    if (!reader.readVaruint32(out.action_ordinal) || !reader.readVaruint32(out.creator_action_ordinal)) {
        return false;
    }

    if (!parseOptionalActionReceipt(reader, out)) {
        return false;
    }

    uint64_t receiver_name = 0;
    if (!reader.readName(receiver_name)) {
        return false;
    }
    out.receiver = nameToString(receiver_name);

    uint64_t account_name = 0;
    uint64_t action_name = 0;
    if (!reader.readName(account_name) || !reader.readName(action_name)) {
        return false;
    }
    out.account = nameToString(account_name);
    out.action = nameToString(action_name);

    uint32_t auth_count = 0;
    if (!reader.readVaruint32(auth_count)) {
        return false;
    }
    for (uint32_t i = 0; i < auth_count; ++i) {
        uint64_t actor = 0;
        uint64_t permission = 0;
        if (!reader.readName(actor) || !reader.readName(permission)) {
            return false;
        }
        out.authorization.emplace_back(nameToString(actor), nameToString(permission));
    }

    if (!reader.readBytes(out.act_data)) {
        return false;
    }

    return skipActionTraceCommonTail(reader);
}

inline void appendSlimActionTraceMsgpack(
    std::vector<char>& out,
    const SlimActionTrace& trace
) {
    appendMsgpackArrayHeader(out, 2);
    appendMsgpackString(out, "action_trace_v0", 15);

    const size_t field_count = trace.has_receipt ? 6 : 5;
    appendMsgpackMapHeader(out, field_count);

    appendMsgpackKey(out, "action_ordinal", 14);
    appendMsgpackUint32(out, trace.action_ordinal);

    appendMsgpackKey(out, "creator_action_ordinal", 22);
    appendMsgpackUint32(out, trace.creator_action_ordinal);

    if (trace.has_receipt) {
        appendMsgpackKey(out, "receipt", 7);
        appendMsgpackArrayHeader(out, 2);
        appendMsgpackString(out, "action_receipt_v0", 17);
        appendMsgpackMapHeader(out, 3);
        appendMsgpackKey(out, "receiver", 8);
        appendMsgpackString(out, trace.receipt_receiver.c_str(), trace.receipt_receiver.size());
        appendMsgpackKey(out, "act_digest", 10);
        appendMsgpackString(out, trace.act_digest.c_str(), trace.act_digest.size());
        appendMsgpackKey(out, "global_sequence", 15);
        appendMsgpackUInt64String(out, trace.global_sequence);
    }

    appendMsgpackKey(out, "receiver", 8);
    appendMsgpackString(out, trace.receiver.c_str(), trace.receiver.size());

    appendMsgpackKey(out, "act", 3);
    appendMsgpackMapHeader(out, 4);
    appendMsgpackKey(out, "account", 7);
    appendMsgpackString(out, trace.account.c_str(), trace.account.size());
    appendMsgpackKey(out, "name", 4);
    appendMsgpackString(out, trace.action.c_str(), trace.action.size());
    appendMsgpackKey(out, "authorization", 13);
    appendMsgpackArrayHeader(out, trace.authorization.size());
    for (const auto& auth : trace.authorization) {
        appendMsgpackMapHeader(out, 2);
        appendMsgpackKey(out, "actor", 5);
        appendMsgpackString(out, auth.first.c_str(), auth.first.size());
        appendMsgpackKey(out, "permission", 10);
        appendMsgpackString(out, auth.second.c_str(), auth.second.size());
    }
    appendMsgpackKey(out, "data", 4);
    appendMsgpackHexString(out, trace.act_data.data(), trace.act_data.size());

    appendMsgpackKey(out, "account_ram_deltas", 18);
    appendMsgpackArrayHeader(out, 0);
}

inline void appendSlimTransactionMsgpack(
    std::vector<char>& out,
    const std::string& tx_id,
    const std::vector<std::vector<char>>& action_traces
) {
    appendMsgpackArrayHeader(out, 2);
    appendMsgpackString(out, "transaction_trace_v0", 20);
    appendMsgpackMapHeader(out, 5);
    appendMsgpackKey(out, "id", 2);
    appendMsgpackString(out, tx_id.c_str(), tx_id.size());
    appendMsgpackKey(out, "status", 6);
    appendMsgpackUint32(out, 0);
    appendMsgpackKey(out, "cpu_usage_us", 12);
    appendMsgpackUint32(out, 0);
    appendMsgpackKey(out, "net_usage_words", 15);
    appendMsgpackUint32(out, 0);
    appendMsgpackKey(out, "action_traces", 13);
    appendMsgpackArrayHeader(out, action_traces.size());
    for (const auto& action_trace : action_traces) {
        out.insert(out.end(), action_trace.begin(), action_trace.end());
    }
}

inline std::vector<char> filterTracesBinaryMsgpack(
    abieos_context* context,
    const char* data,
    size_t size,
    const std::vector<TraceFilterRule>& filters
) {
    EosBinReader reader(data, size);
    uint32_t tx_count = 0;
    if (!reader.readVaruint32(tx_count)) {
        throw std::runtime_error("invalid transaction_trace[] length");
    }

    std::vector<std::vector<char>> transactions;

    for (uint32_t tx_index = 0; tx_index < tx_count; ++tx_index) {
        uint32_t variant_index = 0;
        if (!reader.readVaruint32(variant_index) || variant_index != 0) {
            throw std::runtime_error("unsupported transaction_trace variant index");
        }

        const char* tx_body = reader.cursor();
        const size_t tx_size = reader.remaining();
        if (tx_size < 33) {
            throw std::runtime_error("invalid transaction_trace_v0 header");
        }

        std::string tx_id;
        uint8_t status = 0;
        uint32_t cpu_usage_us = 0;
        if (!reader.readChecksum256(tx_id) || !reader.readU8(status) || !reader.readU32(cpu_usage_us)) {
            throw std::runtime_error("invalid transaction_trace_v0 header");
        }

        uint32_t net_usage_words = 0;
        int64_t elapsed = 0;
        uint64_t net_usage = 0;
        uint8_t scheduled = 0;
        if (!reader.readVaruint32(net_usage_words) || !reader.readI64(elapsed) || !reader.readU64(net_usage) ||
            !reader.readU8(scheduled)) {
            throw std::runtime_error("invalid transaction_trace_v0 metrics");
        }

        uint32_t action_count = 0;
        if (!reader.readVaruint32(action_count)) {
            throw std::runtime_error("invalid action_traces length");
        }

        std::vector<std::vector<char>> kept_action_traces;
        bool tx_parsed = true;

        if (status == 0) {
            for (uint32_t i = 0; i < action_count && tx_parsed; ++i) {
                uint32_t action_variant = 0;
                if (!reader.readVaruint32(action_variant) || action_variant > 1) {
                    tx_parsed = false;
                    break;
                }

                SlimActionTrace trace;
                if (!parseActionTraceV0(reader, trace)) {
                    tx_parsed = false;
                    break;
                }

                if (action_variant == 1 && !reader.skipBytes()) {
                    tx_parsed = false;
                    break;
                }

                if (!trace.has_receipt || !traceAllowedBinary(trace.account, trace.action, filters) ||
                    trace.receiver != trace.account) {
                    continue;
                }

                std::vector<char> encoded;
                appendSlimActionTraceMsgpack(encoded, trace);
                kept_action_traces.push_back(std::move(encoded));
            }
        } else {
            for (uint32_t i = 0; i < action_count && tx_parsed; ++i) {
                if (!skipActionTraceVariant(reader)) {
                    tx_parsed = false;
                    break;
                }
            }
        }

        const char* tail_failure = nullptr;
        if (tx_parsed && !skipTransactionTraceTail(context, reader, &tail_failure)) {
            tx_parsed = false;
        }

        if (!tx_parsed) {
            const size_t consumed = static_cast<size_t>(reader.cursor() - tx_body);
            size_t decoded =
                abieosMinDecodeSize(context, kShipContract, "transaction_trace_v0", tx_body, tx_size);
            if (decoded == 0 || decoded > tx_size) {
                decoded = abieosMinDecodeSize(context, kShipContract, "transaction_trace", tx_body, tx_size);
            }
            if (decoded == 0 || decoded <= consumed) {
                throw std::runtime_error(
                    std::string("failed to parse transaction_trace element at tail ") +
                    (tail_failure ? tail_failure : "unknown"));
            }
            reader.advance(decoded - consumed);
            continue;
        }

        if (status == 0 && !kept_action_traces.empty()) {
            std::vector<char> encoded_tx;
            appendSlimTransactionMsgpack(encoded_tx, tx_id, kept_action_traces);
            transactions.push_back(std::move(encoded_tx));
        }
    }

    std::vector<char> out;
    appendMsgpackArrayHeader(out, transactions.size());
    for (const auto& tx : transactions) {
        out.insert(out.end(), tx.begin(), tx.end());
    }
    return out;
}

struct ContractRowHeader {
    std::string code;
    std::string scope;
    std::string table;
    std::string payer;
    uint64_t primary_key = 0;
    std::vector<char> value;
};

inline bool parseContractRowHeader(
    const char* data,
    size_t size,
    ContractRowHeader& out
) {
    EosBinReader reader(data, size);
    uint32_t variant_index = 0;
    if (!reader.readVaruint32(variant_index) || variant_index != 0) {
        return false;
    }

    uint64_t code_name = 0;
    uint64_t scope_name = 0;
    uint64_t table_name = 0;
    uint64_t payer_name = 0;
    if (!reader.readName(code_name) || !reader.readName(scope_name) || !reader.readName(table_name) ||
        !reader.readU64(out.primary_key) || !reader.readName(payer_name) || !reader.readBytes(out.value)) {
        return false;
    }

    out.code = nameToString(code_name);
    out.scope = nameToString(scope_name);
    out.table = nameToString(table_name);
    out.payer = nameToString(payer_name);
    return true;
}

inline void appendContractRowMsgpack(std::vector<char>& out, bool present, const ContractRowHeader& row) {
    appendMsgpackMapHeader(out, 2);
    appendMsgpackKey(out, "present", 7);
    appendMsgpackBool(out, present);
    appendMsgpackKey(out, "data", 4);
    appendMsgpackArrayHeader(out, 2);
    appendMsgpackString(out, "contract_row_v0", 15);
    appendMsgpackMapHeader(out, 6);
    appendMsgpackKey(out, "code", 4);
    appendMsgpackString(out, row.code.c_str(), row.code.size());
    appendMsgpackKey(out, "scope", 5);
    appendMsgpackString(out, row.scope.c_str(), row.scope.size());
    appendMsgpackKey(out, "table", 5);
    appendMsgpackString(out, row.table.c_str(), row.table.size());
    appendMsgpackKey(out, "primary_key", 11);
    appendMsgpackUInt64String(out, row.primary_key);
    appendMsgpackKey(out, "payer", 5);
    appendMsgpackString(out, row.payer.c_str(), row.payer.size());
    appendMsgpackKey(out, "value", 5);
    appendMsgpackHexString(out, row.value.data(), row.value.size());
}

inline std::vector<char> filterDeltasBinaryMsgpack(
    const char* data,
    size_t size,
    const std::unordered_set<std::string>& delta_types,
    const std::vector<TableFilterRule>& filters
) {
    EosBinReader reader(data, size);
    uint32_t delta_count = 0;
    if (!reader.readVaruint32(delta_count)) {
        throw std::runtime_error("invalid table_delta[] length");
    }

    std::vector<std::vector<char>> kept_deltas;

    for (uint32_t delta_index = 0; delta_index < delta_count; ++delta_index) {
        uint32_t variant_index = 0;
        if (!reader.readVaruint32(variant_index) || variant_index != 0) {
            throw std::runtime_error("unsupported table_delta variant index");
        }

        std::vector<char> type_name_bytes;
        if (!reader.readBytes(type_name_bytes)) {
            throw std::runtime_error("invalid table_delta name");
        }
        const std::string type_name(type_name_bytes.begin(), type_name_bytes.end());

        uint32_t row_count = 0;
        if (!reader.readVaruint32(row_count)) {
            throw std::runtime_error("invalid table_delta rows length");
        }

        std::vector<std::vector<char>> kept_rows;

        if (delta_types.count(type_name) > 0) {
            for (uint32_t i = 0; i < row_count; ++i) {
                uint8_t present = 0;
                std::vector<char> row_bytes;
                if (!reader.readU8(present) || !reader.readBytes(row_bytes)) {
                    throw std::runtime_error("invalid table_delta row");
                }

                if (type_name != "contract_row") {
                    continue;
                }

                ContractRowHeader row;
                if (!parseContractRowHeader(row_bytes.data(), row_bytes.size(), row)) {
                    throw std::runtime_error("failed to parse contract_row header");
                }

                if (!tableAllowedBinary(row.code, row.table, filters)) {
                    continue;
                }

                std::vector<char> encoded_row;
                appendContractRowMsgpack(encoded_row, present != 0, row);
                kept_rows.push_back(std::move(encoded_row));
            }
        } else {
            for (uint32_t i = 0; i < row_count; ++i) {
                uint8_t present = 0;
                if (!reader.readU8(present) || !reader.skipBytes()) {
                    throw std::runtime_error("failed to skip table_delta row");
                }
            }
        }

        if (kept_rows.empty()) {
            continue;
        }

        std::vector<char> encoded_delta;
        appendMsgpackArrayHeader(encoded_delta, 2);
        appendMsgpackString(encoded_delta, "table_delta_v0", 14);
        appendMsgpackMapHeader(encoded_delta, 2);
        appendMsgpackKey(encoded_delta, "name", 4);
        appendMsgpackString(encoded_delta, type_name.c_str(), type_name.size());
        appendMsgpackKey(encoded_delta, "rows", 4);
        appendMsgpackArrayHeader(encoded_delta, kept_rows.size());
        for (const auto& row : kept_rows) {
            encoded_delta.insert(encoded_delta.end(), row.begin(), row.end());
        }
        kept_deltas.push_back(std::move(encoded_delta));
    }

    std::vector<char> out;
    appendMsgpackArrayHeader(out, kept_deltas.size());
    for (const auto& delta : kept_deltas) {
        out.insert(out.end(), delta.begin(), delta.end());
    }
    return out;
}

inline void skipOptionalSignedBlockVariant(EosBinReader& reader) {
    if (reader.remaining() == 0) {
        return;
    }

    const char* start = reader.cursor();
    const uint8_t first = static_cast<uint8_t>(start[0]);
    if (first > 1) {
        return;
    }

    EosBinReader peek(start, reader.remaining());
    uint32_t variant_index = 0;
    if (!peek.readVaruint32(variant_index) || variant_index > 1) {
        return;
    }

    const size_t prefix = static_cast<size_t>(peek.cursor() - start);
    if (prefix != 1) {
        return;
    }

    reader.advance(prefix);
}

inline std::vector<char> extractSlimBlockMsgpack(
    uint32_t version,
    const char* data,
    size_t size
) {
    if (size == 0) {
        std::vector<char> out;
        appendMsgpackNull(out);
        return out;
    }

    EosBinReader reader(data, size);
    if (version != 0) {
        skipOptionalSignedBlockVariant(reader);
    }

    uint32_t timestamp = 0;
    uint64_t producer_name = 0;
    if (!reader.readU32(timestamp) || !reader.readName(producer_name)) {
        throw std::runtime_error("failed to read block header");
    }

    const std::string timestamp_str = formatBlockTimestamp(timestamp);
    const std::string producer = nameToString(producer_name);

    std::vector<char> out;
    if (version == 0) {
        appendMsgpackMapHeader(out, 2);
        appendMsgpackKey(out, "timestamp", 9);
        appendMsgpackString(out, timestamp_str.c_str(), timestamp_str.size());
        appendMsgpackKey(out, "producer", 8);
        appendMsgpackString(out, producer.c_str(), producer.size());
        return out;
    }

    appendMsgpackArrayHeader(out, 2);
    appendMsgpackString(out, "signed_block_v1", 15);
    appendMsgpackMapHeader(out, 2);
    appendMsgpackKey(out, "timestamp", 9);
    appendMsgpackString(out, timestamp_str.c_str(), timestamp_str.size());
    appendMsgpackKey(out, "producer", 8);
    appendMsgpackString(out, producer.c_str(), producer.size());
    return out;
}

inline void appendMsgpackBytes(std::vector<char>& out, const std::vector<char>& bytes) {
    out.insert(out.end(), bytes.begin(), bytes.end());
}

} // namespace ship_sidecar
