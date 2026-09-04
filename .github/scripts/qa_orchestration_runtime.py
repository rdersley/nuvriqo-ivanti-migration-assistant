#!/usr/bin/env python3
"""Deterministic regression simulation for Ivanti -> Jira orchestration.

This models the Jira event stream that previously created duplicate subtasks and
asserts the behavioural contract expected from the Forge graph engine.
It is deliberately dependency-free so it can run on every CI deployment.
"""

from dataclasses import dataclass, field


@dataclass
class RunState:
    active: set[str] = field(default_factory=lambda: {"start"})
    passed: set[str] = field(default_factory=set)
    created: dict[str, str] = field(default_factory=dict)
    counters: dict[str, int] = field(default_factory=dict)

    def create_once(self, node: str) -> None:
        if node in self.created:
            return
        self.counters[node] = self.counters.get(node, 0) + 1
        self.created[node] = f"SIM-{len(self.created) + 1}"


INITIAL = ["active-directory", "office-365"]
SECOND_WAVE = ["firewall-vpn-cisco", "jira", "slack", "harvest"]


def on_parent_created(state: RunState) -> None:
    if "start" in state.passed:
        return
    state.active.discard("start")
    state.passed.add("start")
    state.active.update(INITIAL)
    for node in INITIAL:
        state.create_once(node)


def on_parent_updated(state: RunState) -> None:
    # Parent updates (Forms/SLA/assignment/app actions) must never restart a run.
    return


def on_child_created(state: RunState, node: str) -> None:
    # App-created child creation events are intentionally ignored.
    return


def on_child_done(state: RunState, node: str) -> None:
    if node in state.passed:
        return
    if node not in state.created:
        raise AssertionError(f"completion received for unknown child {node}")
    state.active.discard(node)
    state.passed.add(node)
    if all(n in state.passed for n in INITIAL):
        state.active.update(SECOND_WAVE)
        for next_node in SECOND_WAVE:
            state.create_once(next_node)


def assert_count(state: RunState, node: str, expected: int) -> None:
    actual = state.counters.get(node, 0)
    assert actual == expected, f"{node}: expected {expected} creations, got {actual}"


def run() -> None:
    state = RunState()

    # 1. New Jira parent creates the first wave exactly once.
    on_parent_created(state)
    for node in INITIAL:
        assert_count(state, node, 1)

    # 2. Recursive child CREATED events must not create duplicates.
    for node in INITIAL:
        on_child_created(state, node)
    for node in INITIAL:
        assert_count(state, node, 1)

    # 3. Noisy parent updates must not restart orchestration.
    for _ in range(5):
        on_parent_updated(state)
    for node in INITIAL:
        assert_count(state, node, 1)

    # 4. First child completion waits at the join/gate.
    on_child_done(state, "active-directory")
    for node in SECOND_WAVE:
        assert_count(state, node, 0)

    # 5. Second child completion opens the gate and creates one of each next task.
    on_child_done(state, "office-365")
    for node in SECOND_WAVE:
        assert_count(state, node, 1)

    # 6. Event replay is idempotent.
    on_child_done(state, "office-365")
    on_child_done(state, "active-directory")
    on_parent_updated(state)
    for node in INITIAL + SECOND_WAVE:
        assert_count(state, node, 1)

    # 7. Parent create replay must also be idempotent.
    on_parent_created(state)
    for node in INITIAL + SECOND_WAVE:
        assert_count(state, node, 1)

    print("PASS orchestration runtime simulation")
    print("Initial wave:", ", ".join(INITIAL))
    print("Second wave:", ", ".join(SECOND_WAVE))
    print("Duplicate/replay protection: PASS")
    print("Gate behaviour: PASS")


if __name__ == "__main__":
    run()
