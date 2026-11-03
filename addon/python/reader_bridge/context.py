"""Versioned local file references, independent of any agent client."""

from dataclasses import asdict, dataclass
import json
from pathlib import Path


@dataclass(frozen=True)
class SourceFile:
    source_id: str
    kind: str
    path: str
    title: str = ""
    origin: str = ""


@dataclass(frozen=True)
class ContextBundle:
    title: str
    sources: list[SourceFile]
    schema_version: int = 2

    def __post_init__(self):
        if self.schema_version != 2 or not isinstance(self.title, str) or not self.title.strip():
            raise ValueError("A file context requires schema version 2 and a nonempty title.")
        if not self.sources or len({source.source_id for source in self.sources}) != len(self.sources):
            raise ValueError("Source identifiers must be nonempty and unique.")
        for source in self.sources:
            if not source.source_id or not Path(source.path).is_absolute():
                raise ValueError("Every source requires an identifier and an absolute file path.")
            if not Path(source.path).is_file():
                raise ValueError(f"Source file not found: {source.path}")

    def to_dict(self):
        return asdict(self)

    @classmethod
    def load(cls, path):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if data.get("schema_version") != 2:
            raise ValueError("Unsupported context schema. Prepare a new file reference bundle.")
        return cls(data["title"], [SourceFile(**source) for source in data.get("sources", [])])
