#pragma once

#include <cstdint>
#include <string>

namespace ship_sidecar {

inline std::string nameToString(uint64_t name) {
    if (name == 0) {
        return {};
    }

    static const char* charmap = ".12345abcdefghijklmnopqrstuvwxyz";
    std::string result(13, ' ');
    uint64_t tmp = name;

    for (uint32_t i = 0; i <= 12; ++i) {
        const char c = charmap[tmp & (i == 0 ? 0x0f : 0x1f)];
        result[12 - i] = c;
        tmp >>= (i == 0 ? 4 : 5);
    }

    while (!result.empty() && result.back() == '.') {
        result.pop_back();
    }

    return result;
}

} // namespace ship_sidecar
