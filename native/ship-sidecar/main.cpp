#include <abieos.h>

#include "hex_utils.hpp"
#include "json_msgpack.hpp"

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

extern const char* const state_history_plugin_abi;

namespace {

constexpr uint32_t kMagic = 0x48504953; // 'SHIP'
constexpr uint32_t kVersion = 2;

constexpr uint32_t kOpPing = 0;
constexpr uint32_t kOpDeserialize = 1;
constexpr uint32_t kOpDeserializeBatch = 2;
constexpr uint32_t kOpDeserializeBlock = 3;
constexpr uint32_t kOpSetAbi = 4;
constexpr uint32_t kOpDeserializeContractBatch = 5;
constexpr uint32_t kOpShutdown = 255;

constexpr uint32_t kFormatText = 0;
constexpr uint32_t kFormatMsgpack = 1;

constexpr uint64_t kShipContract = 2;

struct Job {
    uint32_t request_id = 0;
    uint32_t op = 0;
    std::vector<char> payload;
};

struct Worker {
    explicit Worker(size_t index) : index(index) {
        context = abieos_create();
        if (!context) {
            throw std::runtime_error("abieos_create failed for worker " + std::to_string(index));
        }

        if (!abieos_set_abi(context, kShipContract, state_history_plugin_abi)) {
            const char* err = abieos_get_error(context);
            throw std::runtime_error(std::string("abieos_set_abi failed: ") + (err ? err : "unknown"));
        }
    }

    ~Worker() {
        if (context) {
            abieos_destroy(context);
        }
    }

    Worker(const Worker&) = delete;
    Worker& operator=(const Worker&) = delete;

