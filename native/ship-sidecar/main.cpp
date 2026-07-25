#include <abieos.h>

#include "hex_utils.hpp"
#include "json_msgpack.hpp"
#include "ship_process.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <rapidjson/document.h>
#include <rapidjson/stringbuffer.h>
#include <rapidjson/writer.h>

extern const char *const state_history_plugin_abi;

namespace
{

    constexpr uint32_t kMagic = 0x48504953; // 'SHIP'
    constexpr uint32_t kVersion = 2;

    constexpr uint32_t kOpPing = 0;
    constexpr uint32_t kOpDeserialize = 1;
    constexpr uint32_t kOpDeserializeBatch = 2;
    constexpr uint32_t kOpDeserializeBlock = 3;
    constexpr uint32_t kOpSetAbi = 4;
    constexpr uint32_t kOpDeserializeContractBatch = 5;
    constexpr uint32_t kOpProcessShipMessage = 6;
    constexpr uint32_t kOpSetFilters = 7;
    constexpr uint32_t kOpSetShipAbi = 8;
    constexpr uint32_t kOpShutdown = 255;

    constexpr uint32_t kFormatText = 0;
    constexpr uint32_t kFormatMsgpack = 1;

    constexpr uint64_t kShipContract = 2;

    struct TraceFilter
    {
        std::string contract;
        std::string action;
    };

    struct TableFilter
    {
        std::string code;
        std::string table;
    };

    struct Job
    {
        uint32_t request_id = 0;
        uint32_t op = 0;
        std::vector<char> payload;
    };

    struct Worker
    {
        explicit Worker(size_t index) : index(index)
        {
            context = abieos_create();
            if (!context)
            {
                throw std::runtime_error("abieos_create failed for worker " + std::to_string(index));
            }

            if (!abieos_set_abi(context, kShipContract, state_history_plugin_abi))
            {
                const char *err = abieos_get_error(context);
                throw std::runtime_error(std::string("abieos_set_abi failed: ") + (err ? err : "unknown"));
            }
        }

        ~Worker()
        {
            if (context)
            {
                abieos_destroy(context);
            }
        }

        Worker(const Worker &) = delete;
        Worker &operator=(const Worker &) = delete;

        size_t index;
        abieos_context *context = nullptr;
        std::unordered_set<std::string> delta_types;
        std::vector<TraceFilter> trace_filters;
        std::vector<TableFilter> table_filters;
    };

    std::vector<char> makeErrorResponse(const std::string &message)
    {
        std::vector<char> out(12);
        const uint32_t status = 1;
        const uint32_t format = kFormatText;
        const uint32_t size = static_cast<uint32_t>(message.size());
        std::memcpy(out.data(), &status, 4);
        std::memcpy(out.data() + 4, &format, 4);
        std::memcpy(out.data() + 8, &size, 4);
        out.insert(out.end(), message.begin(), message.end());
        return out;
    }

    std::vector<char> makeOkMsgpackResponse(const std::vector<char> &msgpack)
    {
        std::vector<char> out(12);
        const uint32_t status = 0;
        const uint32_t format = kFormatMsgpack;
        const uint32_t size = static_cast<uint32_t>(msgpack.size());
        std::memcpy(out.data(), &status, 4);
        std::memcpy(out.data() + 4, &format, 4);
        std::memcpy(out.data() + 8, &size, 4);
        out.insert(out.end(), msgpack.begin(), msgpack.end());
        return out;
    }

    std::vector<char> makeOkMsgpackFromJson(const std::string &json)
    {
        return makeOkMsgpackResponse(ship_sidecar::jsonToMsgpack(json));
    }

    class Sidecar
    {
    public:
        explicit Sidecar(size_t thread_count) : stop_(false)
        {
            workers_.reserve(thread_count);
            for (size_t i = 0; i < thread_count; ++i)
            {
                workers_.emplace_back(std::make_unique<Worker>(i));
            }

            for (size_t i = 0; i < thread_count; ++i)
            {
                pool_.emplace_back([this, i]()
                                   { workerLoop(i); });
            }
        }

