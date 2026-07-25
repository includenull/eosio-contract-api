#pragma once

#include <cctype>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace ship_sidecar {

inline int hexValue(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

inline std::vector<char> hexToBytes(const std::string& hex) {
    std::vector<char> out;
    if (hex.empty()) {
        return out;
    }

    if (hex.size() % 2 != 0) {
        throw std::runtime_error("invalid hex string length");
    }

    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        const int hi = hexValue(hex[i]);
        const int lo = hexValue(hex[i + 1]);
        if (hi < 0 || lo < 0) {
            throw std::runtime_error("invalid hex string");
        }
        out.push_back(static_cast<char>((hi << 4) | lo));
    }

    return out;
}

} // namespace ship_sidecar
