#!/usr/bin/env python3
"""Deterministic regression simulation for Ivanti -> Jira orchestration.

Covers duplicate-event protection plus the full known New Employee Setup path:
AD/O365 -> join -> second wave -> join -> Assets -> ServiceDesk decision ->
optional PBX -> completion.
"""

from dataclasses import dataclass, field


@dataclass
class RunState:
    active: set[str] = field(default_factory=lambda: {"start"})
    passed: set[str] = field(default_factory=set)
    created: dict[str, str] = field(default_factory=dict)
    counters: dict[str, int] = field(default_factory=dict)
    completed: bool = False

    def create_once(self, node: str) -> None:
        if node in self.created:
            return
        self.counters[node] = self.counters.get(node, 0) + 1
        self.created[node] = f"SIM-{len(self.created) + 1}"


INITIAL = ["active-directory", "office-365"]
SECOND_WAVE = ["firewall-vpn-cisco", "jira", "slack", "harvest"]
ASSETS = "assets"
PBX = "pbx"
ALL_TASKS = INITIAL + SECOND_WAVE + [ASSETS, PBX]


def create_nodes(state: RunState, nodes: list[str]) -> None:
    state.active.update(nodes)
    for node in nodes:
        state.create_once(node)


def on_parent_created(state: RunState) -> None:
    if "start" in state.passed:
        return
    state.active.discard("start")
    state.passed.add("start")
    create_nodes(state, INITIAL)


def on_parent_updated(state: RunState) -> None:
    # Forms, SLA, assignment and app-generated parent updates must never restart a run.
    return


def on_child_created(state: RunState, node: str) -> None:
    # App-created child CREATE events are intentionally ignored by the live handler.
    return


def pass_node(state: RunState, node: str) -> bool:
    if node in state.passed:
        return False
    if node not in state.created:
        raise AssertionError(f"completion received for unknown child {node}")
    state.active.discard(node)
    state.passed.add(node)
    return True


def on_child_done(state: RunState, node: str) -> None:
    if not pass_node(state, node):
        return

    if node in INITIAL and all(n in state.passed for n in INITIAL):
        create_nodes(state, SECOND_WAVE)
        return

    if node in SECOND_WAVE and all(n in state.passed for n in SECOND_WAVE):
        create_nodes(state, [ASSETS])
        return

    if node == PBX:
        state.completed = True


def after_assets(state: RunState, service_desk: bool) -> None:
    if not pass_node(state, ASSETS):
        return
    if service_desk:
        create_nodes(state, [PBX])
    else:
        state.completed = True


def assert_count(state: RunState, node: str, expected: int) -> None:
    actual = state.counters.get(node, 0)
    assert actual == expected, f"{node}: expected {expected} creations, got {actual}"


def assert_no_duplicates(state: RunState) -> None:
    for node, count in state.counters.items():
        assert count == 1, f"{node}: duplicate creation detected ({count})"


def progress_to_assets() -> RunState:
    state = RunState()
    on_parent_created(state)
    for node in INITIAL:
        on_child_created(state, node)
    for _ in range(5):
        on_parent_updated(state)

    on_child_done(state, INITIAL[0])
    for node in SECOND_WAVE:
        assert_count(state, node, 0)
    on_child_done(state, INITIAL[1])
    for node in SECOND_WAVE:
        assert_count(state, node, 1)

    # Complete second wave in deliberately mixed order. Assets must wait for all four.
    for node in ["jira", "harvest", "firewall-vpn-cisco"]:
        on_child_done(state, node)
        assert_count(state, ASSETS, 0)
    on_child_done(state, "slack")
    assert_count(state, ASSETS, 1)
    return state


def test_no_service_desk_branch() -> None:
    state = progress_to_assets()
    after_assets(state, service_desk=False)
    assert state.completed, "No-ServiceDesk branch must complete without PBX"
    assert_count(state, PBX, 0)

    # Replays must remain harmless.
    on_parent_created(state)
    on_parent_updated(state)
    on_child_done(state, "slack")
    after_assets(state, service_desk=False)
    assert_no_duplicates(state)


def test_service_desk_branch() -> None:
    state = progress_to_assets()
    after_assets(state, service_desk=True)
    assert not state.completed, "ServiceDesk branch must wait for PBX"
    assert_count(state, PBX, 1)

    on_child_created(state, PBX)
    assert_count(state, PBX, 1)
    on_child_done(state, PBX)
    assert state.completed, "PBX completion must finish orchestration"

    # Replay every historically noisy event and prove idempotence end-to-end.
    for node in INITIAL + SECOND_WAVE + [ASSETS, PBX]:
        on_child_created(state, node)
        if node in state.created:
            on_child_done(state, node)
    for _ in range(3):
        on_parent_updated(state)
        on_parent_created(state)
    assert_no_duplicates(state)


def run() -> None:
    test_no_service_desk_branch()
    test_service_desk_branch()
    print("PASS orchestration runtime simulation")
    print("Initial gate: PASS")
    print("Second gate: PASS")
    print("Assets sequencing: PASS")
    print("ServiceDesk FALSE branch: PASS")
    print("ServiceDesk TRUE -> PBX branch: PASS")
    print("Duplicate/replay protection across full flow: PASS")


if __name__ == "__main__":
    run()
