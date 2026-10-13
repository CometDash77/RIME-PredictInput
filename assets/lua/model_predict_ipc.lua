-- File-IPC request/response layer of the model-prediction filter (Lua 5.4).
--
-- This is the Lua half of the frozen file-IPC contract implemented by
-- `src/contracts/envelope.ts` and `src/ipc/file-ipc.ts`:
--
--   requests : <root>/ipc/requests/req-<engine_id>-<seq:020d>-<request_id>.json
--   responses: <root>/ipc/responses/<engine_id>/response-{a|b}.json + .ready
--
-- Wire key order is part of that contract (ADR 0005), so envelopes are built
-- with an explicit key order instead of the sorted-object encoder in
-- `model_predict_json`; the payload itself is ordinary canonical JSON.
--
-- Nothing here blocks: a missing directory, an unreadable file or a broken
-- envelope all come back as nil/false, and the filter stays silent.

local json = require("model_predict_json")
local host = require("model_predict_host")

local M = {}

local PROTOCOL_VERSION = 1
local CONTRACT_VERSION = 1
local ENGINE_ID_BYTES = 20
local REQUEST_ID_BYTES = 16
local MAX_REQUEST_BYTES = 262144
local MAX_RESPONSE_BYTES = 262144
local MAX_MARKER_BYTES = 2048
local MAX_SETTINGS_BYTES = 65536
local RESPONSE_MAX_AGE_SECONDS = 60
local APP_DIRECTORY = ".rime-model-predict"
local REQUEST_DIRECTORY = "ipc\\requests"
local RESPONSE_DIRECTORY = "ipc\\responses"
local DEFAULT_LOCAL_MODEL = "hf.co/HauhauCS/Qwen3.5-2B-Uncensored-HauhauCS-Aggressive:Q4_K_M"
local MODEL_PATTERN = "^[A-Za-z0-9:._/-]+$"
local HEX_PATTERN = "^[0-9a-f]+$"

--- Lua patterns have no counted repetition (`{40}` would be literal braces), so
--- the fixed-width hex fields are checked as "hex of exactly this length".
local function is_hex(value, length)
    return type(value) == "string" and #value == length and value:match(HEX_PATTERN) ~= nil
end

local DEFAULT_SETTINGS = {
    enabled = false,
    --- 生成模式默认关闭（Q6A）：质量未达发布门槛前，它只是随包发布的实验性能力，
    --- 前端不把它当成默认路径。
    generation_enabled = false,
    backend = "local",
    provider = json.null,
    local_model = DEFAULT_LOCAL_MODEL,
    slot = 5,
    local_wait_ms = 150,
    thresholds = {},
    log_mode = "metadata",
}

--- 40 hex characters, minted once per filter instance.
function M.engine_id()
    return host.random_hex(ENGINE_ID_BYTES)
end

--- 32 hex characters, minted once per request.
function M.request_id()
    return host.random_hex(REQUEST_ID_BYTES)
end

--- `%USERPROFILE%\.rime-model-predict`, or nil when the profile is unknown.
function M.root()
    local profile = host.getenv("USERPROFILE")
    if type(profile) ~= "string" or profile == "" then return nil end
    if not (profile:match("^%a:[/\\]") or profile:match("^[/\\][/\\]")) then return nil end
    profile = profile:gsub("[/\\]+$", "")
    if profile == "" then return nil end
    return profile .. "\\" .. APP_DIRECTORY
end

local function settings_table()
    return {
        enabled = DEFAULT_SETTINGS.enabled,
        generation_enabled = DEFAULT_SETTINGS.generation_enabled,
        backend = DEFAULT_SETTINGS.backend,
        provider = DEFAULT_SETTINGS.provider,
        local_model = DEFAULT_SETTINGS.local_model,
        slot = DEFAULT_SETTINGS.slot,
        local_wait_ms = DEFAULT_SETTINGS.local_wait_ms,
        thresholds = DEFAULT_SETTINGS.thresholds,
        log_mode = DEFAULT_SETTINGS.log_mode,
    }
end

local function sanitize_settings(value)
    local settings = settings_table()
    if type(value) ~= "table" then return settings end
    if value.backend ~= "local" then return settings end
    if value.provider ~= nil and value.provider ~= json.null then return settings end
    if value.enabled == true then settings.enabled = true end
    if value.generation_enabled == true then settings.generation_enabled = true end
    local model = value.local_model
    if type(model) == "string" and #model > 0 and #model <= 80 and model:match(MODEL_PATTERN) then
        settings.local_model = model
    end
    local slot = tonumber(value.slot)
    if slot and slot >= 1 and slot <= 2147483647 and slot == math.floor(slot) then
        settings.slot = slot
    end
    local wait = tonumber(value.local_wait_ms)
    if wait and wait >= 1 and wait <= 200 and wait == math.floor(wait) then
        settings.local_wait_ms = wait
    end
    if value.log_mode == "off" or value.log_mode == "metadata" then
        settings.log_mode = value.log_mode
    end
    return settings
end

--- Settings plus their revision. The revision is a digest, never the settings
--- bytes: the request must not carry anything but ordinary preferences
--- (`rejectSecrets` on the sidecar side would refuse the whole request).
function M.read_settings(root)
    local raw = host.read_file(root .. "\\settings.json", MAX_SETTINGS_BYTES)
    local settings = settings_table()
    if raw ~= nil then
        local decoded = nil
        pcall(function() decoded = json.decode(raw) end)
        settings = sanitize_settings(decoded)
    end
    return settings, json.sha256(json.encode(settings))
end

-- Envelope ------------------------------------------------------------------

local function number(value) return json.encode(value) end
local function text(value) return json.encode(value) end

