"""Safe command allow-list and state model.

Exact EEC-IV DCL transaction bytes are not established by the current
evidence.  The entries below are therefore symbolic, unverified templates.
Encoding requires both an explicit opt-in and caller-supplied candidate bytes.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import Enum
from types import MappingProxyType


class CommandKind(str, Enum):
    INITIALIZE = "initialize"
    MODULE_SELECT = "module_select"
    LIVE_DATA = "live_data"
    CONTINUOUS_MEMORY = "continuous_memory"
    KOEO = "koeo"
    KOER = "koer"


class LinkState(str, Enum):
    DISCONNECTED = "disconnected"
    INITIALIZED = "initialized"
    MODULE_SELECTED = "module_selected"


class DiagnosticMode(str, Enum):
    IDLE = "idle"
    LIVE_DATA = "live_data"
    CONTINUOUS_MEMORY = "continuous_memory"
    KOEO = "koeo"
    KOER = "koer"


class Verification(str, Enum):
    UNVERIFIED = "unverified"
    VERIFIED = "verified"


@dataclass(frozen=True, slots=True)
class CommandTemplate:
    kind: CommandKind
    description: str
    required_link_state: LinkState
    resulting_link_state: LinkState
    resulting_mode: DiagnosticMode
    verification: Verification = Verification.UNVERIFIED
    candidate_wire_bytes: bytes | None = None

    @property
    def encodable_by_default(self) -> bool:
        return (
            self.verification is Verification.VERIFIED
            and self.candidate_wire_bytes is not None
        )


@dataclass(frozen=True, slots=True)
class SessionState:
    link: LinkState = LinkState.DISCONNECTED
    mode: DiagnosticMode = DiagnosticMode.IDLE
    selected_module: str | None = None


@dataclass(frozen=True, slots=True)
class CommandRequest:
    kind: CommandKind
    module: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "kind", CommandKind(self.kind))
        if self.kind is CommandKind.MODULE_SELECT:
            if self.module is None or not self.module.strip():
                raise ValueError("module_select requires a symbolic module name")
        elif self.module is not None:
            raise ValueError("module is only valid for module_select")


@dataclass(frozen=True, slots=True)
class PlannedCommand:
    request: CommandRequest
    template: CommandTemplate
    before: SessionState
    after: SessionState


@dataclass(frozen=True, slots=True)
class EncodedCommand:
    plan: PlannedCommand
    wire_bytes: bytes
    verification: Verification
    explicitly_enabled: bool


class UnsafeCommandError(ValueError):
    """Raised when a command is absent from the safe allow-list."""


class CommandStateError(RuntimeError):
    """Raised when an allow-listed command is invalid in the current state."""


class UnverifiedEncodingError(RuntimeError):
    """Raised when wire encoding lacks explicit unverified-protocol consent."""


_TEMPLATES: Mapping[CommandKind, CommandTemplate] = MappingProxyType(
    {
        CommandKind.INITIALIZE: CommandTemplate(
            kind=CommandKind.INITIALIZE,
            description="initialize the diagnostic link",
            required_link_state=LinkState.DISCONNECTED,
            resulting_link_state=LinkState.INITIALIZED,
            resulting_mode=DiagnosticMode.IDLE,
        ),
        CommandKind.MODULE_SELECT: CommandTemplate(
            kind=CommandKind.MODULE_SELECT,
            description="select a diagnostic module symbolically",
            required_link_state=LinkState.INITIALIZED,
            resulting_link_state=LinkState.MODULE_SELECTED,
            resulting_mode=DiagnosticMode.IDLE,
        ),
        CommandKind.LIVE_DATA: CommandTemplate(
            kind=CommandKind.LIVE_DATA,
            description="request a live-data response",
            required_link_state=LinkState.MODULE_SELECTED,
            resulting_link_state=LinkState.MODULE_SELECTED,
            resulting_mode=DiagnosticMode.LIVE_DATA,
        ),
        CommandKind.CONTINUOUS_MEMORY: CommandTemplate(
            kind=CommandKind.CONTINUOUS_MEMORY,
            description="request continuous-memory diagnostic codes",
            required_link_state=LinkState.MODULE_SELECTED,
            resulting_link_state=LinkState.MODULE_SELECTED,
            resulting_mode=DiagnosticMode.CONTINUOUS_MEMORY,
        ),
        CommandKind.KOEO: CommandTemplate(
            kind=CommandKind.KOEO,
            description="request key-on engine-off self-test",
            required_link_state=LinkState.MODULE_SELECTED,
            resulting_link_state=LinkState.MODULE_SELECTED,
            resulting_mode=DiagnosticMode.KOEO,
        ),
        CommandKind.KOER: CommandTemplate(
            kind=CommandKind.KOER,
            description="request key-on engine-running self-test",
            required_link_state=LinkState.MODULE_SELECTED,
            resulting_link_state=LinkState.MODULE_SELECTED,
            resulting_mode=DiagnosticMode.KOER,
        ),
    }
)


SAFE_TEMPLATES: Mapping[CommandKind, CommandTemplate] = _TEMPLATES


def get_template(kind: CommandKind | str) -> CommandTemplate:
    """Return an allow-listed template; reject every unknown operation."""

    try:
        command = CommandKind(kind)
    except (TypeError, ValueError) as exc:
        raise UnsafeCommandError(f"command is not allow-listed: {kind!r}") from exc
    return SAFE_TEMPLATES[command]


def plan_command(state: SessionState, request: CommandRequest) -> PlannedCommand:
    """Validate a symbolic command and calculate its next state."""

    template = get_template(request.kind)
    if state.link is not template.required_link_state:
        raise CommandStateError(
            f"{request.kind.value} requires {template.required_link_state.value}; "
            f"current state is {state.link.value}"
        )
    selected_module = state.selected_module
    if request.kind is CommandKind.INITIALIZE:
        selected_module = None
    elif request.kind is CommandKind.MODULE_SELECT:
        selected_module = request.module
    after = SessionState(
        link=template.resulting_link_state,
        mode=template.resulting_mode,
        selected_module=selected_module,
    )
    return PlannedCommand(request=request, template=template, before=state, after=after)


def encode_command(
    plan: PlannedCommand,
    *,
    allow_unverified: bool = False,
    candidate_wire_bytes: bytes | bytearray | None = None,
) -> EncodedCommand:
    """Encode only with explicit consent when a template is unverified.

    Candidate bytes must be supplied by the caller until captures establish an
    exact transaction.  Empty candidates are rejected.
    """

    template = plan.template
    wire_bytes = (
        bytes(candidate_wire_bytes)
        if candidate_wire_bytes is not None
        else template.candidate_wire_bytes
    )
    if template.verification is Verification.UNVERIFIED and not allow_unverified:
        raise UnverifiedEncodingError(
            f"{template.kind.value} wire transaction is unverified"
        )
    if wire_bytes is None:
        raise UnverifiedEncodingError(
            f"{template.kind.value} has no established wire bytes; "
            "supply candidate_wire_bytes explicitly"
        )
    if not wire_bytes:
        raise ValueError("candidate_wire_bytes must not be empty")
    return EncodedCommand(
        plan=plan,
        wire_bytes=wire_bytes,
        verification=template.verification,
        explicitly_enabled=allow_unverified,
    )


def with_candidate_bytes(
    kind: CommandKind | str,
    candidate_wire_bytes: bytes | bytearray,
) -> CommandTemplate:
    """Return a local unverified template without mutating the allow-list."""

    raw = bytes(candidate_wire_bytes)
    if not raw:
        raise ValueError("candidate_wire_bytes must not be empty")
    return replace(get_template(kind), candidate_wire_bytes=raw)


class CommandSession:
    """Small stateful helper; state advances only after an explicit commit."""

    def __init__(self, state: SessionState | None = None) -> None:
        self._state = state or SessionState()

    @property
    def state(self) -> SessionState:
        return self._state

    def plan(
        self,
        kind: CommandKind | str,
        *,
        module: str | None = None,
    ) -> PlannedCommand:
        request = CommandRequest(CommandKind(kind), module=module)
        return plan_command(self._state, request)

    def commit(self, plan: PlannedCommand) -> SessionState:
        if plan.before != self._state:
            raise CommandStateError("session state changed after command was planned")
        self._state = plan.after
        return self._state
