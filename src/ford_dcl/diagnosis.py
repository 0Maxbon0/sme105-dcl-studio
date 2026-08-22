"""Conservative high-idle evidence classification.

The classifier never substitutes for the physical airflow-isolation test. Its
output is a reproducible decision record, not a repair instruction.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path
from typing import Any


class AirflowIsolation(str, Enum):
    NOT_PERFORMED = "not_performed"
    RPM_DROPPED_OR_STALLED = "rpm_dropped_or_stalled"
    RPM_REMAINED_HIGH = "rpm_remained_high"


class MixtureEvidence(str, Enum):
    UNKNOWN = "unknown"
    LEAN = "lean"
    NORMAL = "normal"
    RICH = "rich"


class DiagnosisBranch(str, Enum):
    NO_HIGH_IDLE = "no_high_idle"
    TEMPERATURE_INPUT = "temperature_input"
    THROTTLE_INPUT_OR_PLATE = "throttle_input_or_plate"
    ECU_COMMANDED_IDLE = "ecu_commanded_idle"
    EXCESS_AIR_UNCONFIRMED = "excess_air_unconfirmed"
    IAC_BYPASS_CONFIRMED = "iac_bypass_confirmed"
    NON_IAC_AIRFLOW_CONFIRMED = "non_iac_airflow_confirmed"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"


@dataclass(frozen=True, slots=True)
class DiagnosisThresholds:
    high_idle_rpm: float = 1000.0
    fully_warm_ect_deg_c: float = 80.0
    minimum_iac_percent: float = 10.0


@dataclass(frozen=True, slots=True)
class WarmIdleEvidence:
    rpm: float | None
    ect_deg_c: float | None
    tps_closed: bool | None
    iac_percent: float | None
    airflow_isolation: AirflowIsolation = AirflowIsolation.NOT_PERFORMED
    mixture: MixtureEvidence = MixtureEvidence.UNKNOWN
    repeated_sessions: int = 0
    source_capture_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "airflow_isolation", AirflowIsolation(self.airflow_isolation)
        )
        object.__setattr__(self, "mixture", MixtureEvidence(self.mixture))
        if self.repeated_sessions < 0:
            raise ValueError("repeated_sessions cannot be negative")


@dataclass(frozen=True, slots=True)
class DiagnosisResult:
    branch: DiagnosisBranch
    conclusion: str
    definitive: bool
    supporting_evidence: tuple[str, ...]
    missing_evidence: tuple[str, ...]
    next_checks: tuple[str, ...]
    thresholds: DiagnosisThresholds
    evidence: WarmIdleEvidence

    def to_dict(self) -> dict[str, Any]:
        document = asdict(self)
        document["branch"] = self.branch.value
        document["evidence"]["airflow_isolation"] = (
            self.evidence.airflow_isolation.value
        )
        document["evidence"]["mixture"] = self.evidence.mixture.value
        return document


def classify_high_idle(
    evidence: WarmIdleEvidence,
    thresholds: DiagnosisThresholds | None = None,
) -> DiagnosisResult:
    selected = thresholds or DiagnosisThresholds()
    telemetry_missing = [
        name
        for name, value in (
            ("rpm", evidence.rpm),
            ("ect_deg_c", evidence.ect_deg_c),
            ("tps_closed", evidence.tps_closed),
            ("iac_percent", evidence.iac_percent),
        )
        if value is None
    ]
    missing = list(telemetry_missing)
    support: list[str] = []
    if evidence.repeated_sessions < 3:
        missing.append("three repeatable fully-warm sessions")
    if not evidence.source_capture_ids:
        missing.append("source capture IDs")
    if telemetry_missing:
        return _result(
            DiagnosisBranch.INSUFFICIENT_EVIDENCE,
            "Required synchronized telemetry is missing.",
            False,
            support,
            missing,
            ("Capture RPM, ECT, closed-throttle state, and IAC command together.",),
            selected,
            evidence,
        )

    assert evidence.rpm is not None
    assert evidence.ect_deg_c is not None
    assert evidence.tps_closed is not None
    assert evidence.iac_percent is not None

    if evidence.rpm <= selected.high_idle_rpm:
        support.append(f"RPM {evidence.rpm:g} is not above the configured threshold")
        return _result(
            DiagnosisBranch.NO_HIGH_IDLE,
            "The supplied sample does not meet the configured high-idle condition.",
            False,
            support,
            missing,
            (
                "Repeat after stable full operating temperature if the symptom is intermittent.",
            ),
            selected,
            evidence,
        )
    support.append(f"RPM {evidence.rpm:g} exceeds {selected.high_idle_rpm:g}")

    if evidence.ect_deg_c < selected.fully_warm_ect_deg_c:
        support.append(
            f"ECT {evidence.ect_deg_c:g} is below {selected.fully_warm_ect_deg_c:g}"
        )
        return _result(
            DiagnosisBranch.TEMPERATURE_INPUT,
            "The ECU data does not establish a fully warm high-idle condition.",
            False,
            support,
            missing,
            ("Validate ECT against ambient cold soak and the complete warm-up curve.",),
            selected,
            evidence,
        )
    support.append(f"ECT {evidence.ect_deg_c:g} indicates a warm engine")

    if not evidence.tps_closed:
        support.append("TPS closed-throttle state is false")
        return _result(
            DiagnosisBranch.THROTTLE_INPUT_OR_PLATE,
            "A closed-throttle condition is not established.",
            False,
            support,
            missing,
            ("Check TPS sweep/closed flag, throttle cable, stop, and plate seating.",),
            selected,
            evidence,
        )
    support.append("TPS reports closed throttle")

    if evidence.iac_percent > selected.minimum_iac_percent:
        support.append(
            f"IAC command {evidence.iac_percent:g}% is above the minimum threshold"
        )
        return _result(
            DiagnosisBranch.ECU_COMMANDED_IDLE,
            "The ECU appears to be commanding bypass air; identify the input or load reason.",
            False,
            support,
            missing,
            ("Check ECT/TPS/load switches, VSS, steering, A/C, and DTC evidence.",),
            selected,
            evidence,
        )
    support.append(
        f"IAC command {evidence.iac_percent:g}% is at the minimum candidate range"
    )
    if evidence.mixture is MixtureEvidence.LEAN:
        support.append("Mixture evidence is lean and supports post-MAF air ingress")

    if evidence.airflow_isolation is AirflowIsolation.NOT_PERFORMED:
        missing.append("reversible IAC airflow-isolation result")
        return _result(
            DiagnosisBranch.EXCESS_AIR_UNCONFIRMED,
            "Telemetry supports excess airflow, but its path is not isolated.",
            False,
            support,
            missing,
            (
                "Perform the documented engine-off reversible IAC-air-path blanking test.",
            ),
            selected,
            evidence,
        )
    if evidence.airflow_isolation is AirflowIsolation.RPM_DROPPED_OR_STALLED:
        support.append(
            "RPM dropped or the engine stalled when the IAC air path was isolated"
        )
        return _result(
            DiagnosisBranch.IAC_BYPASS_CONFIRMED,
            "The excess idle airflow passes through the IAC bypass path.",
            not missing,
            support,
            missing,
            (
                "Inspect IAC sticking, sealing, passages, wiring, and commanded response.",
            ),
            selected,
            evidence,
        )
    support.append("RPM remained high with the IAC air path isolated")
    return _result(
        DiagnosisBranch.NON_IAC_AIRFLOW_CONFIRMED,
        "The excess idle airflow is outside the isolated IAC bypass path.",
        not missing,
        support,
        missing,
        (
            "Smoke-test PCV, intake and throttle-body gaskets; inspect throttle plate/cable.",
        ),
        selected,
        evidence,
    )


def load_evidence(path: str | Path) -> WarmIdleEvidence:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(document, Mapping):
        raise ValueError("diagnosis evidence must be a JSON object")
    return WarmIdleEvidence(
        rpm=_optional_number(document.get("rpm"), "rpm"),
        ect_deg_c=_optional_number(document.get("ect_deg_c"), "ect_deg_c"),
        tps_closed=_optional_bool(document.get("tps_closed"), "tps_closed"),
        iac_percent=_optional_number(document.get("iac_percent"), "iac_percent"),
        airflow_isolation=AirflowIsolation(
            document.get("airflow_isolation", AirflowIsolation.NOT_PERFORMED.value)
        ),
        mixture=MixtureEvidence(document.get("mixture", MixtureEvidence.UNKNOWN.value)),
        repeated_sessions=int(document.get("repeated_sessions", 0)),
        source_capture_ids=tuple(
            str(item) for item in document.get("source_capture_ids", ())
        ),
    )


def _result(
    branch: DiagnosisBranch,
    conclusion: str,
    definitive: bool,
    support: list[str],
    missing: list[str],
    next_checks: tuple[str, ...],
    thresholds: DiagnosisThresholds,
    evidence: WarmIdleEvidence,
) -> DiagnosisResult:
    return DiagnosisResult(
        branch,
        conclusion,
        definitive,
        tuple(support),
        tuple(missing),
        next_checks,
        thresholds,
        evidence,
    )


def _optional_number(value: object, name: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be numeric or null")
    return float(value)


def _optional_bool(value: object, name: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise TypeError(f"{name} must be boolean or null")
    return value
