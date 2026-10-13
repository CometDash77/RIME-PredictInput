-- Fake Weasel/RIME host used to drive the real filter in tests.
--
-- librime-lua calls a filter as `filter.func(input, env)` inside a coroutine;
-- `input:iter()` walks the candidates produced by the previous stage, the
-- filter makes new candidates with the global `Candidate`/`ShadowCandidate`
-- constructors and pushes them out with the global `yield`. Everything the
-- filter reads from the host (context properties, notifiers, page size) is
-- reproduced here so the filter under test is the real shipped file.
--
-- The driver API is deliberately coarse: tests set context/input, optionally
-- fire a notifier, and read back the rendered candidate list as text.

local M = {}

yield = coroutine.yield

local function new_notifier()
    local handlers = {}
    local notifier = {}
    function notifier:connect(handler)
        handlers[#handlers + 1] = handler
        return true
    end
    function notifier:disconnect(handler)
        for index, existing in ipairs(handlers) do
            if existing == handler then
                table.remove(handlers, index)
                return true
            end
        end
        return false
    end
    function notifier:emit(...)
        for _, handler in ipairs(handlers) do handler(...) end
    end
    function notifier:count()
        return #handlers
    end
    return notifier
end

function Candidate(type_name, start_offset, end_offset, text, comment)
    return {
        type = type_name,
        start = start_offset,
        _end = end_offset,
        text = text,
        comment = comment,
    }
end

function ShadowCandidate(candidate, type_name, text, comment, ...)
    return {
        type = type_name,
        start = candidate.start,
        _end = candidate._end,
        text = text,
        comment = comment,
        shadowed = candidate,
    }
end

local function new_segment(text)
    local segment = {
        start = 0,
        _end = #text,
        tags = { abc = "1" },
        status = "kSelected",
        selected = nil,
    }
    function segment:get_selected_candidate()
        return self.selected
    end
    return segment
end

local function new_input(state)
    local input = {}
    function input:iter()
        local index = 0
        return function()
            index = index + 1
            return state.candidates[index]
        end
    end
    return input
end

--- Build a fresh (env, harness) pair. Options:
---   input, preedit, pageSize, namespace
function M.new(options)
    options = options or {}
    local state = {
        input = options.input or "",
        preedit = options.preedit or "",
        candidates = {},
        segment = new_segment(options.input or ""),
        properties = {},
    }
    local context = {}
    context.input = state.input
    context.commit_notifier = new_notifier()
    context.update_notifier = new_notifier()
    context.property_update_notifier = new_notifier()
    function context:set_property(name, value)
        state.properties[name] = value
        self.property_update_notifier:emit(self, name)
    end
    function context:get_property(name)
        return state.properties[name]
    end
    function context:get_preedit()
        return { text = state.preedit }
    end
    local composition = {}
    function composition:empty()
        return state.input == ""
    end
    function composition:back()
        return state.segment
    end
    function composition:toSegmentation()
        local segmentation = {}
        function segmentation:get_at(index)
            if index ~= 0 then return nil end
            return state.segment
        end
        return segmentation
    end
    context.composition = composition

    local page_size = options.pageSize or 5
    local engine = {
        context = context,
        schema = {
            config = {
                get_int = function(_, key)
                    if key == "menu/page_size" then return page_size end
                    return nil
                end,
                get_bool = function(_, key)
                    if key == ((options.namespace or "model_predict") .. "/enabled") then return true end
                    return nil
                end,
            },
        },
    }
    local env = {
        name_space = options.namespace or "model_predict",
        engine = engine,
    }
    local harness = { env = env, state = state, context = context, input = new_input(state) }
    env.harness = harness
    return harness
end

--- Publish the three context properties the fork exposes (S2 #21).
function M.set_context(harness, values)
    local context = harness.context
    if values.status ~= nil then context:set_property("model_predict_context_status", values.status) end
    if values.text ~= nil then context:set_property("model_predict_preceding_text", values.text) end
    if values.revision ~= nil then context:set_property("model_predict_context_revision", values.revision) end
end

--- Set the raw input and the previous stage's candidates.
--- Each candidate: { text = ..., preedit = ..., start = ..., finish = ..., type = ... }
function M.set_input(harness, text, candidates, preedit)
    local state = harness.state
    state.input = text
    state.preedit = preedit or ""
    harness.context.input = text
    state.segment = new_segment(text)
    state.candidates = {}
    for index, spec in ipairs(candidates or {}) do
        state.candidates[index] = {
            type = spec.type or "punct",
            text = spec.text,
            preedit = spec.preedit or "",
            start = spec.start or 0,
            _end = spec.finish or #text,
            comment = "",
        }
    end
end

--- Fire the update notifier the way librime does after an edit.
function M.update(harness)
    harness.context.update_notifier:emit(harness.context)
end

--- Fire the commit notifier with the candidate the user picked. `index` counts
--- the rendered candidate window (what the user actually sees), so index 5 is
--- the reserved prediction slot; nil means nothing was selected.
function M.commit(harness, index)
    local state = harness.state
    local pool = state.rendered or state.candidates
    state.segment.selected = index and pool[index] or nil
    harness.context.commit_notifier:emit(harness.context)
end

function M.render(candidate)
    if candidate == nil then return "<nil>" end
    return table.concat({
        tostring(candidate.type),
        tostring(candidate.start),
        tostring(candidate._end),
        tostring(candidate.text),
        tostring(candidate.comment),
    }, "|")
end

--- Run `filter.func` for the harness' current input and return every candidate
--- it yielded, rendered one per line.
function M.run(harness, filter)
    local produced = {}
    local thread = coroutine.create(function() filter.func(harness.input, harness.env) end)
    while true do
        local ok, value = coroutine.resume(thread)
        if not ok then error(value) end
        if coroutine.status(thread) == "dead" then break end
        produced[#produced + 1] = value
    end
    harness.state.rendered = produced
    local lines = {}
    for index = 1, #produced do lines[index] = M.render(produced[index]) end
    return table.concat(lines, "\n")
end

return M
