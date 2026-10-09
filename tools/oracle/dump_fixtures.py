"""Dump behaviour fixtures from the legacy Python sidecar.

The legacy implementation under reference/runtime-baseline/sidecar is the
specification the TypeScript rewrite must reproduce byte for byte. This script
imports it directly and records the answers for a fixed case table, so the
TypeScript tests can assert against real legacy output instead of against my
reading of the source.

Usage:  python tools/oracle/dump_fixtures.py > tests/fixtures/oracle.json
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "reference" / "runtime-baseline" / "sidecar"
sys.path.insert(0, str(SIDECAR))

from model_predict import contracts, inference, ipc, ollama_policy, settings  # noqa: E402

CONTRACT_VERSION = 1


def with_contract(envelope):
    """Legacy envelope gains the frozen contract field right after version."""
    if isinstance(envelope, dict) and "version" in envelope and "contract_version" not in envelope:
        rebuilt = {}
        for key, value in envelope.items():
            rebuilt[key] = value
            if key == "version":
                rebuilt["contract_version"] = CONTRACT_VERSION
        return rebuilt
    return envelope


def contract_json(text):
    """Inject the frozen contract field into a recorded legacy JSON string."""
    return json.dumps(with_contract(json.loads(text)), ensure_ascii=False, separators=(",", ":"))


def contract_reject_case(name, envelope):
    """Legacy parse ignores contract_version, so capture cannot record the new rejections."""
    raw = json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode()
    return {"name": name, "raw": raw.decode(),
            "result": {"ok": False, "code": "unsupported request envelope"}}


def capture(call):
    try:
        value = call()
    except ValueError as error:
        return {"ok": False, "code": str(error)}
    except Exception as error:  # pragma: no cover - oracle must surface surprises
        return {"ok": False, "code": f"{type(error).__name__}: {error}"}
    return {"ok": True, "code": None, "value": value}


def decision_case(name: str, payload):
    result = capture(lambda: contracts.DecisionInput.from_payload(payload))
    if result["ok"]:
        result["value"] = "DecisionInput"
    entry = {"name": name, "payload": payload, "result": result}
    if result["ok"]:
        decision = contracts.DecisionInput.from_payload(payload)
        entry["state_digest"] = decision.state_digest
        entry["candidates_digest"] = decision.candidates_digest
    return entry


def settings_case(name: str, mapping):
    result = capture(lambda: settings.Settings.from_mapping(mapping).to_mapping())
    return {"name": name, "mapping": mapping, "result": result}


def request_case(name: str, envelope):
    raw = json.dumps(with_contract(envelope), ensure_ascii=False, separators=(",", ":")).encode()
    result = capture(lambda: ipc.Request.parse(raw).to_mapping())
    if result["ok"]:
        result["value"] = with_contract(result["value"])
    return {"name": name, "raw": raw.decode(), "result": result}

INFERENCE_ENGINE = "a" * 40
INFERENCE_REQUEST_ID = "1" * 32
PULL_MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9:._/-]{0,79}")


class FakeLocal:
    """Duck-typed stand-in for providers.LocalBackend: no sockets, no subprocesses."""

    def __init__(self, scenario: dict) -> None:
        self.scenario = scenario
        self.infers: list = []
        self.pull_model = None
        self.closed = False

    def resolve_model(self, model):
        return self.scenario.get("resolve", (None, "model_missing"))

    def is_router(self, model):
        return bool(self.scenario.get("router", False))

    def infer(self, decision, active_settings, model_identity=None):
        self.infers.append(model_identity)
        answer = self.scenario.get("infer")
        if answer is None:
            answer = {"status": "unavailable", "backend": "local", "error_code": "invalid_model_response"}
        return json.loads(json.dumps(answer))

    def test_connection(self):
        answer = self.scenario.get("connection", {"status": "unavailable", "error_code": "ollama_missing"})
        return json.loads(json.dumps(answer))

    def model_inventory(self, start_server=False):
        answer = self.scenario.get(
            "inventory", {"status": "unavailable", "error_code": "model_store_unavailable", "models": []}
        )
        return json.loads(json.dumps(answer))

    def start_model_pull(self, model):
        if not isinstance(model, str) or not PULL_MODEL_PATTERN.fullmatch(model.strip()):
            return {"status": "unavailable", "error_code": "invalid_model_name"}
        self.pull_model = model.strip()
        return {"status": "pulling", "model": self.pull_model}

    def model_pull_status(self):
        return dict(self.scenario.get("pull_status", {"status": "idle"}))

    def cancel_model_pull(self):
        return {"status": "cancelled", "model": self.pull_model}

    def close(self):
        self.closed = True


def inference_cases(valid_payload):
    """Drive the real InferenceService against a fake local backend."""
    enabled = settings.Settings.from_mapping({"enabled": True, "local_model": ollama_policy.DEFAULT_MODEL})
    disabled = settings.Settings.from_mapping({"enabled": False, "local_model": ollama_policy.DEFAULT_MODEL})
    cloud = settings.Settings(backend="cloud")
    quick = settings.Settings.from_mapping({"enabled": True, "local_wait_ms": 1})

    def make_request(payload=None, seq=1, request_id=INFERENCE_REQUEST_ID, engine=INFERENCE_ENGINE, kind="predict"):
        envelope = {
            "version": ipc.PROTOCOL_VERSION,
            "contract_version": ipc.PROTOCOL_VERSION,
            "engine_id": engine,
            "seq": seq,
            "request_id": request_id,
            "kind": kind,
            "sent_at": 1000.0,
            "payload": valid_payload if payload is None else payload,
        }
        return ipc.Request.parse(json.dumps(envelope, ensure_ascii=False, separators=(",", ":")).encode())

    def trimmed(value):
        """Replace every duration_ms with a has_duration_ms marker, at any depth."""
        if isinstance(value, dict):
            kept = {key: trimmed(item) for key, item in value.items() if key != "duration_ms"}
            if "duration_ms" in value:
                kept["has_duration_ms"] = True
            return kept
        if isinstance(value, list):
            return [trimmed(item) for item in value]
        return value

    def run(scenario, active_settings, request):
        service = inference.InferenceService(local=FakeLocal(scenario))
        try:
            return trimmed(service(request, active_settings))
        finally:
            service.close()

    def answer(choice=2, identity=None):
        return {
            "status": "ok",
            "backend": "local",
            "provider": "ollama",
            "model": ollama_policy.DEFAULT_MODEL,
            "choice": str(choice),
            "requested_model": ollama_policy.DEFAULT_MODEL,
            "model_identity": identity or ollama_policy.VALIDATED_IDENTITY,
        }

    installed = {
        "status": "available",
        "models": [{"name": ollama_policy.DEFAULT_MODEL, "digest": ollama_policy.MODEL_DIGEST, "format": "unknown"}],
    }
    connected = {"status": "connected", "provider": "local", "version": "0.12.0"}
    unavailable_store = {"status": "unavailable", "error_code": "model_store_unavailable", "models": []}
    good = {"resolve": (ollama_policy.VALIDATED_IDENTITY, None), "infer": answer(), "inventory": installed}

    cases = {}
    cases["health_unavailable"] = run(
        {"connection": {"status": "unavailable", "error_code": "ollama_missing"}, "inventory": unavailable_store},
        enabled,
        make_request(kind="health"),
    )
    cases["health_accepted"] = run({"connection": connected, "inventory": installed}, enabled, make_request(kind="health"))

    cases["model_status_accepted"] = run(good, enabled, make_request(kind="settings", payload={"action": "model_status"}))
    cases["model_status_explicit"] = run(
        good, enabled, make_request(kind="settings", payload={"action": "model_status", "model": "some/model:tag"})
    )
    cases["model_status_failed_screening"] = run(
        {"inventory": {"status": "available", "models": [
            {"name": ollama_policy.DEFAULT_MODEL, "digest": next(iter(ollama_policy.FAILED_SCREENINGS)), "format": "gguf"}]}},
        enabled,
        make_request(kind="settings", payload={"action": "model_status"}),
    )
    cases["model_status_unknown_digest"] = run(
        {"inventory": {"status": "available", "models": [
            {"name": ollama_policy.DEFAULT_MODEL, "digest": "unknown", "format": "unknown"}]}},
        enabled,
        make_request(kind="settings", payload={"action": "model_status"}),
    )
    cases["model_status_unverified"] = run(
        {"inventory": {"status": "available", "models": [
            {"name": ollama_policy.DEFAULT_MODEL, "digest": "d" * 64, "format": "gguf"}]}},
        enabled,
        make_request(kind="settings", payload={"action": "model_status"}),
    )
    cases["model_status_not_installed"] = run(
        {"inventory": {"status": "available", "models": [
            {"name": "other/model:tag", "digest": "d" * 64, "format": "gguf"}]}},
        enabled,
        make_request(kind="settings", payload={"action": "model_status"}),
    )
    cases["model_status_invalid_name"] = run(
        good, enabled, make_request(kind="settings", payload={"action": "model_status", "model": "bad name!"})
    )
    cases["model_status_store_unavailable"] = run(
        {"inventory": unavailable_store}, enabled, make_request(kind="settings", payload={"action": "model_status"})
    )

    cases["predict_disabled"] = run(good, disabled, make_request())
    cases["predict_local_only"] = run(good, cloud, make_request())
    cases["predict_resolve_error"] = run(
        {"resolve": (None, "ollama_missing"), "infer": answer()}, enabled, make_request()
    )
    cases["predict_identity_not_validated"] = run(
        {"resolve": ("ollama:" + "e" * 64, None), "infer": answer()}, enabled, make_request()
    )
    cases["predict_infer_unavailable"] = run(
        {"resolve": (ollama_policy.VALIDATED_IDENTITY, None),
         "infer": {"status": "unavailable", "error_code": "provider_unavailable"}},
        enabled,
        make_request(),
    )
    cases["predict_ok"] = run(good, enabled, make_request())
    cases["predict_bad_payload"] = run(
        good, enabled, make_request(payload={"state": valid_payload["state"]})
    )

    service = inference.InferenceService(local=FakeLocal(dict(good)))
    try:
        first = trimmed(service(make_request(seq=1), enabled))
        second = trimmed(service(make_request(seq=2, request_id="2" * 32), enabled))
        cases["predict_cache_miss"] = first
        cases["predict_cache_hit"] = second
        cases["predict_cache_entries"] = len(service.cache)
        cases["status_after_predict"] = trimmed(service.status_since(0))
        cases["status_current"] = trimmed(service.status_since(service.status_revision))
        cases["action_selection_accepted"] = service.settings_action(
            {"action": "selection", "prediction_request_id": "2" * 32, "prediction_seq": 2, "adopted": True},
            enabled,
        )
        cases["status_after_selection"] = trimmed(service.status_since(0))
        cases["action_selection_stale"] = service.settings_action(
            {"action": "selection", "prediction_request_id": INFERENCE_REQUEST_ID, "prediction_seq": 1, "adopted": True},
            enabled,
        )
        cases["action_selection_unknown"] = service.settings_action(
            {"action": "selection", "prediction_request_id": "3" * 32, "prediction_seq": 1, "adopted": True},
            enabled,
        )
        cases["action_selection_invalid"] = service.settings_action(
            {"action": "selection", "prediction_request_id": "xyz", "prediction_seq": 1, "adopted": True},
            enabled,
        )
        cases["action_cancel_prediction"] = service.settings_action(
            {"action": "cancel_prediction", "engine_id": INFERENCE_ENGINE, "seq": 1}, enabled
        )
        cases["action_cancel_prediction_unknown"] = service.settings_action(
            {"action": "cancel_prediction", "engine_id": "b" * 40, "seq": 1}, enabled
        )
        cases["action_cancel_prediction_invalid"] = service.settings_action(
            {"action": "cancel_prediction", "engine_id": "bad!", "seq": 0}, enabled
        )
        cases["action_clear_cache"] = service.settings_action({"action": "clear_cache"}, enabled)
        cases["action_models"] = trimmed(service.settings_action({"action": "models"}, enabled))
        cases["action_pull_model"] = service.settings_action({"action": "pull_model", "model": "some/model:tag"}, enabled)
        cases["action_pull_model_missing"] = service.settings_action({"action": "pull_model"}, enabled)
        cases["action_pull_status"] = service.settings_action({"action": "pull_status"}, enabled)
        cases["action_cancel_pull"] = service.settings_action({"action": "cancel_pull"}, enabled)
        cases["action_test_connection"] = service.settings_action({"action": "test_connection"}, enabled)
        cases["action_status"] = trimmed(service.settings_action({"action": "status"}, enabled))
        cases["action_unknown"] = service.settings_action({"action": "nope"}, enabled)
        cases["action_not_object"] = service.settings_action({"action": None}, enabled)
    finally:
        service.close()

    router = inference.InferenceService(local=FakeLocal(dict(good, router=True)))
    try:
        router(make_request(seq=1), enabled)
        cases["predict_router_cache_miss"] = trimmed(router(make_request(seq=2, request_id="2" * 32), enabled))
        cases["predict_router_cache_entries"] = len(router.cache)
    finally:
        router.close()

    queued = inference.InferenceService(local=FakeLocal(dict(good)))
    try:
        cases["submit_pending"] = trimmed(
            queued.submit(make_request(seq=5, engine="9" * 40), quick).initial
        )
        deferred = queued.submit(make_request(seq=6, engine="8" * 40), quick)
        cases["submit_completion"] = trimmed(deferred.future.result(timeout=10))
        cases["submit_disabled"] = trimmed(queued.submit(make_request(seq=7, engine="7" * 40), disabled))
        cases["submit_bad_payload"] = trimmed(
            queued.submit(make_request(seq=8, engine="6" * 40, payload={"state": valid_payload["state"]}), quick)
        )
        busy = dict(good)
        busy["local_wait_ms"] = 200
        slow = settings.Settings.from_mapping({"enabled": True, "local_wait_ms": 200})
        for index in range(16):
            queued.submit(make_request(seq=9, engine=f"e{index}"), slow)
        cases["submit_busy"] = trimmed(queued.submit(make_request(seq=9, engine="f" * 40), slow))
    finally:
        queued.close()

    return cases


def runtime_cases(valid_payload):
    """Drive the real SidecarRuntime and record what it writes and answers."""
    from concurrent.futures import Future

    from model_predict import runtime as runtime_module

    engine_id = "a" * 40

    def read_state(paths):
        value = json.loads(paths.status.read_text(encoding="utf-8"))
        value["updated_at"] = "float"
        return value

    def read_log(paths):
        if not paths.log.exists():
            return []
        rows = []
        for line in paths.log.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            row["ts"] = "iso"
            if "duration_ms" in row:
                row["duration_ms"] = "number"
            rows.append(row)
        return rows

    def read_response(engine, name):
        body = engine.ipc.read_latest_response(name)
        if body is None:
            return None
        return {"seq": body["seq"], "request_id": body["request_id"], "payload": body["payload"]}

    def scenario(
        name,
        dispatch,
        *,
        settings_mapping=None,
        raw_settings=None,
        rewrite_before=None,
        rewrite_after=None,
        kind="predict",
        payload=None,
        resolve=None,
        idle_seconds=60.0,
    ):
        entry = {
            "name": name,
            "input": {
                "settings_mapping": settings_mapping,
                "raw_settings": raw_settings,
                "rewrite_before": rewrite_before,
                "rewrite_after": rewrite_after,
                "kind": kind,
                "payload": payload,
                "resolve": resolve,
                "idle_seconds": idle_seconds,
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            paths = settings.AppPaths(root)
            if settings_mapping is not None:
                settings.SettingsStore(paths.settings).save(settings.Settings.from_mapping(settings_mapping))
            calls = []
            notices = []
            pending = []

            def wrapped(request, current):
                calls.append({"kind": request.kind, "seq": request.seq, "settings": current.to_mapping()})
                outcome = dispatch(request, current)
                if isinstance(outcome, runtime_module.DeferredResponse):
                    pending.append(outcome.future)
                return outcome

            clock = {"value": 100.0}

            def monotonic():
                return clock["value"]

            def sleep(seconds):
                clock["value"] += max(float(seconds), 0.1)

            def notify(request):
                notices.append({
                    "engine_id": request.engine_id,
                    "request_id": request.request_id,
                    "seq": request.seq,
                })
                return True

            engine = runtime_module.SidecarRuntime(
                paths,
                dispatch=wrapped,
                poll_interval=0.01,
                idle_seconds=idle_seconds,
                clock=monotonic,
                sleep=sleep,
                completion_notify=notify,
            )
            entry["state_after_start"] = read_state(paths)
            if raw_settings is not None:
                paths.settings.write_text(raw_settings, encoding="utf-8")
            if rewrite_before is not None:
                settings.SettingsStore(paths.settings).save(settings.Settings.from_mapping(rewrite_before))
            request = engine.ipc.publish_request(engine_id, 1, kind, payload if payload is not None else {}, now=1000.25)
            entry["handled"] = engine.pump_once()
            entry["calls"] = calls
            entry["request_id"] = request.request_id
            entry["response_after_pump"] = read_response(engine, engine_id)
            entry["state_after_pump"] = read_state(paths)
            entry["log_after_pump"] = read_log(paths)
            if rewrite_after is not None:
                settings.SettingsStore(paths.settings).save(settings.Settings.from_mapping(rewrite_after))
            for future in pending:
                if resolve is not None:
                    future.set_result(resolve(request) if callable(resolve) else resolve)
            entry["response_after_resolve"] = read_response(engine, engine_id)
            entry["notices"] = notices
            entry["state_after_resolve"] = read_state(paths)
            entry["log_after_resolve"] = read_log(paths)
            entry["deferred_pending"] = engine._deferred_pending
        return entry

    def deferred(initial, current):
        return runtime_module.DeferredResponse(initial, Future(), current)

    entries = [
        scenario(
            "immediate_ok",
            lambda request, current: {"status": "ok", "eligible": True},
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "immediate_missing_status",
            lambda request, current: {"note": "no status"},
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "immediate_invalid_error_code",
            lambda request, current: {"status": "unavailable", "error_code": 1.5},
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "immediate_bool_error_code",
            lambda request, current: {"status": "unavailable", "error_code": True},
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "immediate_non_dict",
            lambda request, current: "not-a-dict",
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "handler_failed",
            lambda request, current: (_ for _ in ()).throw(RuntimeError("backend exploded")),
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "deferred_ok",
            lambda request, current: deferred({"status": "pending"}, current),
            settings_mapping={"enabled": True},
            payload=valid_payload,
            resolve={"status": "ok", "eligible": True},
        ),
        scenario(
            "deferred_ineligible",
            lambda request, current: deferred({"status": "pending"}, current),
            settings_mapping={"enabled": True},
            payload=valid_payload,
            resolve={"status": "ok", "eligible": False},
        ),
        scenario(
            "deferred_settings_changed",
            lambda request, current: deferred({"status": "pending"}, current),
            settings_mapping={"enabled": True},
            payload=valid_payload,
            resolve={"status": "ok", "eligible": True},
            rewrite_after={"enabled": True, "slot": 8},
        ),
        scenario(
            "deferred_unresolved",
            lambda request, current: deferred({"status": "pending"}, current),
            settings_mapping={"enabled": True},
            payload=valid_payload,
        ),
        scenario(
            "predict_reloads_settings",
            lambda request, current: {"status": "ok"},
            settings_mapping={"enabled": True, "slot": 5},
            rewrite_before={"enabled": True, "slot": 7},
            payload=valid_payload,
        ),
        scenario(
            "settings_kind_keeps_cached",
            lambda request, current: {"status": "ok"},
            settings_mapping={"enabled": True, "slot": 5},
            rewrite_before={"enabled": True, "slot": 7},
            kind="settings",
            payload={"action": "status"},
        ),
        scenario(
            "broken_settings_disables",
            lambda request, current: {"status": "ok"},
            raw_settings="{not json",
            payload=valid_payload,
        ),
    ]

    class _Owner:
        def __init__(self):
            self.calls = 0
            self.closed = False

        def dispatch(self, request, current):
            self.calls += 1
            return {"status": "ok"}

        def close(self):
            self.closed = True

    loops = []
    for name, publish in (("run_exit_when_idle", False), ("run_handles_then_exits", True)):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            paths = settings.AppPaths(root)
            settings.SettingsStore(paths.settings).save(settings.Settings.from_mapping({"enabled": True}))
            owner = _Owner()
            clock = {"value": 100.0}

            def sleep(seconds, _clock=clock):
                _clock["value"] += max(float(seconds), 0.1)

            engine = runtime_module.SidecarRuntime(
                paths,
                dispatch=owner.dispatch,
                poll_interval=0.01,
                idle_seconds=0.2,
                clock=lambda: clock["value"],
                sleep=sleep,
                completion_notify=lambda request: True,
            )
            if publish:
                engine.ipc.publish_request(engine_id, 1, "health", {}, now=1000.25)
            engine.run()
            loops.append({
                "name": name,
                "input": {"publish": publish, "kind": "health", "payload": {}, "idle_seconds": 0.2},
                "dispatch_calls": owner.calls,
                "closed": owner.closed,
                "state": read_state(paths),
                "response": read_response(engine, engine_id),
            })

    construction = []
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        paths = settings.AppPaths(root)
        paths.settings.parent.mkdir(parents=True, exist_ok=True)
        paths.settings.write_text("{not json", encoding="utf-8")
        try:
            runtime_module.SidecarRuntime(paths)
            construction.append({"name": "broken_settings_at_construction", "raised": None})
        except Exception as error:  # noqa: BLE001 - the oracle records what legacy does
            construction.append({
                "name": "broken_settings_at_construction",
                "raised": f"{type(error).__name__}",
            })

    return {"scenarios": entries, "loops": loops, "construction": construction}


def main() -> int:
    base_state = {"task": "中文输入法候选选择", "preceding_text": "我们今天去看", "pinyin": "dianying"}
    base_candidates = ["电影", "电源", "电涌", "电阻", "电工"]
    base_fields = [
        {"preedit": "dianying", "start": 4, "end": 12},
        {"preedit": "dianyin", "start": 4, "end": 11},
        {"preedit": "dianyong", "start": 4, "end": 12},
        {"preedit": "dianzu", "start": 4, "end": 10},
        {"preedit": "diangong", "start": 4, "end": 11},
    ]

    valid_payload = {"state": base_state, "candidates": base_candidates, "candidate_fields": base_fields}

    decision_payloads = [
        decision_case("valid_with_fields", valid_payload),
        decision_case("valid_without_fields", {"state": base_state, "candidates": base_candidates}),
        decision_case(
            "candidate_fields_null_is_absent",
            {"state": base_state, "candidates": base_candidates, "candidate_fields": None},
        ),
        decision_case("payload_is_list", []),
        decision_case("state_has_extra_key", {"state": {**base_state, "extra": 1}, "candidates": base_candidates}),
        decision_case("state_missing_pinyin", {"state": {"task": "t", "preceding_text": "x"}, "candidates": ["a"]}),
        decision_case("state_task_empty", {"state": {**base_state, "task": ""}, "candidates": base_candidates}),
        decision_case(
            "state_task_too_long", {"state": {**base_state, "task": "长" * 257}, "candidates": base_candidates}
        ),
        decision_case(
            "state_preceding_too_long",
            {"state": {**base_state, "preceding_text": "上" * 301}, "candidates": base_candidates},
        ),
        decision_case(
            "state_preceding_at_limit",
            {"state": {**base_state, "preceding_text": "上" * 300}, "candidates": base_candidates},
        ),
        decision_case("candidates_empty", {"state": base_state, "candidates": []}),
        decision_case("candidate_empty_text", {"state": base_state, "candidates": ["电影", ""]}),
        decision_case("candidate_too_long", {"state": base_state, "candidates": ["长" * 513]}),
        decision_case("candidate_at_limit", {"state": base_state, "candidates": ["长" * 512]}),
        decision_case("candidates_not_strings", {"state": base_state, "candidates": [1]}),
        decision_case(
            "fields_length_mismatch",
            {"state": base_state, "candidates": base_candidates, "candidate_fields": base_fields[:2]},
        ),
        decision_case(
            "fields_extra_key",
            {
                "state": base_state,
                "candidates": base_candidates,
                "candidate_fields": [{**base_fields[0], "extra": 1}] * len(base_candidates),
            },
        ),
        decision_case(
            "fields_start_not_less_than_end",
            {
                "state": base_state,
                "candidates": base_candidates,
                "candidate_fields": [{**base_fields[0], "start": 9, "end": 9}] * len(base_candidates),
            },
        ),
        decision_case(
            "fields_end_over_limit",
            {
                "state": base_state,
                "candidates": base_candidates,
                "candidate_fields": [{**base_fields[0], "end": 257}] * len(base_candidates),
            },
        ),
        decision_case(
            "fields_start_is_bool",
            {
                "state": base_state,
                "candidates": base_candidates,
                "candidate_fields": [{**base_fields[0], "start": True}] * len(base_candidates),
            },
        ),
        decision_case(
            "fields_emoji_preedit",
            {
                "state": base_state,
                "candidates": base_candidates,
                "candidate_fields": [{**base_fields[0], "preedit": "🙂dianying"}] * len(base_candidates),
            },
        ),
    ]

    settings_mappings = [
        ("empty", {}),
        ("enabled_only", {"enabled": True}),
        ("full", {"enabled": True, "backend": "local", "provider": None, "local_model": "m:1", "slot": 3,
                  "local_wait_ms": 120, "thresholds": {"a:b": 0.5}, "log_mode": "off"}),
        ("slot_zero", {"slot": 0}),
        ("slot_negative", {"slot": -1}),
        ("slot_too_large", {"slot": 2 ** 31}),
        ("slot_bool", {"slot": True}),
        ("wait_zero", {"local_wait_ms": 0}),
        ("wait_too_large", {"local_wait_ms": 201}),
        ("wait_bool", {"local_wait_ms": True}),
        ("enabled_string", {"enabled": "true"}),
        ("backend_cloud", {"backend": "cloud"}),
        ("provider_set", {"provider": "openai"}),
        ("unknown_field", {"extra": 1}),
        ("secret_top_level", {"api_key": "x"}),
        ("secret_nested", {"thresholds": {"a:Token": 0.5, "b": {"token": "x"}}}),
        ("log_mode_invalid", {"log_mode": "full"}),
        ("thresholds_too_many", {"thresholds": {"k" + str(i): 0.5 for i in range(17)}}),
        ("threshold_identity_bad", {"thresholds": {"bad identity!": 0.5}}),
        ("threshold_value_bad", {"thresholds": {"a:b": 1.5}}),
        ("threshold_value_string", {"thresholds": {"a:b": "0.5"}}),
        ("local_model_padded", {"local_model": "  m:1  "}),
        ("local_model_empty", {"local_model": ""}),
        ("local_model_too_long", {"local_model": "a" * 81}),
        ("local_model_bad_char", {"local_model": "m odel"}),
        ("not_an_object", []),
    ]

    engine = "a" * 40
    request_id = "f" * 32
    base_request = {
        "version": 1,
        "contract_version": 1,
        "engine_id": engine,
        "seq": 1,
        "request_id": request_id,
        "kind": "predict",
        "sent_at": 1000.5,
        "payload": valid_payload,
    }
    request_cases = [
        ("valid_predict", base_request),
        ("valid_health", {**base_request, "kind": "health", "payload": {}}),
        ("version_unsupported", {**base_request, "version": 2}),
        ("engine_id_too_long", {**base_request, "engine_id": "a" * 49}),
        ("engine_id_bad_char", {**base_request, "engine_id": "a.b"}),
        ("seq_zero", {**base_request, "seq": 0}),
        ("seq_bool", {**base_request, "seq": True}),
        ("seq_string", {**base_request, "seq": "1"}),
        ("request_id_uppercase", {**base_request, "request_id": "F" * 32}),
        ("request_id_short", {**base_request, "request_id": "f" * 31}),
        ("kind_unknown", {**base_request, "kind": "shutdown"}),
        ("sent_at_zero", {**base_request, "sent_at": 0}),
        ("sent_at_bool", {**base_request, "sent_at": True}),
        ("sent_at_string", {**base_request, "sent_at": "1000"}),
        ("payload_is_list", {**base_request, "payload": []}),
        ("payload_has_secret", {**base_request, "payload": {"token": "x"}}),
        ("missing_kind", {k: v for k, v in base_request.items() if k != "kind"}),
        ("extra_key", {**base_request, "extra": 1}),
    ]
    contract_reject_cases = [
        contract_reject_case("contract_version_unknown", {**base_request, "contract_version": 2}),
        contract_reject_case(
            "contract_version_missing",
            {k: v for k, v in base_request.items() if k != "contract_version"},
        ),
        contract_reject_case("contract_version_string", {**base_request, "contract_version": "1"}),
        contract_reject_case("contract_version_bool", {**base_request, "contract_version": True}),
    ]

    responses = {}
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        store = settings.SettingsStore(root / "settings.json")
        store.save(settings.Settings.from_mapping({"enabled": True, "slot": 3}))
        responses["settings_file_bytes"] = (root / "settings.json").read_text(encoding="utf-8")
        second = root / "second.json"
        store2 = settings.SettingsStore(second)
        store2.save(settings.Settings.from_mapping({}), overwrite=False)
        responses["settings_file_no_overwrite_bytes"] = second.read_text(encoding="utf-8")

        file_ipc = ipc.FileIpc(root / "ipc" / "requests", root / "ipc" / "responses")
        request = file_ipc.publish_request(engine, 1, "predict", valid_payload, now=1000.0)
        request_dir = root / "ipc" / "requests"
        responses["request_files"] = {
            str(p.relative_to(root)): p.read_text(encoding="utf-8")
            for p in sorted(request_dir.rglob("*"))
            if p.is_file()
        }
        responses["request_tree"] = sorted(
            str(p.relative_to(root)) for p in request_dir.rglob("*")
        )
        responses["request_to_mapping"] = request.to_mapping()

        responses["publish_ok"] = file_ipc.publish_response(request, {"status": "ok", "backend": "local"}, now=1001.25)
        response_dir = root / "ipc" / "responses"
        responses["response_files"] = {
            str(p.relative_to(root)): p.read_text(encoding="utf-8")
            for p in sorted(response_dir.rglob("*"))
            if p.is_file()
        }
        responses["response_tree"] = sorted(str(p.relative_to(root)) for p in response_dir.rglob("*"))
        responses["read_latest"] = file_ipc.read_latest_response(engine)
        responses["consume_ok"] = file_ipc.consume_response(engine, request.to_mapping()["request_id"])
        responses["consume_wrong_id_refused"] = file_ipc.consume_response(engine, "f" * 32)
        responses["response_tree_after_consume"] = sorted(
            str(p.relative_to(root)) for p in response_dir.rglob("*")
        )

        stale = file_ipc.publish_request(engine, 2, "predict", valid_payload, now=1002.0)
        newer = file_ipc.publish_request(engine, 3, "predict", valid_payload, now=1003.0)
        responses["publish_stale_refused"] = file_ipc.publish_response(stale, {"status": "ok"}, now=1004.0)
        responses["publish_newest_ok"] = file_ipc.publish_response(newer, {"status": "ok"}, now=1005.0)

        # A slot only refuses an older or foreign response while a newer one is present.
        other = "b" * 40
        first = file_ipc.publish_request(other, 2, "predict", valid_payload, now=1002.0)
        responses["publish_first_ok"] = file_ipc.publish_response(first, {"status": "ok"}, now=1002.5)
        older = file_ipc.publish_request(other, 1, "predict", valid_payload, now=1001.0)
        responses["publish_older_refused"] = file_ipc.publish_response(older, {"status": "ok"}, now=1003.0)
        twin = file_ipc.publish_request(other, 2, "predict", valid_payload, now=1002.25)
        responses["publish_same_seq_other_id_refused"] = file_ipc.publish_response(twin, {"status": "ok"}, now=1003.5)
        responses["latest_seq_after_refusals"] = (file_ipc.read_latest_response(other) or {}).get("seq")

        # Fractional timestamps produce identical bytes on both sides; integral ones
        # cannot, because JS has no way to spell 1000.0.
        exact_engine = "c" * 40
        exact = ipc.FileIpc(root / "exact" / "requests", root / "exact" / "responses")
        exact_request = exact.publish_request(exact_engine, 7, "predict", valid_payload, now=1000.25)
        exact_stem = exact_request.to_mapping()
        exact_name = f"req-{exact_engine}-{exact_stem['seq']:020d}-{exact_stem['request_id']}.json"
        responses["request_bytes_fractional"] = (root / "exact" / "requests" / exact_name).read_text(encoding="utf-8")
        responses["publish_response_fractional_ok"] = exact.publish_response(
            exact_request, {"status": "ok", "backend": "local"}, now=1001.25
        )
        exact_slot = "a" if exact_stem["seq"] % 2 else "b"
        responses["response_bytes_fractional"] = (
            root / "exact" / "responses" / exact_engine / f"response-{exact_slot}.json"
        ).read_text(encoding="utf-8")
        responses["ready_bytes_fractional"] = (
            root / "exact" / "responses" / exact_engine / f"response-{exact_slot}.ready"
        ).read_text(encoding="utf-8")
        responses["read_latest_fractional"] = exact.read_latest_response(exact_engine)

    # The frozen contract field only exists in the new implementation; the legacy
    # sidecar cannot emit it. Inject it into every recorded envelope and recompute
    # ready markers so byte-level comparisons keep matching the new writer.
    responses["request_files"] = {
        path: contract_json(text) if path.endswith(".json") else text
        for path, text in responses["request_files"].items()
    }
    responses["request_to_mapping"] = with_contract(responses["request_to_mapping"])
    rewritten = {}
    for path, text in responses["response_files"].items():
        if path.endswith(".json"):
            rewritten[path] = contract_json(text)
    for path, text in responses["response_files"].items():
        if path.endswith(".ready"):
            body = rewritten[path[: -len(".ready")] + ".json"].encode("utf-8")
            marker = json.loads(text)
            marker["bytes"] = len(body)
            marker["sha256"] = hashlib.sha256(body).hexdigest()
            rewritten[path] = json.dumps(marker, ensure_ascii=False, separators=(",", ":"))
    responses["response_files"] = rewritten
    responses["read_latest"] = with_contract(responses["read_latest"])
    responses["request_bytes_fractional"] = contract_json(responses["request_bytes_fractional"])
    responses["response_bytes_fractional"] = contract_json(responses["response_bytes_fractional"])
    fractional_body = responses["response_bytes_fractional"].encode("utf-8")
    fractional_marker = json.loads(responses["ready_bytes_fractional"])
    fractional_marker["bytes"] = len(fractional_body)
    fractional_marker["sha256"] = hashlib.sha256(fractional_body).hexdigest()
    responses["ready_bytes_fractional"] = json.dumps(fractional_marker, ensure_ascii=False, separators=(",", ":"))
    responses["read_latest_fractional"] = with_contract(responses["read_latest_fractional"])

    chat_requests = []
    chat_requests.append({
        "name": "default_model",
        "model": ollama_policy.DEFAULT_MODEL,
        "result": capture(lambda: ollama_policy.chat_request(
            contracts.DecisionInput.from_payload(valid_payload), ollama_policy.DEFAULT_MODEL)),
    })
    chat_requests.append({
        "name": "custom_model",
        "model": "some/model:tag",
        "result": capture(lambda: ollama_policy.chat_request(
            contracts.DecisionInput.from_payload(valid_payload), "some/model:tag")),
    })
    chat_requests.append({
        "name": "single_candidate",
        "model": ollama_policy.DEFAULT_MODEL,
        "result": capture(lambda: ollama_policy.chat_request(
            contracts.DecisionInput.from_payload({
                "state": valid_payload["state"],
                "candidates": valid_payload["candidates"][:1],
                "candidate_fields": valid_payload["candidate_fields"][:1],
            }),
            ollama_policy.DEFAULT_MODEL)),
    })
    chat_requests.append({
        "name": "candidate_fields_missing",
        "model": ollama_policy.DEFAULT_MODEL,
        "result": capture(lambda: ollama_policy.chat_request(
            contracts.DecisionInput.from_payload({
                "state": valid_payload["state"],
                "candidates": valid_payload["candidates"],
            }),
            ollama_policy.DEFAULT_MODEL)),
    })

    document = {
        "generated_by": "tools/oracle/dump_fixtures.py",
        "source": "reference/runtime-baseline/sidecar/model_predict",
        "policy": {
            "default_model": ollama_policy.DEFAULT_MODEL,
            "model_digest": ollama_policy.MODEL_DIGEST,
            "system_prompt": ollama_policy.SYSTEM_PROMPT,
            "options": ollama_policy.OPTIONS,
            "policy_spec": ollama_policy.POLICY_SPEC,
            "policy_digest": ollama_policy.POLICY_DIGEST,
            "validated_policy_digest": ollama_policy.VALIDATED_POLICY_DIGEST,
            "validated_identity": ollama_policy.VALIDATED_IDENTITY,
            "validation": ollama_policy.VALIDATION,
            "failed_screenings": ollama_policy.FAILED_SCREENINGS,
            "identity_for_model_digest": ollama_policy.identity_for(ollama_policy.MODEL_DIGEST),
            "is_validated_default": ollama_policy.is_validated(ollama_policy.VALIDATED_IDENTITY),
        },
        "decision_payloads": decision_payloads,
        "settings_mappings": [settings_case(name, mapping) for name, mapping in settings_mappings],
        "requests": [request_case(name, envelope) for name, envelope in request_cases] + contract_reject_cases,
        "chat_requests": chat_requests,
        "responses": responses,
        "inference": inference_cases(valid_payload),
        "runtime": runtime_cases(valid_payload),
    }
    target = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests" / "fixtures" / "oracle.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=1, sort_keys=False)
        handle.write("\n")
    print(f"wrote {target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    raise SystemExit(main())
