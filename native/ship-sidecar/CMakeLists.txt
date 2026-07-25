cmake_minimum_required(VERSION 3.16)
project(ship-sidecar VERSION 0.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

set(SKIP_SUBMODULE_CHECK ON CACHE BOOL "" FORCE)
set(ABIEOS_ONLY_LIBRARY ON CACHE BOOL "" FORCE)

FetchContent_Declare(
    abieos
    GIT_REPOSITORY https://github.com/AntelopeIO/abieos.git
    GIT_TAG f7d5b45c1a39dcc639d325aaf33cd2ae09ab3b4b
)
FetchContent_MakeAvailable(abieos)

find_package(Threads REQUIRED)

add_executable(ship-sidecar
    main.cpp
    ${abieos_SOURCE_DIR}/src/abieos.cpp
    ${abieos_SOURCE_DIR}/src/ship.abi.cpp
)

target_include_directories(ship-sidecar PRIVATE
    ${abieos_SOURCE_DIR}/include
    ${abieos_SOURCE_DIR}/src
    ${abieos_SOURCE_DIR}/external/rapidjson/include
)
target_link_libraries(ship-sidecar PRIVATE abieos Threads::Threads)

if(MSVC)
    target_compile_options(ship-sidecar PRIVATE /W3)
else()
    target_compile_options(ship-sidecar PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()
