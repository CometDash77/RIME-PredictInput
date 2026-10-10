-- Stand-in for `assets/lua/model_predict_host.lua` used by the harness.
--
-- Implements exactly the same function set, but every observation goes out
-- through a bridge global that the test process installs, so files really are
-- read and written on disk while the clock and the sidecar launch stay under
-- the test's control.
--
-- Note for callers: wasmoon turns `null`/`undefined` returns from JavaScript
-- into a hard crash, so the bridge uses "" for "nothing" and this module turns
-- it back into nil.

local M = {}

local function present(value)
    if type(value) ~= "string" or value == "" then return nil end
    return value
end

function M.getenv(name)
    return present(__host_getenv(name))
end

function M.time()
    return __host_time()
end

function M.read_file(path, maximum)
    return present(__host_read_file(path, maximum))
end

function M.write_file(path, data)
    return __host_write_file(path, data)
end

function M.rename(from, to)
    return __host_rename(from, to)
end

function M.exists(path)
    return __host_exists(path)
end

function M.remove(path)
    return __host_remove(path)
end

function M.random_hex(bytes)
    return __host_random_hex(bytes)
end

function M.start_sidecar()
    return __host_start_sidecar()
end

function M.module_directory()
    return present(__host_module_directory())
end

return M
