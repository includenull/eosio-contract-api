#pragma once

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include <rapidjson/document.h>

namespace ship_sidecar {

inline void appendByte(std::vector<char>& out, uint8_t value) {
    out.push_back(static_cast<char>(value));
}

inline void appendBytesRaw(std::vector<char>& out, const char* data, size_t size) {
    out.insert(out.end(), data, data + size);
}

inline void appendUint16BE(std::vector<char>& out, uint16_t value) {
    appendByte(out, static_cast<uint8_t>(value >> 8));
    appendByte(out, static_cast<uint8_t>(value));
}

inline void appendUint32BE(std::vector<char>& out, uint32_t value) {
    appendByte(out, static_cast<uint8_t>(value >> 24));
    appendByte(out, static_cast<uint8_t>(value >> 16));
    appendByte(out, static_cast<uint8_t>(value >> 8));
    appendByte(out, static_cast<uint8_t>(value));
}

inline void appendInt64BE(std::vector<char>& out, int64_t value) {
    char bytes[8];
    std::memcpy(bytes, &value, 8);
    for (int i = 7; i >= 0; --i) {
        appendByte(out, static_cast<uint8_t>(bytes[i]));
    }
}

inline void appendDoubleBE(std::vector<char>& out, double value) {
    char bytes[8];
    std::memcpy(bytes, &value, 8);
    for (int i = 7; i >= 0; --i) {
        appendByte(out, static_cast<uint8_t>(bytes[i]));
    }
}

inline void appendMsgpackString(std::vector<char>& out, const char* data, size_t size) {
    if (size <= 31) {
        appendByte(out, static_cast<uint8_t>(0xa0 | size));
    } else if (size <= 255) {
        appendByte(out, 0xd9);
        appendByte(out, static_cast<uint8_t>(size));
    } else if (size <= 65535) {
        appendByte(out, 0xda);
        appendUint16BE(out, static_cast<uint16_t>(size));
    } else {
        appendByte(out, 0xdb);
        appendUint32BE(out, static_cast<uint32_t>(size));
    }
    appendBytesRaw(out, data, size);
}

inline void appendMsgpackArrayHeader(std::vector<char>& out, size_t size) {
    if (size <= 15) {
        appendByte(out, static_cast<uint8_t>(0x90 | size));
    } else if (size <= 65535) {
        appendByte(out, 0xdc);
        appendUint16BE(out, static_cast<uint16_t>(size));
    } else {
        appendByte(out, 0xdd);
        appendUint32BE(out, static_cast<uint32_t>(size));
    }
}

inline void appendMsgpackMapHeader(std::vector<char>& out, size_t size) {
    if (size <= 15) {
        appendByte(out, static_cast<uint8_t>(0x80 | size));
    } else if (size <= 65535) {
        appendByte(out, 0xde);
        appendUint16BE(out, static_cast<uint16_t>(size));
    } else {
        appendByte(out, 0xdf);
        appendUint32BE(out, static_cast<uint32_t>(size));
    }
}

void appendMsgpackValue(std::vector<char>& out, const rapidjson::Value& value);

inline void appendMsgpackObject(std::vector<char>& out, const rapidjson::Value& object) {
    appendMsgpackMapHeader(out, object.MemberCount());
    for (auto it = object.MemberBegin(); it != object.MemberEnd(); ++it) {
        appendMsgpackString(out, it->name.GetString(), it->name.GetStringLength());
        appendMsgpackValue(out, it->value);
    }
}

inline void appendMsgpackArray(std::vector<char>& out, const rapidjson::Value& array) {
    appendMsgpackArrayHeader(out, array.Size());
    for (auto it = array.Begin(); it != array.End(); ++it) {
        appendMsgpackValue(out, *it);
    }
}

inline void appendMsgpackValue(std::vector<char>& out, const rapidjson::Value& value) {
    switch (value.GetType()) {
        case rapidjson::kNullType:
            appendByte(out, 0xc0);
            break;
        case rapidjson::kFalseType:
            appendByte(out, 0xc2);
            break;
        case rapidjson::kTrueType:
            appendByte(out, 0xc3);
            break;
        case rapidjson::kStringType:
            appendMsgpackString(out, value.GetString(), value.GetStringLength());
            break;
        case rapidjson::kNumberType:
            if (value.IsInt64()) {
                appendByte(out, 0xd3);
                appendInt64BE(out, value.GetInt64());
            } else if (value.IsUint64()) {
                if (value.GetUint64() <= static_cast<uint64_t>(9007199254740991ULL)) {
                    appendByte(out, 0xd3);
                    appendInt64BE(out, static_cast<int64_t>(value.GetUint64()));
                } else {
                    char buffer[32];
                    const auto len = std::snprintf(buffer, sizeof(buffer), "%llu",
                        static_cast<unsigned long long>(value.GetUint64()));
                    appendMsgpackString(out, buffer, static_cast<size_t>(len));
                }
            } else if (value.IsDouble()) {
                appendByte(out, 0xcb);
                appendDoubleBE(out, value.GetDouble());
            } else if (value.IsInt()) {
                appendByte(out, 0xd3);
                appendInt64BE(out, value.GetInt64());
            } else if (value.IsUint()) {
                appendByte(out, 0xce);
                appendUint32BE(out, value.GetUint());
            } else {
                appendByte(out, 0xcb);
                appendDoubleBE(out, value.GetDouble());
            }
            break;
        case rapidjson::kArrayType:
            appendMsgpackArray(out, value);
            break;
        case rapidjson::kObjectType:
            appendMsgpackObject(out, value);
            break;
        default:
            throw std::runtime_error("unsupported json type for msgpack encoding");
    }
}

inline std::vector<char> jsonToMsgpack(const std::string& json) {
    rapidjson::Document doc;
    doc.Parse(json.c_str(), json.size());
    if (doc.HasParseError()) {
        throw std::runtime_error("failed to parse abieos json for msgpack encoding");
    }

    std::vector<char> out;
    out.reserve(json.size() / 2);
    appendMsgpackValue(out, doc);
    return out;
}

} // namespace ship_sidecar
