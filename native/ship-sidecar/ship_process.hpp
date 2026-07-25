#pragma once

#include "hex_utils.hpp"
#include "json_msgpack.hpp"
#include "ship_binary.hpp"
#include "ship_envelope.hpp"

#include <abieos.h>

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

#include <rapidjson/document.h>

namespace ship_sidecar {

inline std::string abieosTypeToJson(abieos_context* context, const std::string& type, const char* data, size_t size) {
    const char* json = abieos_bin_to_json(context, kShipContract, type.c_str(), data, size);
    if (!json) {
        const char* err = abieos_get_error(context);
        throw std::runtime_error(
            std::string("abieos_bin_to_json failed for type ") + type + ": " + (err ? err : "unknown"));
    }
    return json;
}

inline uint32_t versionFromResultType(const std::string& result_type) {
    if (result_type == "get_blocks_result_v0") {
        return 0;
    }
    if (result_type == "get_blocks_result_v1") {
        return 1;
    }
    if (result_type == "get_blocks_result_v2") {
        return 2;
    }
    throw std::runtime_error("unsupported ship blocks result type: " + result_type);
}

inline bool readBlockPositionJson(const rapidjson::Value& value, BlockPosition& out) {
    if (!value.IsObject() || !value.HasMember("block_num") || !value.HasMember("block_id") ||
        !value["block_id"].IsString()) {
        return false;
    }

    const rapidjson::Value& block_num = value["block_num"];
    if (block_num.IsUint()) {
        out.block_num = block_num.GetUint();
    } else if (block_num.IsInt()) {
        out.block_num = static_cast<uint32_t>(block_num.GetInt());
    } else if (block_num.IsString()) {
        out.block_num = static_cast<uint32_t>(std::stoul(block_num.GetString()));
    } else {
        return false;
    }

    out.block_id_hex = value["block_id"].GetString();
    return true;
}

inline bool readOptionalBlockPositionJson(
    const rapidjson::Value& body,
    const char* field,
    std::optional<BlockPosition>& out
) {
    if (!body.HasMember(field) || body[field].IsNull()) {
        out.reset();
        return true;
    }

    BlockPosition value;
    if (!readBlockPositionJson(body[field], value)) {
        return false;
    }

    out = value;
    return true;
}

inline bool readOptionalHexField(
    const rapidjson::Value& body,
    const char* field,
    std::vector<char>& out,
    bool& has_value
) {
    if (!body.HasMember(field) || body[field].IsNull()) {
        out.clear();
        has_value = false;
        return true;
    }

    if (!body[field].IsString()) {
        return false;
    }

    out = hexToBytes(body[field].GetString());
    has_value = !out.empty();
    return true;
}

inline ParsedBlocksResult parseShipResultAbieos(abieos_context* context, const char* data, size_t size) {
    const std::string result_json = abieosTypeToJson(context, "result", data, size);

    rapidjson::Document doc;
    doc.Parse(result_json.c_str(), result_json.size());
    if (doc.HasParseError() || !doc.IsArray() || doc.Size() < 2 || !doc[0].IsString() || !doc[1].IsObject()) {
        throw std::runtime_error("invalid ship result json from abieos");
    }

    ParsedBlocksResult parsed;
    parsed.result_type = doc[0].GetString();
    parsed.version = versionFromResultType(parsed.result_type);

    const rapidjson::Value& body = doc[1];
    if (!readBlockPositionJson(body["head"], parsed.head) ||
        !readBlockPositionJson(body["last_irreversible"], parsed.last_irreversible) ||
        !readOptionalBlockPositionJson(body, "this_block", parsed.this_block) ||
        !readOptionalBlockPositionJson(body, "prev_block", parsed.prev_block) ||
        !readOptionalHexField(body, "block", parsed.block, parsed.has_block) ||
        !readOptionalHexField(body, "traces", parsed.traces, parsed.has_traces) ||
        !readOptionalHexField(body, "deltas", parsed.deltas, parsed.has_deltas)) {
        throw std::runtime_error("failed to parse get_blocks_result fields from abieos json");
    }

    return parsed;
}

inline const rapidjson::Value* getAbiVariantBody(const rapidjson::Value& value) {
    if (value.IsObject()) {
        return &value;
    }

    if (value.IsArray() && value.Size() >= 2 && value[1].IsObject()) {
        return &value[1];
    }

    return nullptr;
}

inline bool traceAllowed(
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

inline bool tableAllowed(
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

inline void slimActionTraceObject(rapidjson::Value& trace_body) {
    if (!trace_body.IsObject()) {
        return;
    }

    trace_body.RemoveMember("console");
    if (trace_body.HasMember("except") && trace_body["except"].IsNull()) {
        trace_body.RemoveMember("except");
    }
    if (trace_body.HasMember("error_code") && trace_body["error_code"].IsNull()) {
        trace_body.RemoveMember("error_code");
    }
}

inline rapidjson::Document filterTracesDocument(
    abieos_context* context,
    const char* data,
    size_t size,
    const std::vector<TraceFilterRule>& filters
) {
    const std::string traces_json = abieosTypeToJson(context, "transaction_trace[]", data, size);

    rapidjson::Document source;
    source.Parse(traces_json.c_str(), traces_json.size());
    if (source.HasParseError() || !source.IsArray()) {
        throw std::runtime_error("failed to parse transaction_trace[] json");
    }

    rapidjson::Document filtered;
    filtered.SetArray();
    auto& allocator = filtered.GetAllocator();

    for (auto& transaction : source.GetArray()) {
        if (!transaction.IsArray() || transaction.Size() < 2 || !transaction[1].IsObject()) {
            continue;
        }

        rapidjson::Value tx_copy(rapidjson::kArrayType);
        rapidjson::Value variant_name;
        variant_name.SetString(transaction[0].GetString(), transaction[0].GetStringLength(), allocator);
        tx_copy.PushBack(variant_name, allocator);
        rapidjson::Value tx_body;
        tx_body.CopyFrom(transaction[1], allocator);

        if (!tx_body.HasMember("action_traces") || !tx_body["action_traces"].IsArray()) {
            continue;
        }

        rapidjson::Value kept_traces(rapidjson::kArrayType);
        for (auto& action_trace : tx_body["action_traces"].GetArray()) {
            if (!action_trace.IsArray() || action_trace.Size() < 2 || !action_trace[1].IsObject()) {
                continue;
            }

            rapidjson::Value& trace_body = action_trace[1];
            if (!trace_body.HasMember("act") || !trace_body["act"].IsObject()) {
                continue;
            }

            const rapidjson::Value& act = trace_body["act"];
            if (!act.HasMember("account") || !act.HasMember("name") ||
                !act["account"].IsString() || !act["name"].IsString()) {
                continue;
            }

            if (!traceAllowed(act["account"].GetString(), act["name"].GetString(), filters)) {
                continue;
            }

            slimActionTraceObject(trace_body);
            rapidjson::Value trace_copy;
            trace_copy.CopyFrom(action_trace, allocator);
            kept_traces.PushBack(trace_copy, allocator);
        }

        if (kept_traces.Empty()) {
            continue;
        }

        tx_body["action_traces"] = kept_traces;
        tx_copy.PushBack(tx_body, allocator);
        filtered.PushBack(tx_copy, allocator);
    }

    return filtered;
}

inline rapidjson::Document filterDeltasDocument(
    abieos_context* context,
    const char* data,
    size_t size,
    const std::unordered_set<std::string>& delta_types,
    const std::vector<TableFilterRule>& table_filters
) {
    rapidjson::Document filtered;
    filtered.SetArray();

    if (size == 0) {
        return filtered;
    }

    const std::string deltas_json = abieosTypeToJson(context, "table_delta[]", data, size);

    rapidjson::Document source;
    source.Parse(deltas_json.c_str(), deltas_json.size());
    if (source.HasParseError() || !source.IsArray()) {
        throw std::runtime_error("failed to parse table_delta[] json");
    }

    auto& allocator = filtered.GetAllocator();

    for (auto& delta : source.GetArray()) {
        if (!delta.IsArray() || delta.Size() < 2 || !delta[1].IsObject()) {
            continue;
        }

        const rapidjson::Value& source_body = delta[1];
        if (!source_body.HasMember("name") || !source_body["name"].IsString()) {
            continue;
        }

        const std::string name = source_body["name"].GetString();
        if (delta_types.count(name) == 0 || !source_body.HasMember("rows") || !source_body["rows"].IsArray()) {
            continue;
        }

        rapidjson::Value delta_copy(rapidjson::kArrayType);
        rapidjson::Value delta_variant;
        delta_variant.SetString(delta[0].GetString(), delta[0].GetStringLength(), allocator);
        delta_copy.PushBack(delta_variant, allocator);
        rapidjson::Value body;
        body.CopyFrom(source_body, allocator);
        rapidjson::Value kept_rows(rapidjson::kArrayType);

        for (auto& row : body["rows"].GetArray()) {
            if (!row.IsObject() || !row.HasMember("data") || !row["data"].IsString()) {
                continue;
            }

            const auto bin = hexToBytes(row["data"].GetString());
            const std::string row_json = abieosTypeToJson(context, name, bin.data(), bin.size());

            rapidjson::Document row_doc;
            row_doc.Parse(row_json.c_str(), row_json.size());
            const rapidjson::Value* row_body = getAbiVariantBody(row_doc);
            if (row_doc.HasParseError() || !row_body) {
                throw std::runtime_error("failed to parse delta row json for " + name);
            }

            if (name == "contract_row") {
                std::string code;
                std::string table;

                if (row_body->HasMember("code") && (*row_body)["code"].IsString()) {
                    code = (*row_body)["code"].GetString();
                }
                if (row_body->HasMember("table") && (*row_body)["table"].IsString()) {
                    table = (*row_body)["table"].GetString();
                }

                if (!tableAllowed(code, table, table_filters)) {
                    continue;
                }
            }

            row["data"].CopyFrom(row_doc, allocator);
            kept_rows.PushBack(row, allocator);
        }

        if (kept_rows.Empty()) {
            continue;
        }

        body["rows"] = kept_rows;
        delta_copy.PushBack(body, allocator);
        filtered.PushBack(delta_copy, allocator);
    }

    return filtered;
}

inline rapidjson::Document buildBlockDocument(
    abieos_context* context,
    uint32_t version,
    const std::vector<char>& block_data,
    bool has_block
) {
    rapidjson::Document block_doc;

    if (!has_block || block_data.empty()) {
        block_doc.SetNull();
        return block_doc;
    }

    const std::string block_json = version == 0
        ? abieosTypeToJson(context, "signed_block", block_data.data(), block_data.size())
        : abieosTypeToJson(context, "signed_block_variant", block_data.data(), block_data.size());

    block_doc.Parse(block_json.c_str(), block_json.size());
    if (block_doc.HasParseError()) {
        throw std::runtime_error("failed to parse block json");
    }

    return block_doc;
}

inline std::vector<char> processParsedBlocksResultMsgpack(
    abieos_context* context,
    const ParsedBlocksResult& parsed,
    const std::unordered_set<std::string>& delta_types,
    const std::vector<TraceFilterRule>& trace_filters,
    const std::vector<TableFilterRule>& table_filters
) {
    std::vector<char> block_msgpack;
    if (!parsed.has_block || parsed.block.empty()) {
        block_msgpack.clear();
        appendMsgpackNull(block_msgpack);
    } else {
        block_msgpack = extractSlimBlockMsgpack(
            context, parsed.version, parsed.block.data(), parsed.block.size());
    }

    std::vector<char> traces_msgpack;
    if (parsed.has_traces && !parsed.traces.empty()) {
        traces_msgpack = filterTracesBinaryMsgpack(
            context, parsed.traces.data(), parsed.traces.size(), trace_filters);
    } else {
        traces_msgpack.clear();
        appendMsgpackArrayHeader(traces_msgpack, 0);
    }

    std::vector<char> deltas_msgpack;
    if (parsed.has_deltas && !parsed.deltas.empty()) {
        deltas_msgpack = filterDeltasBinaryMsgpack(
            context, parsed.deltas.data(), parsed.deltas.size(), delta_types, table_filters);
    } else {
        deltas_msgpack.clear();
        appendMsgpackArrayHeader(deltas_msgpack, 0);
    }

    std::vector<char> out;
    out.reserve(4096);
    appendMsgpackMapHeader(out, 10);

    appendMsgpackKey(out, "result_type", 11);
    appendMsgpackString(out, parsed.result_type.c_str(), parsed.result_type.size());

    appendMsgpackKey(out, "version", 7);
    appendMsgpackUint32(out, parsed.version);

    appendMsgpackKey(out, "head", 4);
    appendBlockPositionMsgpack(out, parsed.head);

    appendMsgpackKey(out, "last_irreversible", 17);
    appendBlockPositionMsgpack(out, parsed.last_irreversible);

    appendMsgpackKey(out, "this_block", 10);
    appendOptionalBlockPositionMsgpack(out, parsed.this_block);

    appendMsgpackKey(out, "prev_block", 10);
    appendOptionalBlockPositionMsgpack(out, parsed.prev_block);

    appendMsgpackKey(out, "block", 5);
    appendMsgpackBytes(out, block_msgpack);

    appendMsgpackKey(out, "traces", 6);
    appendMsgpackBytes(out, traces_msgpack);

    appendMsgpackKey(out, "deltas", 6);
    appendMsgpackBytes(out, deltas_msgpack);

    appendMsgpackKey(out, "deltas_processed", 16);
    appendMsgpackBool(out, true);

    return out;
}

} // namespace ship_sidecar
