"""Client registry; context preparation has no dependency on a client's wire protocol."""

from .codex import CodexCLIAdapter, CodexDesktopAdapter
from .dsh import DshDesktopAdapter
from .opencode import OpenCodeCLIAdapter, OpenCodeDesktopAdapter

CLIENTS = {"codex-desktop": CodexDesktopAdapter, "codex-cli": CodexCLIAdapter, "dsh-desktop": DshDesktopAdapter,
           "opencode-desktop": OpenCodeDesktopAdapter, "opencode-cli": OpenCodeCLIAdapter}


def adapter_for(client, rpc=None, *, codex="codex", terminal_path="", dsh_home="", opencode="opencode", opencode_desktop=""):
    if client not in CLIENTS:
        raise ValueError(f"Unsupported reader client: {client}")
    factory = CLIENTS[client]
    if client.startswith("opencode-"):
        return factory(opencode=opencode, terminal_path=terminal_path, desktop=opencode_desktop)
    if client == "dsh-desktop":
        return factory(home=dsh_home)
    if client == "codex-cli":
        return factory(rpc, codex=codex, terminal_path=terminal_path)
    return factory(rpc, codex=codex)
