"""Run one RAPP agent.py outside the brainstem kernel.

    python3 agent_runner.py contract <agent.py>            -> {"name", "description", "parameters", "class"}
    python3 agent_runner.py perform  <agent.py> '<json>'   -> {"result": "..."}  (kwargs from the JSON object)

The agent imports the same names it would inside the grail kernel (`agents.basic_agent.BasicAgent`,
`utils.azure_file_storage`, `utils.storage_factory`, `openrappter.*`), backed by the genome's own
`local_storage.py` when it has one, so memory written here lands where the kernel would write it.
Everything the agent prints goes to stderr; stdout carries exactly one JSON line.
"""
import contextlib
import importlib.util
import inspect
import json
import os
import pathlib
import sys
import types


def _load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"not a python module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _register_shims(agent_file):
    agents_dir = agent_file.parent
    genome = agents_dir.parent
    for p in (str(agents_dir), str(genome)):
        if p not in sys.path:
            sys.path.insert(0, p)

    basic = agents_dir / "basic_agent.py"
    if basic.exists():
        ba = _load_file("agents.basic_agent", basic)
    else:
        ba = types.ModuleType("agents.basic_agent")

        class BasicAgent:  # minimal stand-in for genomes without the RAPP base class
            def __init__(self, name=None, metadata=None, *a, **k):
                self.name = name
                self.metadata = metadata

            def perform(self, **kwargs):
                raise NotImplementedError

        ba.BasicAgent = BasicAgent
        sys.modules["agents.basic_agent"] = ba

    agents = sys.modules.get("agents") or types.ModuleType("agents")
    agents.__path__ = [str(agents_dir)]
    agents.basic_agent = ba
    sys.modules["agents"] = agents

    orp = types.ModuleType("openrappter")
    orp.__path__ = [str(genome)]
    orp_agents = types.ModuleType("openrappter.agents")
    orp_agents.__path__ = [str(agents_dir)]
    orp_agents.basic_agent = ba
    orp.agents = orp_agents
    sys.modules["openrappter"] = orp
    sys.modules["openrappter.agents"] = orp_agents
    sys.modules["openrappter.agents.basic_agent"] = ba

    storage_cls = None
    local_storage = genome / "local_storage.py"
    if local_storage.exists():
        try:
            storage_cls = getattr(_load_file("local_storage", local_storage), "AzureFileStorageManager", None)
        except Exception as e:  # pragma: no cover - genome-specific
            print(f"[agent_runner] local_storage.py failed to import: {e}", file=sys.stderr)
    if storage_cls is None:
        class _NoStorage:
            def __init__(self, *a, **k):
                pass

            def __getattr__(self, name):
                return lambda *a, **k: None

        storage_cls = _NoStorage

    utils = types.ModuleType("utils")
    utils.__path__ = []
    afs = types.ModuleType("utils.azure_file_storage")
    afs.AzureFileStorageManager = storage_cls
    dyn = types.ModuleType("utils.dynamics_storage")
    dyn.DynamicsStorageManager = storage_cls
    factory = types.ModuleType("utils.storage_factory")
    factory.get_storage_manager = lambda: storage_cls()
    utils.azure_file_storage = afs
    utils.dynamics_storage = dyn
    utils.storage_factory = factory
    for name, mod in (("utils", utils), ("utils.azure_file_storage", afs),
                      ("utils.dynamics_storage", dyn), ("utils.storage_factory", factory)):
        sys.modules.setdefault(name, mod)
    return ba.BasicAgent


def _instantiate(agent_file):
    BasicAgent = _register_shims(agent_file)
    module = _load_file("rapp_agent_" + agent_file.stem, agent_file)
    errors = []
    for value in list(vars(module).values()):
        if not (isinstance(value, type) and issubclass(value, BasicAgent) and value is not BasicAgent):
            continue
        if value.__module__ != module.__name__:
            continue
        try:
            return value()
        except Exception as e:  # keep looking; report if nothing works
            errors.append(f"{value.__name__}: {type(e).__name__}: {e}")
    raise RuntimeError("no BasicAgent subclass could be instantiated" + (": " + "; ".join(errors) if errors else ""))


def contract(agent_file):
    inst = _instantiate(agent_file)
    md = getattr(inst, "metadata", None) or {}
    return {
        "name": getattr(inst, "name", None) or md.get("name") or type(inst).__name__,
        "description": md.get("description", ""),
        "parameters": md.get("parameters") or {"type": "object", "properties": {}},
        "class": type(inst).__name__,
    }


def perform(agent_file, kwargs):
    inst = _instantiate(agent_file)
    sig = inspect.signature(inst.perform)
    accepts_any = any(p.kind is inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values())
    if not accepts_any:
        kwargs = {k: v for k, v in kwargs.items() if k in sig.parameters}
    result = inst.perform(**kwargs)
    if not isinstance(result, str):
        try:
            result = json.dumps(result, ensure_ascii=False, default=str)
        except Exception:
            result = str(result)
    return {"result": result}


def main(argv):
    if len(argv) < 3 or argv[1] not in ("contract", "perform"):
        print(json.dumps({"error": "usage: agent_runner.py contract <agent.py> | perform <agent.py> '<json>'"}))
        return 2
    agent_file = pathlib.Path(argv[2]).resolve()
    kwargs = json.loads(argv[3]) if argv[1] == "perform" and len(argv) > 3 and argv[3] else {}
    try:
        with contextlib.redirect_stdout(sys.stderr):
            payload = contract(agent_file) if argv[1] == "contract" else perform(agent_file, kwargs)
    except Exception as e:
        payload = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(payload, ensure_ascii=False))
    return 1 if "error" in payload else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
