-- Host port for the model-prediction filter (Lua 5.4, librime-lua).
--
-- The filter never reaches the operating system directly: the RIME user
-- directory, the wall clock, randomness, file byte access and the on-demand
-- sidecar launch all pass through this module. Inside Weasel the functions
-- below are the real thing; the test harness swaps the whole module for a
-- stand-in, exactly the way the fake sidecar script stands in for the
-- companion process (spec #18, Testing Decisions).
--
-- Keep both sides in step: `tests/fixtures/lua/model_predict_host_stub.lua`
-- implements exactly this function set, and a test compares the two lists.

local M = {}

-- Randomness ---------------------------------------------------------------

local seeded = false

local function ensure_seed()
    if seeded then return end
    seeded = true
    -- os.clock is the only sub-second source Lua offers here; a missing clock
    -- must not break the filter, so the whole seeding step stays guarded.
    local clock = os.clock
    local salt = type(clock) == "function" and math.floor(clock() * 1000000) or 0
    pcall(math.randomseed, os.time() + salt)
    for _ = 1, 8 do math.random() end
end

local function random_byte()
    return ("%02x"):format(math.random(0, 255))
end

--- `bytes` random bytes as lowercase hex; 20 bytes is the engine id, 16 the
--- request id (see `src/domain/ids.ts`).
function M.random_hex(bytes)
    ensure_seed()
    local parts = {}
    for index = 1, bytes do parts[index] = random_byte() end
    return table.concat(parts)
end

-- Clock and environment ----------------------------------------------------

function M.time()
    return os.time()
end

function M.getenv(name)
    return os.getenv(name)
end

-- File bytes ---------------------------------------------------------------

--- Whole file as a string, or nil when it is missing or larger than `maximum`.
function M.read_file(path, maximum)
    local file = io.open(path, "rb")
    if not file then return nil end
    local data = file:read("*a")
    file:close()
    if type(data) ~= "string" then return nil end
    if maximum and #data > maximum then return nil end
    return data
end

--- Write `data` to `path`; false when any step of the write fails.
function M.write_file(path, data)
    local file = io.open(path, "wb")
    if not file then return false end
    local wrote = file:write(data)
    local flushed = file:flush()
    local closed = file:close()
    return wrote ~= nil and flushed ~= nil and closed ~= nil
end

function M.rename(from, to)
    return os.rename(from, to) ~= nil
end

function M.exists(path)
    local file = io.open(path, "rb")
    if not file then return false end
    file:close()
    return true
end

--- Delete `path`; true when the file is gone afterwards. A sandbox without
--- `os.remove` reports false and the caller keeps its own in-memory guard.
function M.remove(path)
    if type(os.remove) ~= "function" then return false end
    if os.remove(path) ~= nil then return true end
    return not M.exists(path)
end

-- On-demand launch ---------------------------------------------------------

local module_directory = nil
local module_directory_read = false
local launcher = nil
local launcher_missing = false

--- Directory holding this module (trailing separator), or nil when the Lua
--- loader did not give us a path, so the launcher is simply unavailable.
function M.module_directory()
    if module_directory_read then return module_directory end
    module_directory_read = true
    local info = type(debug) == "table" and type(debug.getinfo) == "function" and debug.getinfo(1, "S")
    local source = type(info) == "table" and info.source or nil
    if type(source) ~= "string" then return nil end
    if source:sub(1, 1) == "@" then source = source:sub(2) end
    local directory = source:match("^(.*)[/\\][^/\\]*$")
    if type(directory) ~= "string" or directory == "" then return nil end
    module_directory = directory .. "\\"
    return module_directory
end

local function load_launcher()
    if launcher ~= nil or launcher_missing then return launcher end
    local directory = M.module_directory()
    if directory == nil then
        launcher_missing = true
        return nil
    end
    if type(package) ~= "table" or type(package.loadlib) ~= "function" then
        launcher_missing = true
        return nil
    end
    -- The launcher DLL ships with the plugin and starts the companion process;
    -- which executable it starts is the installer's business (#26/#28), not the
    -- filter's. A missing launcher is a silent no-prediction state.
    local start = package.loadlib(directory .. "rime_model_predict_launcher.dll", "rime_model_predict_start")
    if type(start) ~= "function" then
        launcher_missing = true
        return nil
    end
    launcher = start
    return launcher
end

--- Ask the launcher for a sidecar process. True only when a launcher was
--- actually invoked; the filter treats a missing launcher as "no prediction".
function M.start_sidecar()
    local start = load_launcher()
    if start == nil then return false end
    return pcall(start)
end

return M