    size_t index;
    abieos_context* context = nullptr;
};

std::vector<char> makeErrorResponse(const std::string& message) {
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

std::vector<char> makeOkMsgpackResponse(const std::vector<char>& msgpack) {
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

std::vector<char> makeOkMsgpackFromJson(const std::string& json) {
    return makeOkMsgpackResponse(ship_sidecar::jsonToMsgpack(json));
}

class Sidecar {
public:
    explicit Sidecar(size_t thread_count) : stop_(false) {
        workers_.reserve(thread_count);
        for (size_t i = 0; i < thread_count; ++i) {
            workers_.emplace_back(std::make_unique<Worker>(i));
        }

        for (size_t i = 0; i < thread_count; ++i) {
            pool_.emplace_back([this, i]() { workerLoop(i); });
        }
    }

    ~Sidecar() {
        stop();
    }

    void stop() {
        if (stop_.exchange(true)) {
            return;
        }

        queue_cv_.notify_all();

        for (auto& thread : pool_) {
            if (thread.joinable()) {
                thread.join();
            }
        }
    }

    void enqueue(Job job) {
        {
            std::lock_guard<std::mutex> lock(queue_mutex_);
            jobs_.push(std::move(job));
        }
        queue_cv_.notify_one();
    }

    bool waitResponse(uint32_t request_id, std::vector<char>& response, int timeout_ms = 120000) {
        std::unique_lock<std::mutex> lock(response_mutex_);
        const auto ready = [this, request_id]() {
            return responses_.count(request_id) > 0 || stop_.load();
        };

        if (timeout_ms > 0) {
            if (!response_cv_.wait_for(lock, std::chrono::milliseconds(timeout_ms), ready)) {
                return false;
            }
        } else {
            response_cv_.wait(lock, ready);
        }

        auto it = responses_.find(request_id);
        if (it == responses_.end()) {
            return false;
        }

        response = std::move(it->second);
        responses_.erase(it);
        return true;
    }

private:
    void submitResponse(uint32_t request_id, std::vector<char> response) {
        {
            std::lock_guard<std::mutex> lock(response_mutex_);
            responses_[request_id] = std::move(response);
        }
        response_cv_.notify_all();
    }

    void workerLoop(size_t worker_index) {
        Worker& worker = *workers_[worker_index];

        while (true) {
            Job job;
            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                queue_cv_.wait(lock, [this]() { return stop_.load() || !jobs_.empty(); });

                if (stop_.load() && jobs_.empty()) {
                    return;
                }

                job = std::move(jobs_.front());
                jobs_.pop();
            }

            try {
                submitResponse(job.request_id, handleJob(worker, job));
            } catch (const std::exception& ex) {
                submitResponse(job.request_id, makeErrorResponse(ex.what()));
            }
        }
    }

    static bool readU32(const char*& pos, const char* end, uint32_t& value) {
        if (end - pos < 4) {
            return false;
        }
        std::memcpy(&value, pos, 4);
        pos += 4;
        return true;
    }

    static bool readBytes(const char*& pos, const char* end, std::string& value) {
        uint32_t size = 0;
        if (!readU32(pos, end, size) || static_cast<size_t>(end - pos) < size) {
            return false;
        }
        value.assign(pos, size);
        pos += size;
        return true;
    }

    static bool readWhitelist(const char*& pos, const char* end, std::unordered_set<std::string>& whitelist) {
        uint32_t count = 0;
        if (!readU32(pos, end, count)) {
            return false;
        }

        for (uint32_t i = 0; i < count; ++i) {
            std::string name;
            if (!readBytes(pos, end, name)) {
                return false;
            }
            whitelist.insert(std::move(name));
        }

        return true;
    }

    std::string deserializeType(Worker& worker, const std::string& type, const char* data, size_t size) {
        const char* json = abieos_bin_to_json(worker.context, kShipContract, type.c_str(), data, size);
        if (!json) {
            const char* err = abieos_get_error(worker.context);
            throw std::runtime_error(std::string("abieos_bin_to_json failed for type ") + type + ": " + (err ? err : "unknown"));
        }
        return json;
    }

    std::string deserializeContractType(
        Worker& worker,
        const std::string& contract,
        const std::string& type,
        const char* data,
        size_t size
    ) {
        const uint64_t contract_id = abieos_string_to_name(worker.context, contract.c_str());
        const char* json = abieos_bin_to_json(worker.context, contract_id, type.c_str(), data, size);
        if (!json) {
            const char* err = abieos_get_error(worker.context);
            throw std::runtime_error(
                std::string("abieos_bin_to_json failed for contract ") + contract + " type " + type + ": " +
                (err ? err : "unknown"));
        }
        return json;
    }

    void setContractAbi(Worker& worker, const std::string& contract, const std::string& abi_json) {
        const uint64_t contract_id = abieos_string_to_name(worker.context, contract.c_str());
        if (!abieos_set_abi(worker.context, contract_id, abi_json.c_str())) {
            const char* err = abieos_get_error(worker.context);
            throw std::runtime_error(std::string("abieos_set_abi failed for ") + contract + ": " + (err ? err : "unknown"));
        }
    }

    std::string deserializeDeltasWithWhitelist(
        Worker& worker,
        const char* data,
        size_t size,
        const std::unordered_set<std::string>& whitelist
    ) {
        if (size == 0) {
            return "null";
        }

        std::string deltas_json = deserializeType(worker, "table_delta[]", data, size);

        rapidjson::Document doc;
        doc.Parse(deltas_json.c_str(), deltas_json.size());
        if (doc.HasParseError() || !doc.IsArray()) {
            throw std::runtime_error("failed to parse table_delta[] json");
        }

        for (auto& delta : doc.GetArray()) {
            if (!delta.IsArray() || delta.Size() < 2 || !delta[1].IsObject()) {
                continue;
            }

            rapidjson::Value& body = delta[1];
            if (!body.HasMember("name") || !body["name"].IsString()) {
                continue;
            }

            const std::string name = body["name"].GetString();
            if (whitelist.count(name) == 0 || !body.HasMember("rows") || !body["rows"].IsArray()) {
                continue;
            }

            for (auto& row : body["rows"].GetArray()) {
                if (!row.IsObject() || !row.HasMember("data") || !row["data"].IsString()) {
                    continue;
                }

                const auto bin = ship_sidecar::hexToBytes(row["data"].GetString());
                const std::string row_json = deserializeType(worker, name, bin.data(), bin.size());

                rapidjson::Document row_doc;
                row_doc.Parse(row_json.c_str(), row_json.size());
                if (row_doc.HasParseError()) {
                    throw std::runtime_error("failed to parse delta row json for " + name);
                }

                row["data"].CopyFrom(row_doc, doc.GetAllocator());
            }
        }

        rapidjson::StringBuffer buffer;
        rapidjson::Writer<rapidjson::StringBuffer> writer(buffer);
        doc.Accept(writer);
        return buffer.GetString();
    }

    std::vector<char> handleJob(Worker& worker, const Job& job) {
        const char* pos = job.payload.data();
        const char* end = job.payload.data() + job.payload.size();

        if (job.op == kOpPing) {
            return makeOkMsgpackFromJson("{\"pong\":true}");
        }

        if (job.op == kOpDeserialize) {
            std::string type;
            std::string data;
            if (!readBytes(pos, end, type) || !readBytes(pos, end, data)) {
                throw std::runtime_error("invalid deserialize payload");
            }

            return makeOkMsgpackFromJson(deserializeType(worker, type, data.data(), data.size()));
        }

        if (job.op == kOpDeserializeBatch) {
            uint32_t count = 0;
            if (!readU32(pos, end, count)) {
                throw std::runtime_error("invalid batch count");
            }

            std::ostringstream json;
            json << '[';
            for (uint32_t i = 0; i < count; ++i) {
                std::string type;
                std::string data;
                if (!readBytes(pos, end, type) || !readBytes(pos, end, data)) {
                    throw std::runtime_error("invalid batch row payload");
                }

                if (i > 0) {
                    json << ',';
                }
                json << deserializeType(worker, type, data.data(), data.size());
            }
            json << ']';

            return makeOkMsgpackFromJson(json.str());
        }

        if (job.op == kOpDeserializeBlock) {
            std::string block_type;
            std::string block_data;
            std::string traces_data;
            std::string deltas_data;
            std::unordered_set<std::string> whitelist;

            if (!readBytes(pos, end, block_type) || !readBytes(pos, end, block_data) ||
                !readBytes(pos, end, traces_data) || !readBytes(pos, end, deltas_data) ||
                !readWhitelist(pos, end, whitelist)) {
                throw std::runtime_error("invalid block deserialize payload");
            }

            std::ostringstream json;
            json << '{';

            json << "\"block\":";
            if (!block_type.empty() && !block_data.empty()) {
                json << deserializeType(worker, block_type, block_data.data(), block_data.size());
            } else {
                json << "null";
            }

            json << ",\"traces\":";
            if (!traces_data.empty()) {
                json << deserializeType(worker, "transaction_trace[]", traces_data.data(), traces_data.size());
            } else {
                json << "null";
            }

            json << ",\"deltas\":";
            if (!deltas_data.empty()) {
                json << deserializeDeltasWithWhitelist(
                    worker, deltas_data.data(), deltas_data.size(), whitelist);
            } else {
                json << "null";
            }

            json << ",\"deltas_processed\":true";
            json << '}';
            return makeOkMsgpackFromJson(json.str());
        }

        if (job.op == kOpSetAbi) {
            std::string contract;
            std::string abi_json;
            if (!readBytes(pos, end, contract) || !readBytes(pos, end, abi_json)) {
                throw std::runtime_error("invalid set abi payload");
            }

            setContractAbi(worker, contract, abi_json);
            return makeOkMsgpackFromJson("{\"ok\":true}");
        }

        if (job.op == kOpDeserializeContractBatch) {
            uint32_t count = 0;
            if (!readU32(pos, end, count)) {
                throw std::runtime_error("invalid contract batch count");
            }

            std::ostringstream json;
            json << '[';
            for (uint32_t i = 0; i < count; ++i) {
                std::string contract;
                std::string type;
                std::string data;
                if (!readBytes(pos, end, contract) || !readBytes(pos, end, type) || !readBytes(pos, end, data)) {
                    throw std::runtime_error("invalid contract batch row payload");
                }

                if (i > 0) {
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

bool readExact(std::istream& in, char* buffer, size_t size) {
    in.read(buffer, static_cast<std::streamsize>(size));
    return static_cast<size_t>(in.gcount()) == size;
}

bool writeExact(std::ostream& out, const char* buffer, size_t size) {
    out.write(buffer, static_cast<std::streamsize>(size));
    return out.good();
}

bool readMessage(std::istream& in, uint32_t& request_id, uint32_t& op, std::vector<char>& payload) {
    uint32_t header[5] = {};
    if (!readExact(in, reinterpret_cast<char*>(header), sizeof(header))) {
        return false;
    }

    if (header[0] != kMagic || header[1] != kVersion) {
        throw std::runtime_error("invalid message header");
    }

    request_id = header[2];
    op = header[3];
    const uint32_t payload_len = header[4];

    payload.resize(payload_len);
    if (payload_len > 0 && !readExact(in, payload.data(), payload_len)) {
        return false;
    }

    return true;
}

bool writeMessage(std::ostream& out, uint32_t request_id, const std::vector<char>& body) {
    uint32_t header[5] = {kMagic, kVersion, request_id, 0, static_cast<uint32_t>(body.size())};
    if (!writeExact(out, reinterpret_cast<const char*>(header), sizeof(header))) {
        return false;
    }

    if (!body.empty() && !writeExact(out, body.data(), body.size())) {
        return false;
    }

    out.flush();
    return out.good();
}

void runStdio(Sidecar& sidecar) {
    std::ios_base::sync_with_stdio(false);
    std::cin.tie(nullptr);

    while (true) {
        uint32_t request_id = 0;
        uint32_t op = 0;
        std::vector<char> payload;

        if (!readMessage(std::cin, request_id, op, payload)) {
            break;
        }

        if (op == kOpShutdown) {
            writeMessage(std::cout, request_id, makeOkMsgpackFromJson("{\"shutdown\":true}"));
            break;
        }

        Job job{request_id, op, std::move(payload)};
        sidecar.enqueue(std::move(job));

        std::vector<char> response;
        if (!sidecar.waitResponse(request_id, response)) {
            std::cerr << "ship-sidecar: response timeout for request " << request_id << std::endl;
            break;
        }

        if (!writeMessage(std::cout, request_id, response)) {
            break;
        }
    }
}

size_t parseThreadCount(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--threads" && i + 1 < argc) {
            return std::max<size_t>(1, std::stoul(argv[i + 1]));
        }
    }

    const char* env = std::getenv("SHIP_SIDECAR_THREADS");
    if (env && *env) {
        return std::max<size_t>(1, std::stoul(env));
    }

    return std::max<size_t>(1, std::thread::hardware_concurrency());
}

} // namespace

int main(int argc, char** argv) {
    try {
        const size_t threads = parseThreadCount(argc, argv);
        Sidecar sidecar(threads);

        std::cerr << "ship-sidecar ready (" << threads << " threads, stdio v2 msgpack)" << std::endl;
        runStdio(sidecar);
        sidecar.stop();
        return 0;
    } catch (const std::exception& ex) {
        std::cerr << "ship-sidecar fatal: " << ex.what() << std::endl;
        return 1;
    }
}