--- Request envelope in the frozen key order of `requestWire`.
local function request_envelope(engine_id, seq, request_id, kind, sent_at, payload)
    return "{" ..
        '"version":' .. number(PROTOCOL_VERSION) ..
        ',"contract_version":' .. number(CONTRACT_VERSION) ..
        ',"engine_id":' .. text(engine_id) ..
        ',"seq":' .. number(seq) ..
        ',"request_id":' .. text(request_id) ..
        ',"kind":' .. text(kind) ..
        ',"sent_at":' .. number(sent_at) ..
        ',"payload":' .. json.encode(payload) ..
        "}"
end

--- Write `req-<engine>-<seq:020d>-<request_id>.json` atomically through a
--- `.part` sibling, and report the identity the caller must remember.
function M.publish(root, engine_id, seq, payload, kind)
    local request_id = M.request_id()
    local sent_at = host.time()
    local data = request_envelope(engine_id, seq, request_id, kind or "predict", sent_at, payload)
    if #data > MAX_REQUEST_BYTES then return nil end
    local stem = root .. "\\" .. REQUEST_DIRECTORY .. "\\req-" .. engine_id .. "-" ..
        ("%020d"):format(seq) .. "-" .. request_id
    if not host.write_file(stem .. ".part", data) then return nil end
    if not host.rename(stem .. ".part", stem .. ".json") then
        host.remove(stem .. ".part")
        return nil
    end
    return { seq = seq, request_id = request_id, sent_at = sent_at }
end

--- Settings-event envelope (`kind == "settings"`), used to cancel a pending
--- prediction. Returns the identity or nil.
function M.publish_event(root, engine_id, seq, payload)
    return M.publish(root, engine_id, seq, payload or {}, "settings")
end

-- Response reading ----------------------------------------------------------

local function slot_for(seq)
    if seq % 2 == 1 then return "a" end
    return "b"
end

local function response_directory(root, engine_id)
    return root .. "\\" .. RESPONSE_DIRECTORY .. "\\" .. engine_id
end

--- Read one response slot. Nil for a missing, oversized, corrupt, stale,
--- unknown-version or mismatched record: every failure is a silent留空.
local function read_slot(root, engine_id, slot, now)
    local directory = response_directory(root, engine_id)
    local marker_text = host.read_file(directory .. "\\response-" .. slot .. ".ready", MAX_MARKER_BYTES)
    if marker_text == nil then return nil end
    local marker = nil
    pcall(function() marker = json.decode(marker_text) end)
    if type(marker) ~= "table" then return nil end
    if marker.version ~= PROTOCOL_VERSION then return nil end
    if type(marker.seq) ~= "number" or marker.seq < 1 or marker.seq ~= math.floor(marker.seq) then return nil end
    if type(marker.bytes) ~= "number" or marker.bytes < 0 or marker.bytes ~= math.floor(marker.bytes) then return nil end
    if not is_hex(marker.sha256, 64) then return nil end

    local body = host.read_file(directory .. "\\response-" .. slot .. ".json", MAX_RESPONSE_BYTES)
    if body == nil then return nil end
    if #body ~= marker.bytes then return nil end
    if json.sha256(body) ~= marker.sha256 then return nil end

    local response = nil
    pcall(function() response = json.decode(body) end)
    if type(response) ~= "table" then return nil end
    if response.version ~= PROTOCOL_VERSION then return nil end
    if response.contract_version ~= CONTRACT_VERSION then return nil end
    if response.engine_id ~= engine_id then return nil end
    if response.seq ~= marker.seq then return nil end
    if not is_hex(response.request_id, 32) then return nil end
    if type(response.payload) ~= "table" then return nil end
    local created_at = response.created_at
    if type(created_at) ~= "number" then return nil end
    if created_at > now + 1 then return nil end
    if now - created_at > RESPONSE_MAX_AGE_SECONDS then return nil end
    response.slot = slot
    return response
end

--- Response recorded for `seq`'s parity slot, or nil.
function M.read_response(root, engine_id, seq, now)
    return read_slot(root, engine_id, slot_for(seq), now or host.time())
end

--- The newest response across both slots, or nil. Used to drop results that
--- belong to a request the filter has already given up on.
function M.read_latest(root, engine_id, now)
    local at = now or host.time()
    local first = read_slot(root, engine_id, "a", at)
    local second = read_slot(root, engine_id, "b", at)
    if first == nil then return second end
    if second == nil then return first end
    if second.seq > first.seq then return second end
    return first
end

--- Delete the files of `response` ("consume and delete"). The marker is read
--- again first, so a newer response that landed in the same slot survives.
function M.consume(root, engine_id, response)
    if type(response) ~= "table" then return false end
    local slot = response.slot or slot_for(response.seq)
    local directory = response_directory(root, engine_id)
    local marker_path = directory .. "\\response-" .. slot .. ".ready"
    local body_path = directory .. "\\response-" .. slot .. ".json"
    local marker_text = host.read_file(marker_path, MAX_MARKER_BYTES)
    if marker_text ~= nil then
        local marker = nil
        pcall(function() marker = json.decode(marker_text) end)
        if type(marker) == "table" and marker.seq ~= response.seq then return false end
        local body = host.read_file(body_path, MAX_RESPONSE_BYTES)
        if body ~= nil then
            local current = nil
            pcall(function() current = json.decode(body) end)
            if type(current) == "table" and current.seq ~= response.seq then return false end
        end
    end
    local removed = host.remove(marker_path)
    removed = host.remove(body_path) and removed
    return removed
end

--- Ask the launcher for a sidecar process (no-op when the launcher is absent).
function M.start_sidecar()
    return host.start_sidecar()
end

M.PROTOCOL_VERSION = PROTOCOL_VERSION
M.CONTRACT_VERSION = CONTRACT_VERSION

return M
