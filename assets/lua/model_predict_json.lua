-- Minimal JSON codec for the model-prediction file protocol (Lua 5.4).
local M = {}
local floor = math.floor
local MOD = 0x100000000
local MASK = 0xffffffff

local function utf8_char(codepoint)
    if codepoint >= 0xd800 and codepoint <= 0xdfff then error("invalid_json") end
    return utf8.char(codepoint)
end

function M.decode(source)
    if type(source) ~= "string" then error("invalid_json") end
    local index, length = 1, #source
    local function whitespace()
        while index <= length do
            local byte = source:byte(index)
            if byte ~= 32 and byte ~= 9 and byte ~= 10 and byte ~= 13 then break end
            index = index + 1
        end
    end
    local parse_value
    local function parse_string()
        if source:byte(index) ~= 34 then error("invalid_json") end
        index = index + 1
        local chunks, start = {}, index
        while index <= length do
            local byte = source:byte(index)
            if byte == 34 then
                chunks[#chunks + 1] = source:sub(start, index - 1)
                index = index + 1
                return table.concat(chunks)
            elseif byte == 92 then
                chunks[#chunks + 1] = source:sub(start, index - 1)
                index = index + 1
                local escape = source:sub(index, index)
                local simple = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
                if simple[escape] then
                    chunks[#chunks + 1] = simple[escape]
                    index = index + 1
                elseif escape == "u" then
                    local hex = source:sub(index + 1, index + 4)
                    local codepoint = tonumber(hex, 16)
                    if not codepoint then error("invalid_json") end
                    index = index + 5
                    if codepoint >= 0xd800 and codepoint <= 0xdbff then
                        if source:sub(index, index + 1) ~= "\\u" then error("invalid_json") end
                        local low = tonumber(source:sub(index + 2, index + 5), 16)
                        if not low or low < 0xdc00 or low > 0xdfff then error("invalid_json") end
                        codepoint = 0x10000 + (codepoint - 0xd800) * 0x400 + low - 0xdc00
                        index = index + 6
                    end
                    chunks[#chunks + 1] = utf8_char(codepoint)
                else
                    error("invalid_json")
                end
                start = index
            elseif byte < 32 then
                error("invalid_json")
            else
                index = index + 1
            end
        end
        error("invalid_json")
    end
    local function parse_number()
        local tail = source:sub(index)
        local token = tail:match("^(%-?%d+%.?%d*[eE]?[+-]?%d*)")
        if not token or token == "" or token:match("^%-?0%d") then error("invalid_json") end
        local value = tonumber(token)
        if not value or value ~= value or value == math.huge or value == -math.huge then error("invalid_json") end
        index = index + #token
        return value
    end
    local function parse_array(depth)
        index = index + 1
        whitespace()
        local value = {}
        if source:byte(index) == 93 then index = index + 1; return value end
        while true do
            value[#value + 1] = parse_value(depth + 1)
            whitespace()
            local byte = source:byte(index)
            if byte == 93 then index = index + 1; return value end
            if byte ~= 44 then error("invalid_json") end
            index = index + 1
            whitespace()
        end
    end
    local function parse_object(depth)
        index = index + 1
        whitespace()
        local value = {}
        if source:byte(index) == 125 then index = index + 1; return value end
        while true do
            local key = parse_string()
            whitespace()
            if source:byte(index) ~= 58 then error("invalid_json") end
            index = index + 1
            whitespace()
            value[key] = parse_value(depth + 1)
            whitespace()
            local byte = source:byte(index)
            if byte == 125 then index = index + 1; return value end
            if byte ~= 44 then error("invalid_json") end
            index = index + 1
            whitespace()
        end
    end
    parse_value = function(depth)
        if depth > 64 then error("invalid_json") end
        whitespace()
        local byte = source:byte(index)
        if byte == 34 then return parse_string() end
        if byte == 123 then return parse_object(depth) end
        if byte == 91 then return parse_array(depth) end
        if source:sub(index, index + 3) == "true" then index = index + 4; return true end
        if source:sub(index, index + 4) == "false" then index = index + 5; return false end
        if source:sub(index, index + 3) == "null" then index = index + 4; return M.null end
        if byte == 45 or (byte and byte >= 48 and byte <= 57) then return parse_number() end
        error("invalid_json")
    end
    local value = parse_value(0)
    whitespace()
    if index <= length then error("invalid_json") end
    return value
end

local function quote(value)
    return '"' .. value:gsub('[%z\1-\31\\"]', function(char)
        local escapes = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
        return escapes[char] or ("\\u%04x"):format(char:byte())
    end) .. '"'
end

local function is_array(value)
    local count, maximum = 0, 0
    for key in pairs(value) do
        if type(key) ~= "number" or key < 1 or key ~= floor(key) then return false end
        count = count + 1
        if key > maximum then maximum = key end
    end
    return count > 0 and count == maximum
end

local function encode_value(value, depth)
    if depth > 64 then error("invalid_json") end
    local kind = type(value)
    if value == M.null then return "null" end
    if kind == "nil" then error("invalid_json") end
    if kind == "boolean" then return value and "true" or "false" end
    if kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then error("invalid_json") end
        return ("%.17g"):format(value)
    end
    if kind == "string" then return quote(value) end
    if kind ~= "table" then error("invalid_json") end
    local parts = {}
    if is_array(value) then
        for index = 1, #value do parts[index] = encode_value(value[index], depth + 1) end
        return "[" .. table.concat(parts, ",") .. "]"
    end
    for key, item in pairs(value) do
        if type(key) ~= "string" then error("invalid_json") end
        parts[#parts + 1] = quote(key) .. ":" .. encode_value(item, depth + 1)
    end
    table.sort(parts)
    return "{" .. table.concat(parts, ",") .. "}"
end

function M.encode(value)
    return encode_value(value, 0)
end

local K = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local function add(...)
    local sum = 0
    for index = 1, select("#", ...) do sum = sum + select(index, ...) end
    return sum & MASK
end
local function rotate(value, count)
    return ((value >> count) | (value << (32 - count))) & MASK
end

function M.sha256(message)
    local bit_length = #message * 8
    local padding = (56 - ((#message + 1) % 64)) % 64
    message = message .. "\128" .. string.rep("\0", padding) .. string.pack(">I8", bit_length)
    local hash = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }
    for offset = 1, #message, 64 do
        local words = {}
        for index = 0, 15 do words[index] = string.unpack(">I4", message, offset + index * 4) end
        for index = 16, 63 do
            local x, y = words[index - 15], words[index - 2]
            local s0 = rotate(x, 7) ~ rotate(x, 18) ~ (x >> 3)
            local s1 = rotate(y, 17) ~ rotate(y, 19) ~ (y >> 10)
            words[index] = add(words[index - 16], s0, words[index - 7], s1)
        end
        local a, b, c, d, e, f, g, h = table.unpack(hash)
        for index = 0, 63 do
            local s1 = rotate(e, 6) ~ rotate(e, 11) ~ rotate(e, 25)
            local choice = (e & f) ~ ((~e) & g)
            local temp1 = add(h, s1, choice, K[index + 1], words[index])
            local s0 = rotate(a, 2) ~ rotate(a, 13) ~ rotate(a, 22)
            local majority = (a & b) ~ (a & c) ~ (b & c)
            local temp2 = add(s0, majority)
            h, g, f, e, d, c, b, a = g, f, e, add(d, temp1), c, b, a, add(temp1, temp2)
        end
        hash = { add(hash[1], a), add(hash[2], b), add(hash[3], c), add(hash[4], d), add(hash[5], e), add(hash[6], f), add(hash[7], g), add(hash[8], h) }
    end
    local out = {}
    for index = 1, 8 do out[index] = ("%08x"):format(hash[index]) end
    return table.concat(out)
end

M.null = setmetatable({}, { __tostring = function() return "null" end })
return M