        ~Sidecar()
        {
            stop();
        }

        void stop()
        {
            if (stop_.exchange(true))
            {
                return;
            }

            queue_cv_.notify_all();

            for (auto &thread : pool_)
            {
                if (thread.joinable())
                {
                    thread.join();
                }
            }
        }

        void enqueue(Job job)
        {
            {
                std::lock_guard<std::mutex> lock(queue_mutex_);
                jobs_.push(std::move(job));
            }
            queue_cv_.notify_one();
        }

        bool waitResponse(uint32_t request_id, std::vector<char> &response, int timeout_ms = 120000)
        {
            std::unique_lock<std::mutex> lock(response_mutex_);
            const auto ready = [this, request_id]()
            {
                return responses_.count(request_id) > 0 || stop_.load();
            };

            if (timeout_ms > 0)
            {
                if (!response_cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), ready))
                {
                    return false;
                }
            }
            else
            {
                response_cv_.wait(lock, ready);
            }

            auto it = responses_.find(request_id);
            if (it == responses_.end())
            {
                return false;
            }

            response = std::move(it->second);
            responses_.erase(it);
            return true;
        }

    private:
        void submitResponse(uint32_t request_id, std::vector<char> response)
        {
            {
                std::lock_guard<std::mutex> lock(response_mutex_);
                responses_[request_id] = std::move(response);
            }
            response_cv_.notify_all();
        }

        void workerLoop(size_t worker_index)
        {
            Worker &worker = *workers_[worker_index];

            while (true)
            {
                Job job;
                {
                    std::unique_lock<std::mutex> lock(queue_mutex_);
                    queue_cv_.wait(lock, [this]()
                                   { return stop_.load() || !jobs_.empty(); });

                    if (stop_.load() && jobs_.empty())
                    {
                        return;
                    }

                    job = std::move(jobs_.front());
                    jobs_.pop();
                }

                try
                {
                    submitResponse(job.request_id, handleJob(worker, job));
                }
                catch (const std::exception &ex)
                {
                    submitResponse(job.request_id, makeErrorResponse(ex.what()));
                }
            }
        }

        static bool readU32(const char *&pos, const char *end, uint32_t &value)
        {
            if (end - pos < 4)
            {
                return false;
            }
            std::memcpy(&value, pos, 4);
            pos += 4;
            return true;
        }

        static bool readU8(const char *&pos, const char *end, uint8_t &value)
        {
            if (pos >= end)
            {
                return false;
            }
            value = static_cast<uint8_t>(*pos++);
            return true;
        }

        static bool readBlockPositionPayload(const char *&pos, const char *end, ship_sidecar::BlockPosition &out)
        {
            uint32_t block_num = 0;
            std::string block_id;
            if (!readU32(pos, end, block_num) || !readBytes(pos, end, block_id))
            {
                return false;
            }
            if (block_id.size() != 32)
            {
                throw std::runtime_error("invalid block_id length in process ship message payload");
            }
            out.block_num = block_num;
            out.block_id_hex = ship_sidecar::bytesToHex(block_id.data(), block_id.size());
            return true;
        }

        static bool readOptionalBlockPositionPayload(
            const char *&pos,
            const char *end,
            std::optional<ship_sidecar::BlockPosition> &out)
        {
            uint8_t present = 0;
            if (!readU8(pos, end, present))
            {
                return false;
            }
            if (present == 0)
            {
                out.reset();
                return true;
            }
            ship_sidecar::BlockPosition value;
            if (!readBlockPositionPayload(pos, end, value))
            {
                return false;
            }
            out = value;
            return true;
        }

        static ship_sidecar::ParsedBlocksResult readParsedBlocksPayload(const char *&pos, const char *end)
        {
            std::string result_type;
            uint32_t version = 0;
            ship_sidecar::ParsedBlocksResult parsed;

            if (!readBytes(pos, end, result_type) || !readU32(pos, end, version) ||
                !readBlockPositionPayload(pos, end, parsed.head) ||
                !readBlockPositionPayload(pos, end, parsed.last_irreversible) ||
                !readOptionalBlockPositionPayload(pos, end, parsed.this_block) ||
                !readOptionalBlockPositionPayload(pos, end, parsed.prev_block))
            {
                throw std::runtime_error("invalid process ship message header");
            }

            parsed.result_type = result_type;
            parsed.version = version;

            if (!readOptionalBytes(pos, end, parsed.block, parsed.has_block) ||
                !readOptionalBytes(pos, end, parsed.traces, parsed.has_traces) ||
                !readOptionalBytes(pos, end, parsed.deltas, parsed.has_deltas))
            {
                throw std::runtime_error("invalid process ship message payload bytes");
            }

            return parsed;
        }

        static bool readOptionalBytes(
            const char *&pos,
            const char *end,
            std::vector<char> &out,
            bool &has_value)
        {
            std::string bytes;
            if (!readBytes(pos, end, bytes))
            {
                return false;
            }
            out.assign(bytes.begin(), bytes.end());
            has_value = !out.empty();
            return true;
        }

        static bool readBytes(const char *&pos, const char *end, std::string &value)
        {
            uint32_t size = 0;
            if (!readU32(pos, end, size) || static_cast<size_t>(end - pos) < size)
            {
                return false;
            }
            value.assign(pos, size);
            pos += size;
            return true;
        }

        static bool readWhitelist(const char *&pos, const char *end, std::unordered_set<std::string> &whitelist)
        {
            uint32_t count = 0;
            if (!readU32(pos, end, count))
            {
                return false;
            }

            for (uint32_t i = 0; i < count; ++i)
            {
                std::string name;
                if (!readBytes(pos, end, name))
                {
                    return false;
                }
                whitelist.insert(std::move(name));
            }

            return true;
        }

        static bool readTraceFilters(const char *&pos, const char *end, std::vector<TraceFilter> &filters)
        {
            uint32_t count = 0;
            if (!readU32(pos, end, count))
            {
                return false;
            }

            filters.reserve(count);
            for (uint32_t i = 0; i < count; ++i)
            {
                TraceFilter filter;
                if (!readBytes(pos, end, filter.contract) || !readBytes(pos, end, filter.action))
                {
                    return false;
                }
                filters.push_back(std::move(filter));
            }

            return true;
        }

        static bool readTableFilters(const char *&pos, const char *end, std::vector<TableFilter> &filters)
        {
            uint32_t count = 0;
            if (!readU32(pos, end, count))
            {
                return false;
            }

            filters.reserve(count);
            for (uint32_t i = 0; i < count; ++i)
            {
                TableFilter filter;
                if (!readBytes(pos, end, filter.code) || !readBytes(pos, end, filter.table))
                {
                    return false;
                }
                filters.push_back(std::move(filter));
            }

            return true;
        }

        static bool traceAllowed(
            const std::string &contract,
            const std::string &action,
            const std::vector<TraceFilter> &filters)
        {
            if (filters.empty())
            {
                return true;
            }

            for (const auto &filter : filters)
            {
                if (filter.contract == contract && (filter.action == "*" || filter.action == action))
                {
                    return true;
                }
            }

            return false;
        }

        static const rapidjson::Value *getAbiVariantBody(const rapidjson::Value &value)
        {
            if (value.IsObject())
            {
                return &value;
            }

            if (value.IsArray() && value.Size() >= 2 && value[1].IsObject())
            {
                return &value[1];
            }

            return nullptr;
        }

        static bool tableAllowed(
            const std::string &code,
            const std::string &table,
            const std::vector<TableFilter> &filters)
        {
            if (filters.empty())
            {
                return true;
            }

            for (const auto &filter : filters)
            {
                if (filter.code == code && (filter.table == "*" || filter.table == table))
                {
                    return true;
                }
            }

            return false;
        }

        static void slimActionTraceObject(rapidjson::Value &trace_body, rapidjson::Document::AllocatorType &allocator)
        {
            (void)allocator;
            if (trace_body.IsObject())
            {
                trace_body.RemoveMember("console");
                if (trace_body.HasMember("except") && trace_body["except"].IsNull())
                {
                    trace_body.RemoveMember("except");
                }
                if (trace_body.HasMember("error_code") && trace_body["error_code"].IsNull())
                {
                    trace_body.RemoveMember("error_code");
                }
            }
        }

        static std::string blockPositionJson(const ship_sidecar::BlockPosition &position)
        {
            std::ostringstream json;
            json << "{\"block_num\":" << position.block_num << ",\"block_id\":\"" << position.block_id_hex << "\"}";
            return json.str();
        }

        std::string filterTracesJson(Worker &worker, const std::string &traces_json, const std::vector<TraceFilter> &filters)
        {
            if (traces_json.empty())
            {
                return "[]";
            }

            rapidjson::Document doc;
            doc.Parse(traces_json.c_str(), traces_json.size());
            if (doc.HasParseError() || !doc.IsArray())
            {
                throw std::runtime_error("failed to parse transaction_trace[] json");
            }

            rapidjson::Document filtered;
            filtered.SetArray();
            auto &allocator = filtered.GetAllocator();

            for (auto &transaction : doc.GetArray())
            {
                if (!transaction.IsArray() || transaction.Size() < 2 || !transaction[1].IsObject())
                {
                    continue;
                }

                rapidjson::Value tx_copy(rapidjson::kArrayType);
                tx_copy.PushBack(rapidjson::StringRef(transaction[0].GetString()), allocator);
                rapidjson::Value tx_body;
                tx_body.CopyFrom(transaction[1], allocator);

                if (!tx_body.HasMember("action_traces") || !tx_body["action_traces"].IsArray())
                {
                    continue;
                }

                rapidjson::Value kept_traces(rapidjson::kArrayType);
                for (auto &action_trace : tx_body["action_traces"].GetArray())
                {
                    if (!action_trace.IsArray() || action_trace.Size() < 2 || !action_trace[1].IsObject())
                    {
                        continue;
                    }

                    rapidjson::Value &trace_body = action_trace[1];
                    if (!trace_body.HasMember("act") || !trace_body["act"].IsObject())
                    {
                        continue;
                    }

                    const rapidjson::Value &act = trace_body["act"];
                    if (!act.HasMember("account") || !act.HasMember("name") ||
                        !act["account"].IsString() || !act["name"].IsString())
                    {
                        continue;
                    }

                    const std::string account = act["account"].GetString();
                    const std::string name = act["name"].GetString();
                    if (!traceAllowed(account, name, filters))
                    {
                        continue;
                    }

                    slimActionTraceObject(trace_body, allocator);
                    rapidjson::Value trace_copy;
                    trace_copy.CopyFrom(action_trace, allocator);
                    kept_traces.PushBack(trace_copy, allocator);
                }

                if (kept_traces.Empty())
                {
                    continue;
                }

                tx_body["action_traces"] = kept_traces;
                tx_copy.PushBack(tx_body, allocator);
                filtered.PushBack(tx_copy, allocator);
            }

            rapidjson::StringBuffer buffer;
            rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
            filtered.Accept(writer);
            return buffer.GetString();
        }

        std::string deserializeType(Worker &worker, const std::string &type, const char *data, size_t size)
        {
            const char *json = abieos_bin_to_json(worker.context, kShipContract, type.c_str(), data, size);
            if (!json)
            {
                const char *err = abieos_get_error(worker.context);
                throw std::runtime_error(std::string("abieos_bin_to_json failed for type ") + type + ": " + (err ? err : "unknown"));
            }
            return json;
        }

        std::string deserializeContractType(
            Worker &worker,
            const std::string &contract,
            const std::string &type,
            const char *data,
            size_t size)
        {
            const uint64_t contract_id = abieos_string_to_name(worker.context, contract.c_str());
            const char *json = abieos_bin_to_json(worker.context, contract_id, type.c_str(), data, size);
            if (!json)
            {
                const char *err = abieos_get_error(worker.context);
                throw std::runtime_error(
                    std::string("abieos_bin_to_json failed for contract ") + contract + " type " + type + ": " +
                    (err ? err : "unknown"));
            }
            return json;
        }

        void setContractAbi(Worker &worker, const std::string &contract, const std::string &abi_json)
        {
            const uint64_t contract_id = abieos_string_to_name(worker.context, contract.c_str());
            if (!abieos_set_abi(worker.context, contract_id, abi_json.c_str()))
            {
                const char *err = abieos_get_error(worker.context);
                throw std::runtime_error(std::string("abieos_set_abi failed for ") + contract + ": " + (err ? err : "unknown"));
            }
        }

        std::string deserializeDeltasWithFilters(
            Worker &worker,
            const char *data,
            size_t size,
            const std::unordered_set<std::string> &delta_types,
            const std::vector<TableFilter> &table_filters)
        {
            if (size == 0)
            {
                return "[]";
            }

            std::string deltas_json = deserializeType(worker, "table_delta[]", data, size);

            rapidjson::Document doc;
            doc.Parse(deltas_json.c_str(), deltas_json.size());
            if (doc.HasParseError() || !doc.IsArray())
            {
                throw std::runtime_error("failed to parse table_delta[] json");
            }

            rapidjson::Document filtered;
            filtered.SetArray();
            auto &allocator = filtered.GetAllocator();

            for (auto &delta : doc.GetArray())
            {
                if (!delta.IsArray() || delta.Size() < 2 || !delta[1].IsObject())
                {
                    continue;
                }

                const rapidjson::Value &source_body = delta[1];
                if (!source_body.HasMember("name") || !source_body["name"].IsString())
                {
                    continue;
                }

                const std::string name = source_body["name"].GetString();
                if (delta_types.count(name) == 0 || !source_body.HasMember("rows") || !source_body["rows"].IsArray())
                {
                    continue;
                }

                rapidjson::Value delta_copy(rapidjson::kArrayType);
                delta_copy.PushBack(rapidjson::StringRef(delta[0].GetString()), allocator);
                rapidjson::Value body;
                body.CopyFrom(source_body, allocator);
                rapidjson::Value kept_rows(rapidjson::kArrayType);

                for (auto &row : body["rows"].GetArray())
                {
                    if (!row.IsObject() || !row.HasMember("data") || !row["data"].IsString())
                    {
                        continue;
                    }

                    const auto bin = ship_sidecar::hexToBytes(row["data"].GetString());
                    const std::string row_json = deserializeType(worker, name, bin.data(), bin.size());

                    rapidjson::Document row_doc;
                    row_doc.Parse(row_json.c_str(), row_json.size());
                    const rapidjson::Value *row_body = getAbiVariantBody(row_doc);
                    if (row_doc.HasParseError() || !row_body)
                    {
                        throw std::runtime_error("failed to parse delta row json for " + name);
                    }

                    if (name == "contract_row")
                    {
                        std::string code;
                        std::string table;

                        if (row_body->HasMember("code") && (*row_body)["code"].IsString())
                        {
                            code = (*row_body)["code"].GetString();
                        }
                        if (row_body->HasMember("table") && (*row_body)["table"].IsString())
                        {
                            table = (*row_body)["table"].GetString();
                        }

                        if (!tableAllowed(code, table, table_filters))
                        {
                            continue;
                        }
                    }

                    row["data"].CopyFrom(row_doc, allocator);
                    kept_rows.PushBack(row, allocator);
                }

                if (kept_rows.Empty())
                {
                    continue;
                }

                body["rows"] = kept_rows;
                delta_copy.PushBack(body, allocator);
                filtered.PushBack(delta_copy, allocator);
            }

            rapidjson::StringBuffer buffer;
            rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
            filtered.Accept(writer);
            return buffer.GetString();
        }

        std::string buildBlockJson(
            Worker &worker,
            uint32_t version,
            const std::vector<char> &block_data,
            bool has_block)
        {
            if (!has_block || block_data.empty())
            {
                return "null";
            }

            if (version == 0)
            {
                return deserializeType(worker, "signed_block", block_data.data(), block_data.size());
            }

            return deserializeType(worker, "signed_block_variant", block_data.data(), block_data.size());
        }

        std::string processParsedBlocksResult(
            Worker &worker,
            const ship_sidecar::ParsedBlocksResult &parsed,
            const std::unordered_set<std::string> &delta_types,
            const std::vector<TraceFilter> &trace_filters,
            const std::vector<TableFilter> &table_filters)
        {
            std::ostringstream json;
            json << '{';
            json << "\"result_type\":\"" << parsed.result_type << "\",";
            json << "\"version\":" << parsed.version << ',';
            json << "\"head\":" << blockPositionJson(parsed.head) << ',';
            json << "\"last_irreversible\":" << blockPositionJson(parsed.last_irreversible) << ',';

            json << "\"this_block\":";
            if (parsed.this_block.has_value())
            {
                json << blockPositionJson(parsed.this_block.value());
            }
            else
            {
                json << "null";
            }
            json << ",\"prev_block\":";
            if (parsed.prev_block.has_value())
            {
                json << blockPositionJson(parsed.prev_block.value());
            }
            else
            {
                json << "null";
            }

            json << ",\"block\":";
            json << buildBlockJson(worker, parsed.version, parsed.block, parsed.has_block);

            json << ",\"traces\":";
            if (parsed.has_traces && !parsed.traces.empty())
            {
                const std::string traces_json = deserializeType(
                    worker, "transaction_trace[]", parsed.traces.data(), parsed.traces.size());
                json << filterTracesJson(worker, traces_json, trace_filters);
            }
            else
            {
                json << "[]";
            }

            json << ",\"deltas\":";
            if (parsed.has_deltas && !parsed.deltas.empty())
            {
                json << deserializeDeltasWithFilters(
                    worker, parsed.deltas.data(), parsed.deltas.size(), delta_types, table_filters);
            }
            else
            {
                json << "[]";
            }

            json << ",\"deltas_processed\":true";
            json << '}';
            return json.str();
        }

        std::string deserializeDeltasWithWhitelist(
            Worker &worker,
            const char *data,
            size_t size,
            const std::unordered_set<std::string> &whitelist)
        {
            return deserializeDeltasWithFilters(worker, data, size, whitelist, {});
        }

        std::vector<char> handleJob(Worker &worker, const Job &job)
        {
            const char *pos = job.payload.data();
            const char *end = job.payload.data() + job.payload.size();

            if (job.op == kOpPing)
            {
                return makeOkMsgpackFromJson("{\"pong\":true}");
            }

            if (job.op == kOpDeserialize)
            {
                std::string type;
                std::string data;
                if (!readBytes(pos, end, type) || !readBytes(pos, end, data))
                {
                    throw std::runtime_error("invalid deserialize payload");
                }

                return makeOkMsgpackFromJson(deserializeType(worker, type, data.data(), data.size()));
            }

            if (job.op == kOpDeserializeBatch)
            {
                uint32_t count = 0;
                if (!readU32(pos, end, count))
                {
                    throw std::runtime_error("invalid batch count");
                }

                std::ostringstream json;
                json << '[';
                for (uint32_t i = 0; i < count; ++i)
                {
                    std::string type;
                    std::string data;
                    if (!readBytes(pos, end, type) || !readBytes(pos, end, data))
                    {
                        throw std::runtime_error("invalid batch row payload");
                    }

                    if (i > 0)
                    {
                        json << ',';
                    }
                    json << deserializeType(worker, type, data.data(), data.size());
                }
                json << ']';

                return makeOkMsgpackFromJson(json.str());
            }

            if (job.op == kOpDeserializeBlock)
            {
                std::string block_type;
                std::string block_data;
                std::string traces_data;
                std::string deltas_data;
                std::unordered_set<std::string> whitelist;

                if (!readBytes(pos, end, block_type) || !readBytes(pos, end, block_data) ||
                    !readBytes(pos, end, traces_data) || !readBytes(pos, end, deltas_data) ||
                    !readWhitelist(pos, end, whitelist))
                {
                    throw std::runtime_error("invalid block deserialize payload");
                }

                std::ostringstream json;
                json << '{';

                json << "\"block\":";
                if (!block_type.empty() && !block_data.empty())
                {
                    json << deserializeType(worker, block_type, block_data.data(), block_data.size());
                }
                else
                {
                    json << "null";
                }

                json << ",\"traces\":";
                if (!traces_data.empty())
                {
                    const std::string traces_json = deserializeType(
                        worker, "transaction_trace[]", traces_data.data(), traces_data.size());
                    json << filterTracesJson(worker, traces_json, {});
                }
                else
                {
                    json << "null";
                }

                json << ",\"deltas\":";
                if (!deltas_data.empty())
                {
                    json << deserializeDeltasWithFilters(worker, deltas_data.data(), deltas_data.size(), whitelist, {});
                }
                else
                {
                    json << "null";
                }

                json << ",\"deltas_processed\":true";
                json << '}';
                return makeOkMsgpackFromJson(json.str());
            }

            if (job.op == kOpProcessShipMessage)
            {
                std::string ship_bytes;
                if (!readBytes(pos, end, ship_bytes) || pos != end)
                {
                    throw std::runtime_error("invalid process ship message payload");
                }

                const auto parsed = ship_sidecar::parseShipResultAbieos(
                    worker.context, ship_bytes.data(), ship_bytes.size());

                std::vector<ship_sidecar::TraceFilterRule> trace_rules;
                trace_rules.reserve(worker.trace_filters.size());
                for (const auto &filter : worker.trace_filters)
                {
                    trace_rules.push_back({filter.contract, filter.action});
                }

                std::vector<ship_sidecar::TableFilterRule> table_rules;
                table_rules.reserve(worker.table_filters.size());
                for (const auto &filter : worker.table_filters)
                {
                    table_rules.push_back({filter.code, filter.table});
                }

                return makeOkMsgpackResponse(ship_sidecar::processParsedBlocksResultMsgpack(
                    worker.context, parsed, worker.delta_types, trace_rules, table_rules));
            }

            if (job.op == kOpSetFilters)
            {
                worker.delta_types.clear();
                worker.trace_filters.clear();
                worker.table_filters.clear();

                if (!readWhitelist(pos, end, worker.delta_types) || !readTraceFilters(pos, end, worker.trace_filters) ||
                    !readTableFilters(pos, end, worker.table_filters))
                {
                    throw std::runtime_error("invalid set filters payload");
                }

                return makeOkMsgpackFromJson("{\"ok\":true}");
            }

            if (job.op == kOpSetAbi)
            {
                std::string contract;
                std::string abi_json;
                if (!readBytes(pos, end, contract) || !readBytes(pos, end, abi_json))
                {
                    throw std::runtime_error("invalid set abi payload");
                }

                setContractAbi(worker, contract, abi_json);
                return makeOkMsgpackFromJson("{\"ok\":true}");
            }

            if (job.op == kOpSetShipAbi)
            {
                std::string abi_json;
                if (!readBytes(pos, end, abi_json))
                {
                    throw std::runtime_error("invalid set ship abi payload");
                }

                if (!abieos_set_abi(worker.context, kShipContract, abi_json.c_str()))
                {
                    const char *err = abieos_get_error(worker.context);
                    throw std::runtime_error(
                        std::string("abieos_set_abi failed for ship: ") + (err ? err : "unknown"));
                }

                return makeOkMsgpackFromJson("{\"ok\":true}");
            }

            if (job.op == kOpDeserializeContractBatch)
            {
                uint32_t count = 0;
                if (!readU32(pos, end, count))
                {
                    throw std::runtime_error("invalid contract batch count");
                }

                std::ostringstream json;
                json << '[';
                for (uint32_t i = 0; i < count; ++i)
                {
                    std::string contract;
                    std::string type;
                    std::string data;
                    if (!readBytes(pos, end, contract) || !readBytes(pos, end, type) || !readBytes(pos, end, data))
                    {
                        throw std::runtime_error("invalid contract batch row payload");
                    }

                    if (i > 0)
                    {
                        json << ',';
                    }
                    json << deserializeContractType(worker, contract, type, data.data(), data.size());
                }
                json << ']';

                return makeOkMsgpackFromJson(json.str());
            }

            throw std::runtime_error("unsupported op: " + std::to_string(job.op));
        }

        std::atomic<bool> stop_;

        std::vector<std::unique_ptr<Worker>> workers_;
        std::vector<std::thread> pool_;

        std::mutex queue_mutex_;
        std::condition_variable queue_cv_;
        std::queue<Job> jobs_;

        std::mutex response_mutex_;
        std::condition_variable response_cv_;
        std::unordered_map<uint32_t, std::vector<char>> responses_;
    };

    bool readExact(std::istream &in, char *buffer, size_t size)
    {
        in.read(buffer, static_cast<std::streamsize>(size));
        return static_cast<size_t>(in.gcount()) == size;
    }

    bool writeExact(std::ostream &out, const char *buffer, size_t size)
    {
        out.write(buffer, static_cast<std::streamsize>(size));
        return out.good();
    }

    bool readMessage(std::istream &in, uint32_t &request_id, uint32_t &op, std::vector<char> &payload)
    {
        uint32_t header[5] = {};
        if (!readExact(in, reinterpret_cast<char *>(header), sizeof(header)))
        {
            return false;
        }

        if (header[0] != kMagic || header[1] != kVersion)
        {
            throw std::runtime_error("invalid message header");
        }

        request_id = header[2];
        op = header[3];
        const uint32_t payload_len = header[4];

        payload.resize(payload_len);
        if (payload_len > 0 && !readExact(in, payload.data(), payload_len))
        {
            return false;
        }

        return true;
    }

    bool writeMessage(std::ostream &out, uint32_t request_id, const std::vector<char> &body)
    {
        uint32_t header[5] = {kMagic, kVersion, request_id, 0, static_cast<uint32_t>(body.size())};
        if (!writeExact(out, reinterpret_cast<const char *>(header), sizeof(header)))
        {
            return false;
        }

        if (!body.empty() && !writeExact(out, body.data(), body.size()))
        {
            return false;
        }

        out.flush();
        return out.good();
    }

    void runStdio(Sidecar &sidecar)
    {
        std::ios_base::sync_with_stdio(false);
        std::cin.tie(nullptr);

        while (true)
        {
            uint32_t request_id = 0;
            uint32_t op = 0;
            std::vector<char> payload;

            if (!readMessage(std::cin, request_id, op, payload))
            {
                break;
            }

            if (op == kOpShutdown)
            {
                writeMessage(std::cout, request_id, makeOkMsgpackFromJson("{\"shutdown\":true}"));
                break;
            }

            Job job{request_id, op, std::move(payload)};
            sidecar.enqueue(std::move(job));

            std::vector<char> response;
            if (!sidecar.waitResponse(request_id, response))
            {
                std::cerr << "ship-sidecar: response timeout for request " << request_id << std::endl;
                break;
            }

            if (!writeMessage(std::cout, request_id, response))
            {
                break;
            }
        }
    }

    size_t parseThreadCount(int argc, char **argv)
    {
        for (int i = 1; i < argc; ++i)
        {
            if (std::string(argv[i]) == "--threads" && i + 1 < argc)
            {
                return std::max<size_t>(1, std::stoul(argv[i + 1]));
            }
        }

        const char *env = std::getenv("SHIP_SIDECAR_THREADS");
        if (env && *env)
        {
            return std::max<size_t>(1, std::stoul(env));
        }

        return std::max<size_t>(1, std::thread::hardware_concurrency());
    }

} // namespace

int main(int argc, char **argv)
{
    try
    {
        const size_t threads = parseThreadCount(argc, argv);
        Sidecar sidecar(threads);

        std::cerr << "ship-sidecar ready (" << threads << " threads, stdio v2 msgpack)" << std::endl;
        runStdio(sidecar);
        sidecar.stop();
        return 0;
    }
    catch (const std::exception &ex)
    {
        std::cerr << "ship-sidecar fatal: " << ex.what() << std::endl;
        return 1;
    }
}
