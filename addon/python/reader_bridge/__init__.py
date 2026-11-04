"""Client-independent reading context and conversation adapter interfaces."""

from dataclasses import dataclass
from typing import Protocol

from .context import ContextBundle


@dataclass(frozen=True)
class ConversationRef:
    client: str
    conversation_id: str
    url: str
    workspace: str = ""


class ConversationAdapter(Protocol):
    """Create a persistent conversation with source material, without inference."""

    def create_conversation(self, bundle: ContextBundle, *, workspace: str) -> ConversationRef: ...

    def open_conversation(self, reference: ConversationRef) -> None: ...

