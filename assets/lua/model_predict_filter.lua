-- Model-prediction filter for librime (Lua 5.4, librime-lua).
--
-- Runs inside Weasel's RIME session on every keystroke. It never calls a model
-- itself: it sends a request over the file IPC channel, reads the answer back
-- on the next pass, and inserts the predicted candidate into the reserved
-- slot. Everything it cannot prove is left blank, and ordinary input is never
-- held up (spec #18, section 2).
--
-- Division of labour with the companion process (this repository's TS side):
--   * the sidecar owns settings, caches and model identity;
--   * the file IPC channel is authoritative; the completion notification the
--     sidecar sends only makes the front end recompose early;
--   * the filter only ever inserts a candidate that answers the request it
--     actually sent (engine id + seq + request id), for the model it asked
--     for, and only while nothing about the input has changed since.

local json = require("model_predict_json")
local ipc = require("model_predict_ipc")
local host = require("model_predict_host")

local TASK = "中文输入法候选选择"
local MAX_CONTEXT_CHARS = 300
local MAX_PINYIN_CHARS = 256
local MAX_CANDIDATE_CHARS = 512
local MAX_CANDIDATES = 255
local DEFAULT_SLOT = 5
local DEFAULT_PAGE_SIZE = 5
local LAUNCH_INTERVAL_SECONDS = 10
local RESPONSE_MAX_AGE_SECONDS = 60
local MODEL_PATTERN = "^[A-Za-z0-9:._/-]+$"
local IDENTITY_PATTERN = "^[A-Za-z0-9:._/-]+$"

-- Property names shared with WeaselPredictNotify.h (fork side). The completion
-- notification is only accepted while the front-end session publishes exactly
-- these three values, so they must match character for character.
local ENGINE_ID_PROPERTY = "model_predict_engine_id"
local REQUEST_ID_PROPERTY = "model_predict_request_id"
local REQUEST_SEQ_PROPERTY = "model_predict_request_seq"
local RESERVED_PROPERTY = "model_predict_reserved"
local CONTEXT_STATUS_PROPERTY = "model_predict_context_status"
local CONTEXT_TEXT_PROPERTY = "model_predict_preceding_text"
local CONTEXT_REVISION_PROPERTY = "model_predict_context_revision"

local M = {}

local function call(object, method, ...)
    if object == nil then return nil end
    local fn = object[method]
    if type(fn) ~= "function" then return nil end
    local ok, value = pcall(fn, object, ...)
    if not ok then return nil end
    return value
end

local function context_of(env)
    local engine = env and env.engine
    local context = engine and engine.context
    return context
end

local function set_property(env, name, value)
    local context = context_of(env)
    if context == nil then return end
    pcall(context.set_property, context, name, value or "")
end

--- Publish the identity of the request the front end is waiting for. Weasel's
--- completion notification is dropped unless all three match what the sidecar
--- sent, so this is what keeps a stale notification harmless.
local function refresh_identity(env, pending)
    set_property(env, ENGINE_ID_PROPERTY, env.engine_id)
    if pending == nil then
        set_property(env, REQUEST_ID_PROPERTY, "")
        set_property(env, REQUEST_SEQ_PROPERTY, "")
        return
    end
    set_property(env, REQUEST_ID_PROPERTY, pending.request_id)
    set_property(env, REQUEST_SEQ_PROPERTY, tostring(pending.seq))
end

--- Drop the pending/known answers and tell the sidecar to stop working on them.
local function cancel_pending(env)
    refresh_identity(env, nil)
    local pending = env.pending
    env.pending = nil
    env.ready = nil
    if pending == nil then return end
    env.event_seq = (env.event_seq or 0) + 1
    pcall(ipc.publish_event, env.root, env.event_engine_id, env.event_seq, {
        action = "cancel_prediction",
        engine_id = env.engine_id,
        seq = pending.seq,
        request_id = pending.request_id,
    })
end

local function selected_first(context)
    if context == nil then return nil end
    local composition = context.composition
    if composition == nil then return nil end
    if call(composition, "empty") then return nil end
    local segmentation = call(composition, "toSegmentation")
    if segmentation == nil then return nil end
    local segment = call(segmentation, "get_at", 0)
    if segment == nil then return nil end
    if segment.start ~= 0 then return nil end
    local status = segment.status
    if status ~= "kSelected" and status ~= "kConfirmed" then return nil end
    return call(segment, "get_selected_candidate")
end

--- The context text the fork last published, or nil when it is unavailable.
--- "ok" with an empty string is a confirmed empty context: prediction is
--- allowed. A missing or unusable context is not "empty", it is "unknown".
local function editor_context(context)
    if context == nil then return nil, nil end
    local status = call(context, "get_property", CONTEXT_STATUS_PROPERTY)
    if status ~= "ok" then return nil, nil end
    local revision = call(context, "get_property", CONTEXT_REVISION_PROPERTY)
    if type(revision) ~= "string" or revision == "" then return nil, nil end
    local value = call(context, "get_property", CONTEXT_TEXT_PROPERTY)
    if type(value) ~= "string" then return nil, nil end
    if utf8.len(value) and utf8.len(value) > MAX_CONTEXT_CHARS then
        local offset = utf8.offset(value, utf8.len(value) - MAX_CONTEXT_CHARS + 1)
        if offset then value = value:sub(offset) end
    end
    return value, revision
end

local function sync_editor_context(env, context)
    local value, revision = editor_context(context)
    if value == env.context_text and revision == env.context_revision then return end
    env.context_text = value
    env.context_revision = revision
    cancel_pending(env)
    env.shown = nil
end

local function report_selection(env, context, selected)
    sync_editor_context(env, context)
    local shown = env.shown
    if shown ~= nil and context ~= nil and context.input == shown.input then
        env.event_seq = (env.event_seq or 0) + 1
        pcall(ipc.publish_event, env.root, env.event_engine_id, env.event_seq, {
            action = "selection",
            engine_id = env.engine_id,
            prediction_request_id = shown.request_id,
            prediction_seq = shown.seq,
            adopted = shown.has_prediction and selected ~= nil and selected.type == "model_predict" or false,
        })
    end
    cancel_pending(env)
    env.shown = nil
end

local function safe_candidates(candidates)
    if type(candidates) ~= "table" then return false end
    if #candidates < 1 or #candidates > MAX_CANDIDATES then return false end
    for index = 1, #candidates do
        local candidate = candidates[index]
        if type(candidate) ~= "string" or candidate == "" then return false end
        if utf8.len(candidate) and utf8.len(candidate) > MAX_CANDIDATE_CHARS then return false end
    end
    return true
end

--- The choice inside `response`, or nil plus the reason to keep waiting.
local function usable_choice(env, response, candidates, settings)
    local payload = response.payload
    if payload == nil or type(payload) ~= "table" then return nil, false end
    if payload.status == "pending" then return nil, true end
    if payload.status ~= "ok" or payload.eligible ~= true then return nil, false end

    local requested = payload.requested_model
    if type(requested) == "string" and type(settings.local_model) == "string" and requested ~= settings.local_model then
        return nil, false
    end
    local identity = payload.model_identity
    if type(identity) == "string" and identity:match(IDENTITY_PATTERN) then
        env.model_identity = identity
    end

    local choice = payload.choice
    if type(choice) ~= "string" or not choice:match("^%d+$") then return nil, false end
    local index = tonumber(choice)
    if index == nil or index < 1 or index > #candidates or index ~= math.floor(index) then return nil, false end
    return index, false
end

--- Read the answer to `pending`. Returns (choice, keep_waiting).
local function result_choice(env, candidates, settings, pending)
    local response = ipc.read_latest(env.root, env.engine_id)
    if response == nil then return nil, true end

    -- A file the filter already consumed must never come back as a prediction,
    -- even if deleting it failed on this host.
    if env.consumed_seq ~= nil and response.seq <= env.consumed_seq then
        ipc.consume(env.root, env.engine_id, response)
        return nil, true
    end
    if response.seq < pending.seq then
        ipc.consume(env.root, env.engine_id, response)
        return nil, true
    end
    if response.seq ~= pending.seq or response.request_id ~= pending.request_id then
        return nil, true
    end

    local choice, keep_waiting = usable_choice(env, response, candidates, settings)
    if keep_waiting then return nil, true end

    ipc.consume(env.root, env.engine_id, response)
    env.consumed_seq = response.seq
    env.pending = nil
    if choice == nil then return nil, false end
    env.ready = { fingerprint = pending.fingerprint, choice = choice, pending = pending }
    return choice, false
end

--- Ask the launcher for a sidecar process, at most once per
--- LAUNCH_INTERVAL_SECONDS. A missing launcher is silent: the filter simply
--- never gets an answer.
local function launch_if_due(env)
    local now = host.time()
    if now < env.next_launch_at then return end
    env.next_launch_at = now + LAUNCH_INTERVAL_SECONDS
    pcall(ipc.start_sidecar)
end

local function fingerprint_of(env, settings_revision, state, candidates, fields)
    local ok, encoded = pcall(json.encode, {
        candidates = candidates,
        candidate_fields = fields,
        context_revision = env.context_revision,
        settings = settings_revision,
        state = state,
    })
    if not ok then return nil end
    return json.sha256(encoded)
end

local function publish_request(env, state, candidates, fields, settings_revision, fingerprint)
    launch_if_due(env)
    env.seq = env.seq + 1
    local published = ipc.publish(env.root, env.engine_id, env.seq, {
        state = state,
        candidates = candidates,
        candidate_fields = fields,
        settings_revision = settings_revision,
        model_identity = env.model_identity or json.null,
        candidate_fingerprint = fingerprint,
    })
    if published == nil then return nil end
    return {
        seq = published.seq,
        request_id = published.request_id,
        sent_at = published.sent_at,
        fingerprint = fingerprint,
    }
end

local function request_choice(env, settings, settings_revision, state, candidates, fields, fingerprint)
    local ready = env.ready
    if ready ~= nil and ready.fingerprint == fingerprint then
        refresh_identity(env, ready.pending)
        return ready.choice, ready.pending
    end
    env.ready = nil

    local pending = env.pending
    if pending ~= nil then
        -- A pending request that has waited longer than a response may live is
        -- never going to be shown: drop it and ask again below.
        if pending.fingerprint == fingerprint and host.time() - (pending.sent_at or 0) <= RESPONSE_MAX_AGE_SECONDS then
            refresh_identity(env, pending)
            local choice, keep_waiting = result_choice(env, candidates, settings, pending)
            if choice ~= nil or not keep_waiting then return choice, pending end
            return nil, pending
        end
        cancel_pending(env)
    end

    local published = publish_request(env, state, candidates, fields, settings_revision, fingerprint)
    if published == nil then return nil, nil end
    pending = published
    env.pending = pending
    refresh_identity(env, pending)
    return nil, pending
end

function M.init(env)
    local namespace = tostring(env.name_space or ""):gsub("^\\*", "")
    local page_size = DEFAULT_PAGE_SIZE
    local engine = env.engine
    local schema = engine and engine.schema
    local config = schema and schema.config
    local configured = call(config, "get_int", "menu/page_size")
    if type(configured) == "number" and configured >= 1 and configured <= MAX_CANDIDATES then
        page_size = configured
    end
    env.page_size = page_size
    env.root = ipc.root()
    env.engine_id = ipc.engine_id()
    env.event_engine_id = ipc.engine_id()
    env.event_seq = 0
    env.seq = 0
    env.consumed_seq = nil
    env.pending = nil
    env.ready = nil
    env.shown = nil
    env.context_text = nil
    env.context_revision = nil
    env.model_identity = nil
    env.next_launch_at = 0
    env.namespace = namespace

    local context = context_of(env)
    if context ~= nil then
        refresh_identity(env, nil)
        local commit = context.commit_notifier
        if commit ~= nil and type(commit.connect) == "function" then
            env.commit_notifier = commit
            pcall(commit.connect, commit, function(inner)
                local selected = selected_first(inner)
                if selected == nil then
                    pcall(cancel_pending, env)
                    env.shown = nil
                else
                    pcall(report_selection, env, inner, selected)
                end
            end)
        end
        local update = context.update_notifier
        if update ~= nil and type(update.connect) == "function" then
            env.update_notifier = update
            pcall(update.connect, update, function(inner)
                if inner ~= nil and inner.input == "" then
                    pcall(cancel_pending, env)
                    env.shown = nil
                else
                    pcall(sync_editor_context, env, inner)
                end
            end)
        end
        local property = context.property_update_notifier
        if property ~= nil and type(property.connect) == "function" then
            env.property_notifier = property
            pcall(property.connect, property, function(inner, name)
                if name == CONTEXT_STATUS_PROPERTY or name == CONTEXT_TEXT_PROPERTY or name == CONTEXT_REVISION_PROPERTY then
                    pcall(sync_editor_context, env, inner)
                end
            end)
        end
    end
end

function M.tags_match(segment)
    return segment ~= nil
end

function M.func(input, env)
    local context = context_of(env)
    sync_editor_context(env, context)
    refresh_identity(env, env.pending)
    set_property(env, RESERVED_PROPERTY, "")

    local shown = env.shown
    if shown ~= nil and (context == nil or context.input ~= shown.input or selected_first(context) == nil) then
        env.shown = nil
    end

    local read_ok, settings, revision = pcall(ipc.read_settings, env.root)
    if not read_ok or type(settings) ~= "table" or settings.enabled ~= true then
        cancel_pending(env)
        env.shown = nil
        for candidate in input:iter() do yield(candidate) end
        return
    end

    local candidates = {}
    for candidate in input:iter() do candidates[#candidates + 1] = candidate end

    set_property(env, RESERVED_PROPERTY, "1")
    local slot = math.min(settings.slot or DEFAULT_SLOT, env.page_size or DEFAULT_PAGE_SIZE)

    --- Replace the reserved slot with the prediction when there is one, and
    --- keep every ordinary candidate where the user expects it either way.
    local function emit(choice)
        if #candidates == 0 then return end
        local first = candidates[1]
        local function blank()
            yield(Candidate(RESERVED_PROPERTY, first.start, first._end, "", ""))
        end
        for index = 1, math.max(#candidates + 1, slot) do
            if index == slot and choice ~= nil then
                local chosen = candidates[choice]
                yield(ShadowCandidate(chosen, "model_predict", chosen.text, "模型预测", false))
            elseif index < slot then
                if candidates[index] ~= nil then yield(candidates[index]) else blank() end
            elseif index > slot then
                local source = index - 1
                if candidates[source] ~= nil then yield(candidates[source]) else blank() end
            else
                blank()
            end
        end
    end

    local preceding = env.context_text
    if preceding == nil then
        cancel_pending(env)
        env.shown = nil
        emit(nil)
        return
    end

    local segment = call((context or {}).composition, "back")
    local input_text = (context ~= nil and context.input) or ""
    local preedit = call(context, "get_preedit")
    if type(preedit) == "table" then preedit = preedit.text end
    if segment == nil or type(preedit) ~= "string" then
        emit(nil)
        return
    end
    if segment.tags == nil or segment.tags["abc"] == nil then
        emit(nil)
        return
    end
    if segment.start ~= 0 or segment._end ~= #input_text then
        emit(nil)
        return
    end
    if input_text:find("`", 1, true) ~= nil then
        emit(nil)
        return
    end

    local pinyin = input_text
    local first = candidates[1]
    if first ~= nil and type(first.preedit) == "string" and first.preedit ~= "" then
        pinyin = first.preedit .. input_text:sub(first._end + 1)
    end
    if pinyin == "" or #pinyin > MAX_PINYIN_CHARS then
        emit(nil)
        return
    end
    if utf8.len(pinyin) and utf8.len(pinyin) > MAX_PINYIN_CHARS then
        emit(nil)
        return
    end

    local limit = math.min(#candidates, env.page_size or DEFAULT_PAGE_SIZE)
    local texts = {}
    local fields = {}
    for index = 1, limit do
        local candidate = candidates[index]
        texts[index] = candidate.text
        fields[index] = { preedit = candidate.preedit or "", start = candidate.start, ["end"] = candidate._end }
    end
    if not safe_candidates(texts) then
        emit(nil)
        return
    end

    local state = { task = TASK, preceding_text = preceding, pinyin = pinyin }
    local fingerprint = fingerprint_of(env, revision, state, texts, fields)
    local choice = nil
    local pending = nil
    if fingerprint ~= nil then
        local ok, chosen, waiting = pcall(request_choice, env, settings, revision, state, texts, fields, fingerprint)
        if not ok then
            env.pending = nil
            env.ready = nil
            chosen, waiting = nil, nil
        end
        choice, pending = chosen, waiting
    end
    if pending ~= nil then
        env.shown = { seq = pending.seq, request_id = pending.request_id, input = input_text, has_prediction = choice ~= nil }
    end
    emit(choice)
end

function M.fini(env)
    cancel_pending(env)
    env.shown = nil
    local context = context_of(env)
    for _, key in ipairs({ "commit_notifier", "update_notifier", "property_notifier" }) do
        local notifier = env[key]
        local live = nil
        if context ~= nil then
            if key == "commit_notifier" then live = context.commit_notifier
            elseif key == "update_notifier" then live = context.update_notifier
            else live = context.property_update_notifier end
        end
        if notifier ~= nil and live == notifier and type(notifier.disconnect) == "function" then
            pcall(notifier.disconnect, notifier)
        end
    end
end

return M
