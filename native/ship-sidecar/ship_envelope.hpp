#pragma once

#include "hex_utils.hpp"

#include <cstring>

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace ship_sidecar {

struct BlockPosition {
    uint32_t block_num = 0;
    std::string block_id_hex;
};

struct ParsedBlocksResult {
    uint32_t variant_index = 0;
    uint32_t version = 0;
    std::string result_type;
    BlockPosition head;
    BlockPosition last_irreversible;
    std::optional<BlockPosition> this_block;
    std::optional<BlockPosition> prev_block;
    std::vector<char> block;
    std::vector<char> traces;
    std::vector<char> deltas;
    bool has_block = false;
    bool has_traces = false;
    bool has_deltas = false;
};

class BinReader {
public:
    BinReader(const char* data, size_t size) : pos_(data), end_(data + size) {}

    bool readU8(uint8_t& value) {
        if (pos_ >= end_) {
            return false;
        }
        value = static_cast<uint8_t>(*pos_++);
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

    bool readBytes(std::vector<char>& out) {
        uint32_t size = 0;
        if (!readVaruint32(size) || static_cast<size_t>(end_ - pos_) < size) {
            return false;
        }
        out.assign(pos_, pos_ + size);
        pos_ += size;
        return true;
    }

    bool readChecksum256(std::string& hex_out) {
        if (static_cast<size_t>(end_ - pos_) < 32) {
            return false;
        }
        hex_out = ship_sidecar::bytesToHex(pos_, 32);
        pos_ += 32;
        return true;
    }

    bool readBlockPosition(BlockPosition& out) {
        if (!readU32(out.block_num) || !readChecksum256(out.block_id_hex)) {
            return false;
        }
        return true;
    }

    bool readOptionalBlockPosition(std::optional<BlockPosition>& out) {
        uint8_t present = 0;
        if (!readU8(present)) {
            return false;
        }
        if (present == 0) {
            out.reset();
            return true;
        }
        BlockPosition value;
        if (!readBlockPosition(value)) {
            return false;
        }
        out = value;
        return true;
    }

    bool readOptionalBytes(std::vector<char>& out, bool& has_value) {
        uint8_t present = 0;
        if (!readU8(present)) {
            return false;
        }
        if (present == 0) {
            out.clear();
            has_value = false;
            return true;
        }
        has_value = readBytes(out);
        return has_value;
    }

private:
    const char* pos_;
    const char* end_;
};

inline uint32_t versionFromVariantIndex(uint32_t index) {
    if (index == 1) {
        return 0;
    }
    if (index == 2) {
        return 1;
    }
    if (index >= 3) {
        return 2;
    }
    throw std::runtime_error("unsupported ship result variant index: " + std::to_string(index));
}

inline std::string resultTypeFromVersion(uint32_t version) {
    if (version == 0) {
        return "get_blocks_result_v0";
    }
    if (version == 1) {
        return "get_blocks_result_v1";
    }
    return "get_blocks_result_v2";
}

inline ParsedBlocksResult parseShipResult(const char* data, size_t size) {
    BinReader reader(data, size);

    uint32_t variant_index = 0;
    if (!reader.readU32(variant_index)) {
        throw std::runtime_error("ship result too short for variant index");
    }

    if (variant_index == 0 || variant_index == 3) {
        throw std::runtime_error("ship result is not a get_blocks_result variant");
    }

    ParsedBlocksResult result;
    result.variant_index = variant_index;
    result.version = versionFromVariantIndex(variant_index);
    result.result_type = resultTypeFromVersion(result.version);

    if (!reader.readBlockPosition(result.head) || !reader.readBlockPosition(result.last_irreversible)) {
        throw std::runtime_error("failed to parse get_blocks_result header positions");
    }

    if (!reader.readOptionalBlockPosition(result.this_block) ||
        !reader.readOptionalBlockPosition(result.prev_block)) {
        throw std::runtime_error("failed to parse get_blocks_result block positions");
    }

    if (!reader.readOptionalBytes(result.block, result.has_block) ||
        !reader.readOptionalBytes(result.traces, result.has_traces) ||
        !reader.readOptionalBytes(result.deltas, result.has_deltas)) {
        throw std::runtime_error("failed to parse get_blocks_result payload bytes");
    }

    if (result.version >= 1) {
        std::vector<char> finality_data;
        bool has_finality = false;
        if (!reader.readOptionalBytes(finality_data, has_finality)) {
            throw std::runtime_error("failed to parse get_blocks_result finality_data");
        }
    }

    return result;
}

} // namespace ship_sidecar
