"""The user's standalone ``~/.kiro/hooks/*.json`` files run on KAS; project ones do not.

``kiro-cli chat --agent-engine v3`` runs the user's standalone v1 hook files. Crew
fires the USER files on KAS through the same turn-loop ``extra_hooks`` path the
agent spec's hooks ride, so they meet the same gates. Project
``<project>/.kiro/hooks/*.json`` stay off -- Crew cannot read a checkout's
workspace-trust verdict -- and the session says so.

These are behaviour tests: they drive the real loader and the real
``ScriptHookStore.fire`` path and assert what runs, not that a symbol exists.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import kiro_crew.hooks as hooks_mod
from kiro_crew.agent_sdk import spec_hooks
from kiro_crew.hooks import (
    HOOK_EVENT_PRE_TOOL_USE,
    HOOK_EVENT_USER_PROMPT_SUBMIT,
    ScriptHookStore,
)


def _passthrough_sandbox(monkeypatch):
    monkeypatch.setattr("kiro_crew.sandbox.wrap_argv", lambda argv, **k: (list(argv), None))
    monkeypatch.setattr("kiro_crew.sandbox.cgroup_scope_argv", lambda argv: list(argv))


def _marker_command(tmp_path: Path, name: str) -> str:
    """A command that writes a marker file, so a fire is observable."""
    script = tmp_path / f"{name}.py"
    out = tmp_path / f"{name}.marker"
    script.write_text(
        f"open({str(out)!r}, 'w', encoding='utf-8').write('fired')\n", encoding="utf-8"
    )
    return f'"{sys.executable}" "{script}"'


def _write_user_hook(home: Path, filename: str, hooks: list[dict]) -> None:
    hooks_dir = home / ".kiro" / "hooks"
    hooks_dir.mkdir(parents=True, exist_ok=True)
    (hooks_dir / filename).write_text(
        json.dumps({"version": "v1", "hooks": hooks}), encoding="utf-8"
    )


def _point_hooks_dir(monkeypatch, home: Path) -> None:
    """Point the user hooks directory at ``home/.kiro/hooks`` via the documented seam.

    The resolver reads ``agent._DEFAULT_KIRO_HOOKS_DIR`` (the same constant the
    ``*.sh`` autoimport tests patch) and ``agent.kiro_hooks_dir`` from the mc
    config. Patch the constant to the temp HOME's hooks dir and point the config
    path at a non-existent file so no custom override is read.
    """
    import kiro_crew.agent as agent_mod

    (home / ".kiro" / "hooks").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(agent_mod, "_DEFAULT_KIRO_HOOKS_DIR", home / ".kiro" / "hooks")
    monkeypatch.setattr(agent_mod, "_mc_config_path", lambda: home / "no-such-config.json")
    # Clear the per-file conversion cache so a prior test's entries never leak.
    from kiro_crew.agent_sdk import spec_hooks as _sh

    _sh._user_file_cache.clear()


# (a) a temp-HOME user hook file's UserPromptSubmit command fires through the real
#     KAS turn-loop path (a marker file is written). RED on main: user files load
#     nowhere, so user_hook_files does not exist / returns nothing.
def test_a_user_prompt_submit_user_file_hook_fires(tmp_path, monkeypatch):
    _passthrough_sandbox(monkeypatch)
    monkeypatch.setattr(hooks_mod, "_script_hooks_capability_denied", lambda sk="": None)
    home = tmp_path / "home"
    marker = tmp_path / "prompt.marker"
    _write_user_hook(
        home,
        "zz-probe.json",
        [
            {
                "name": "probe-prompt",
                "trigger": "UserPromptSubmit",
                "action": {"type": "command", "command": _marker_command(tmp_path, "prompt")},
                "timeout": 10,
            }
        ],
    )
    _point_hooks_dir(monkeypatch, home)
    hooks = spec_hooks.user_hook_files()
    assert [h.event for h in hooks] == [HOOK_EVENT_USER_PROMPT_SUBMIT]
    asyncio.run(
        ScriptHookStore(tmp_path).fire(HOOK_EVENT_USER_PROMPT_SUBMIT, "hi", extra_hooks=hooks)
    )
    assert marker.exists(), "the user file's UserPromptSubmit hook did not fire"


# (b) a project .kiro/hooks file does not fire and the notice is emitted.
def test_b_project_hook_files_are_not_loaded_and_notice_is_emitted(tmp_path, monkeypatch):
    # The loader reads only the USER directory; a project file is never returned.
    home = tmp_path / "home"
    (home / ".kiro" / "hooks").mkdir(parents=True)  # empty user dir
    project = tmp_path / "proj"
    (project / ".kiro" / "hooks").mkdir(parents=True)
    (project / ".kiro" / "hooks" / "p.json").write_text(
        json.dumps(
            {
                "version": "v1",
                "hooks": [
                    {
                        "name": "p",
                        "trigger": "UserPromptSubmit",
                        "action": {"type": "command", "command": "echo hi"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    _point_hooks_dir(monkeypatch, home)
    assert spec_hooks.user_hook_files() == []
    # The detector that drives the session notice sees the project files.
    assert spec_hooks.project_hook_files_present(str(project)) is True
    assert spec_hooks.project_hook_files_present(None) is False


# (c) an unknown action type or trigger is skipped, not guessed.
def test_c_unknown_action_or_trigger_is_skipped(tmp_path, monkeypatch):
    home = tmp_path / "home"
    _write_user_hook(
        home,
        "mixed.json",
        [
            {
                "name": "ok",
                "trigger": "UserPromptSubmit",
                "action": {"type": "command", "command": "echo ok"},
            },
            {
                "name": "agent-action",
                "trigger": "Stop",
                "action": {"type": "agent", "prompt": "hi"},
            },
            {
                "name": "bad-trigger",
                "trigger": "Nope",
                "action": {"type": "command", "command": "echo no"},
            },
        ],
    )
    _point_hooks_dir(monkeypatch, home)
    hooks = spec_hooks.user_hook_files()
    # Only the one command hook on a known trigger survives.
    assert [(h.event, h.command) for h in hooks] == [(HOOK_EVENT_USER_PROMPT_SUBMIT, "echo ok")]


# (d) a PreToolUse user-file hook that exits 2 blocks the tool.
def test_d_pre_tool_use_exit_2_blocks(tmp_path, monkeypatch):
    _passthrough_sandbox(monkeypatch)
    monkeypatch.setattr(hooks_mod, "_script_hooks_capability_denied", lambda sk="": None)
    home = tmp_path / "home"
    script = tmp_path / "deny.py"
    script.write_text("import sys\nsys.exit(2)\n", encoding="utf-8")
    _write_user_hook(
        home,
        "deny.json",
        [
            {
                "name": "deny",
                "trigger": "PreToolUse",
                "action": {"type": "command", "command": f'"{sys.executable}" "{script}"'},
            }
        ],
    )
    _point_hooks_dir(monkeypatch, home)
    hooks = spec_hooks.user_hook_files()
    assert [h.event for h in hooks] == [HOOK_EVENT_PRE_TOOL_USE]
    results = asyncio.run(
        ScriptHookStore(tmp_path).fire(
            HOOK_EVENT_PRE_TOOL_USE, tool_name="shell", tool_input={}, extra_hooks=hooks
        )
    )
    assert [(r.exit_code, r.pre_tool_blocks) for r in results] == [(2, True)]


# (e) DEDICATED no-double-run: the ~/.kiro/hooks SCRIPT autoimport does not also
#     pick up a *.json standalone file, so it fires exactly once (only via the
#     user-file loader, never again through spec hooks).
def test_e_json_file_is_not_also_picked_up_by_sh_autoimport(tmp_path, monkeypatch):
    from kiro_crew.agent_materialization import kiro_hooks

    home = tmp_path / "home"
    _write_user_hook(
        home,
        "once.json",
        [
            {
                "name": "once",
                "trigger": "UserPromptSubmit",
                "action": {"type": "command", "command": "echo once"},
            }
        ],
    )
    _point_hooks_dir(monkeypatch, home)
    hooks_dir = home / ".kiro" / "hooks"
    # The .sh autoimport scans *.sh only, so a *.json file yields no script-hook
    # entries -- the file cannot be double-counted into the spec's hooks.
    assert kiro_hooks._autoimport_kiro_hooks(hooks_dir) == {}
    # And the user-file loader returns it exactly once.
    loaded = spec_hooks.user_hook_files()
    assert len([h for h in loaded if h.command == "echo once"]) == 1


# ── Backend gating: user files + the project notice are KAS ONLY ──
# _prepare_spec_hooks runs for every backend in ACP_BACKENDS_CREW_FIRES_SPEC_HOOKS
# (KAS, goose, opencode). The ruling is KAS only, so a goose/opencode session must
# load no user files and raise no project-files notice.
import asyncio as _asyncio  # noqa: E402
from types import SimpleNamespace as _NS  # noqa: E402

from kiro_crew.agent_sdk.backends import (  # noqa: E402
    ACP_BACKEND_GOOSE,
    ACP_BACKEND_KAS,
    ACP_BACKEND_OPENCODE,
)
from kiro_crew.agent_sdk.capabilities import capabilities_for  # noqa: E402
from kiro_crew.dashboard import chat_runner  # noqa: E402


def _agents_dir(tmp_path, monkeypatch) -> Path:
    import kiro_crew.config.paths as paths_mod

    d = tmp_path / "agents"
    d.mkdir()
    monkeypatch.setattr(paths_mod, "kiro_agents_dir", lambda: d)
    (d / "a1.json").write_text(json.dumps({"name": "a1", "prompt": "p"}), encoding="utf-8")
    return d


def test_f_goose_session_does_not_load_user_files_or_notice(tmp_path, monkeypatch):
    home = tmp_path / "home"
    _write_user_hook(
        home,
        "zz.json",
        [
            {
                "name": "probe",
                "trigger": "UserPromptSubmit",
                "action": {"type": "command", "command": "echo hi"},
            }
        ],
    )
    # A project with standalone hook files too, to prove the notice is gated.
    project = tmp_path / "proj"
    (project / ".kiro" / "hooks").mkdir(parents=True)
    (project / ".kiro" / "hooks" / "p.json").write_text(
        json.dumps({"version": "v1", "hooks": []}), encoding="utf-8"
    )
    _point_hooks_dir(monkeypatch, home)
    _agents_dir(tmp_path, monkeypatch)
    notices: list = []
    monkeypatch.setattr(
        chat_runner,
        "append_and_surface",
        lambda state, slot, role, text, cls, **kw: notices.append(text),
    )
    for backend in (ACP_BACKEND_GOOSE, ACP_BACKEND_OPENCODE):
        client = _NS(capabilities=capabilities_for(backend), cwd=str(project))
        hooks, unreadable, _ = _asyncio.run(
            chat_runner._prepare_spec_hooks(_NS(), _NS(), client, "a1", is_new=True)
        )
        assert unreadable is False
        # No user-file hook loaded on goose/opencode.
        assert [h for h in hooks if h.spec_origin == "user_file"] == []
    # And no project-hook-files notice was surfaced for either.
    assert not any("hook files in .kiro/hooks" in n for n in notices)


def test_g_kas_session_does_load_user_files(tmp_path, monkeypatch):
    home = tmp_path / "home"
    _write_user_hook(
        home,
        "zz.json",
        [
            {
                "name": "probe",
                "trigger": "UserPromptSubmit",
                "action": {"type": "command", "command": "echo hi"},
            }
        ],
    )
    _point_hooks_dir(monkeypatch, home)
    _agents_dir(tmp_path, monkeypatch)
    monkeypatch.setattr(chat_runner, "append_and_surface", lambda *a, **k: None)
    client = _NS(capabilities=capabilities_for(ACP_BACKEND_KAS), cwd="")
    hooks, unreadable, _ = _asyncio.run(
        chat_runner._prepare_spec_hooks(_NS(), _NS(), client, "a1", is_new=True)
    )
    assert unreadable is False
    assert [h.command for h in hooks if h.spec_origin == "user_file"] == ["echo hi"]
