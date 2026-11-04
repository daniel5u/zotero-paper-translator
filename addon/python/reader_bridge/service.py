"""Prepare files and dispatch to a client adapter without extraction or inference."""

from dataclasses import asdict
import json
from pathlib import Path
import shutil

from . import ConversationRef
from .context import ContextBundle, SourceFile
from .clients import CLIENTS, adapter_for


def prepare(job, emit):
    folder = Path(job["workspace"]).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    emit("progress", stage_id="pt-bridge-preparing-files")
    original = Path(job["input"]).resolve()
    source = folder / "paper.pdf"
    if original != source:
        shutil.copyfile(original, source)
    sources = [SourceFile("pdf", "pdf", str(source), job["title"], job.get("pdf_origin", ""))]
    metadata = dict(job.get("metadata", {}))
    metadata["source_pdf"] = str(original)
    metadata["zotero_uri"] = job.get("pdf_origin", "")
    metadata["source_url"] = job.get("web_url", "")
    warnings = []
    html = job.get("web_snapshot")
    if html:
        try:
            target = folder / "source.html"
            if Path(html).resolve() != target:
                shutil.copyfile(html, target)
            sources.append(SourceFile("web", "web", str(target), job["title"] + " - web source", job.get("web_url", "")))
            metadata["source_html"] = str(Path(html).resolve())
        except OSError as error:
            warnings.append(str(error))
    metadata_file = folder / "metadata.json"
    metadata_file.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sources.insert(1, SourceFile("metadata", "metadata", str(metadata_file), "Zotero bibliographic metadata"))
    bundle = ContextBundle(job["conversation_title"], sources)
    (folder / "context.json").write_text(json.dumps(bundle.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return bundle, warnings


def create(job, emit):
    client = job.get("client", "codex-desktop")
    if client not in CLIENTS:
        raise ValueError("Unsupported reader client.")
    codex = shutil.which(job.get("codex_path") or "codex") if client.startswith("codex-") else None
    if client.startswith("codex-") and not codex:
        raise ValueError("Codex executable was not found. Set its path in Paper Translator settings.")
    opencode = shutil.which(job.get("opencode_path") or "opencode") if client.startswith("opencode-") else None
    if client.startswith("opencode-") and not opencode:
        raise ValueError("OpenCode executable was not found. Set its path in Paper Translator settings.")
    bundle, warnings = prepare(job, emit)
    folder = Path(job["workspace"]).resolve()
    emit("progress", stage_id="pt-bridge-creating")
    reference = adapter_for(client, codex=codex, dsh_home=job.get("dsh_home", ""),
                            opencode=opencode or "opencode").create_conversation(bundle, workspace=str(folder))
    metadata = job.get("metadata", {})
    result = {"conversation": asdict(reference), "client": client, "workspace": str(folder),
              "paper": {key: metadata.get(key) for key in ("library_id", "item_key", "attachment_key")},
              "files": len(bundle.sources), "web_sources": sum(source.kind == "web" for source in bundle.sources),
              "warnings": warnings}
    if codex:
        result["codex_path"] = codex
    if opencode:
        result["opencode_path"] = opencode
    if client == "dsh-desktop":
        from .dsh import harness_home
        result["dsh_home"] = str(harness_home(job.get("dsh_home", "")))
    record = folder / "conversation.json"
    temporary = folder / "conversation.json.tmp"
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(record)
    emit("done", **result)


def open_client(job, emit):
    folder = Path(job["workspace"])
    result = json.loads((folder / "conversation.json").read_text(encoding="utf-8"))
    reference = ConversationRef(**result["conversation"])
    if not reference.workspace:
        reference = ConversationRef(reference.client, reference.conversation_id, reference.url, str(folder))
    codex = job.get("codex_path") or result.get("codex_path") or "codex"
    adapter_for(result["client"], codex=codex, terminal_path=job.get("terminal_path", "").strip(),
                dsh_home=result.get("dsh_home") or job.get("dsh_home", ""),
                opencode=job.get("opencode_path") or result.get("opencode_path") or "opencode",
                opencode_desktop=job.get("opencode_desktop_path", "")).open_conversation(reference)
    emit("done", opened=True)


# Keep the previous runner command available for existing callers.
open_cli = open_client
