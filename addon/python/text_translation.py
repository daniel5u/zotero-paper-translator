"""Persistent PDF structure, paragraph jobs, the dual reader PDF and export.

All session files are local. Credentials only arrive through stdin and are never
stored in the manifest. The immutable structure is JSON, not executable pickle.
Each command runs in a separate process; completed paragraph results are saved
atomically before their UI events are emitted.
"""

import copy
import hashlib
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import threading
import time
import uuid
import dataclasses
import types
import typing
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor, as_completed

from translation import RequestOptions, paragraph_messages, request_translation, validate_translation

SCHEMA = 1


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load_state(folder):
    state = json.loads((Path(folder) / "session.json").read_text(encoding="utf-8"))
    if state.get("schema") != SCHEMA:
        raise ValueError("Incompatible translation session format. Reopen the document.")
    return state


def save_state(folder, state):
    state["updated_at"] = time.time()
    atomic_json(Path(folder) / "session.json", state)
    # A few numbers for the library's status column, so Zotero need not read
    # every session's full paragraph list at startup.
    paragraphs = state.get("paragraphs", [])
    suggested = [p for p in paragraphs if p.get("suggested")]
    atomic_json(Path(folder) / "summary.json", {
        "lang": state.get("lang_out"), "updated_at": state["updated_at"],
        "translated": sum(1 for p in paragraphs if p.get("translation")),
        "suggested": len(suggested),
        "suggested_translated": sum(1 for p in suggested if p.get("translation")),
    })


def fingerprint(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_source_pages(pdf_path, state, emit):
    import pymupdf

    with pymupdf.open(pdf_path) as pdf:
        pages = []
        for index, page in enumerate(pdf):
            item = {"number": index + 1, "width": page.rect.width,
                    "height": page.rect.height}
            pages.append(item)
            emit("page", page=item, total=len(pdf))
    state["pages"] = pages


def open_session(job, emit):
    folder = Path(job["session_dir"])
    folder.mkdir(parents=True, exist_ok=True)
    digest = fingerprint(job["input"])
    manifest = folder / "session.json"
    if manifest.exists():
        state = load_state(folder)
        if state["fingerprint"] != digest or state["lang_out"] != job.get("lang_out", "zh"):
            raise ValueError("The source PDF or target language has changed. Reopen the translation session.")
        for item in state["paragraphs"]:
            if item["status"] in ("running", "queued"):
                item["status"] = "done" if item.get("translation") else "pending"
                item["error"] = "The previous task was interrupted. Translation can be resumed."
        # Per-page preview files belonged to an older cache layout.
        state.pop("previews", None)
        if not (folder / "original.pdf").exists():
            # The snapshot expired with the parse cache; the fingerprint
            # above proves the attachment still holds the same PDF.
            shutil.copyfile(job["input"], folder / "original.pdf")
        if state["parse_status"] == "ready" and not parse_cache_ready(folder):
            state["parse_status"] = "expired"
        save_state(folder, state)
        emit("session", session=state)
        # Reuses the dual PDF in Zotero unless pages changed or it is missing.
        publish(folder, state, job, emit)
        return
    # Keep a private source snapshot, so later attachment edits cannot corrupt
    # the coordinate/structure mapping of an existing session.
    shutil.copyfile(job["input"], folder / "original.pdf")
    state = {"schema": SCHEMA, "fingerprint": digest,
             "name": Path(job["input"]).name, "lang_out": job.get("lang_out", "zh"),
             "created_at": time.time(), "parse_status": "pending", "pages": [],
             "paragraphs": [], "revision": 0}
    read_source_pages(folder / "original.pdf", state, emit)
    save_state(folder, state)
    emit("session", session=state)
    publish(folder, state, job, emit)


def make_config(folder, job, model=None, *, rendering=False):
    from babeldoc.format.pdf.translation_config import TranslationConfig, WatermarkOutputMode
    from babeldoc.format.pdf.high_level import TRANSLATE_STAGES
    from babeldoc.progress_monitor import ProgressMonitor

    config = TranslationConfig(
        translator=None, input_file=folder / "source.pdf", lang_in="en",
        lang_out=job.get("lang_out", "zh"), doc_layout_model=model or object(),
        working_dir=folder / "working", output_dir=folder / "output",
        auto_extract_glossary=False, no_dual=True,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        skip_clean=rendering,
    )
    config.progress_monitor = ProgressMonitor(TRANSLATE_STAGES)
    return config


def structure_path(folder):
    return Path(folder) / "structure" / "index.json"


def read_structure(folder, page_numbers=None):
    from babeldoc.format.pdf.document_il.il_version_1 import Document
    folder = Path(folder)
    if not structure_path(folder).exists():
        # Read sessions produced before the per-page cache format was introduced.
        docs = decode_structure(Document, json.loads((folder / "structure.json").read_text(encoding="utf-8")))
        if page_numbers is not None:
            docs.page = [p for p in docs.page if p.page_number + 1 in page_numbers]
        return docs
    index = json.loads(structure_path(folder).read_text(encoding="utf-8"))
    pages = []
    for number in index["pages"]:
        if page_numbers is not None and number not in page_numbers:
            continue
        with gzip.open(folder / "structure" / f"{number}.json.gz", "rt", encoding="utf-8") as stream:
            pages.extend(decode_structure(Document, json.load(stream)).page)
    return Document(page=pages, total_pages=index["total_pages"])


def save_structure(folder, docs):
    from babeldoc.format.pdf.document_il.il_version_1 import Document
    from babeldoc.format.pdf.document_il.xml_converter import XMLConverter
    staging = Path(folder) / f"structure-{uuid.uuid4().hex}.tmp"
    staging.mkdir()
    converter = XMLConverter()
    try:
        for page in docs.page:
            value = converter.to_json(Document(page=[page], total_pages=docs.total_pages))
            with gzip.open(staging / f"{page.page_number + 1}.json.gz", "wt", encoding="utf-8", compresslevel=4) as stream:
                stream.write(value)
        atomic_json(staging / "index.json", {"total_pages": docs.total_pages,
                    "pages": [p.page_number + 1 for p in docs.page]})
        destination = Path(folder) / "structure"
        if destination.exists():
            shutil.rmtree(destination)
        os.replace(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)


@lru_cache(maxsize=128)
def structure_types(cls):
    return typing.get_type_hints(cls)


def decode_structure(cls, value):
    """BabelDOC's JSON uses Python field names, unlike xsdata's XML aliases."""
    if value is None:
        return None
    origin = typing.get_origin(cls)
    if origin is list:
        item_type = typing.get_args(cls)[0]
        return [decode_structure(item_type, item) for item in value]
    if origin in (typing.Union, types.UnionType):
        candidates = [t for t in typing.get_args(cls) if t is not type(None)]
        target = next((t for t in candidates if dataclasses.is_dataclass(t) and isinstance(value, dict)), candidates[0])
        return decode_structure(target, value)
    if dataclasses.is_dataclass(cls):
        hints = structure_types(cls)
        fields = {field.name for field in dataclasses.fields(cls)}
        return cls(**{name: decode_structure(hints[name], item) for name, item in value.items() if name in fields})
    return value


class PlaceholderTranslator:
    """Formatting adapter; never creates a network client or touches the cache."""
    def do_llm_translate(self, text):
        return None

    def get_formular_placeholder(self, number):
        return "{v" + str(number) + "}", r"\{\s*v\s*" + str(number) + r"\s*\}"

    def get_rich_text_left_placeholder(self, number):
        return f"<style id='{number}'>", rf"<\s*style\s*id\s*=\s*'\s*{number}\s*'\s*>"

    def get_rich_text_right_placeholder(self, number):
        return "</style>", r"<\s*\/\s*style\s*>"


def formatter(config):
    from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator
    return ILTranslator(PlaceholderTranslator(), config)


def prepare_input(engine, page, paragraph):
    from babeldoc.format.pdf.document_il.midend.il_translator import ParagraphTranslateTracker
    tracker = ParagraphTranslateTracker()
    fonts = {font.font_id: font for font in page.pdf_font}
    xfonts = {x.xobj_id: {**fonts, **{f.font_id: f for f in x.pdf_font}} for x in page.pdf_xobject}
    text, inp = engine.pre_translate_paragraph(paragraph, tracker, fonts, xfonts)
    return text, inp, tracker


def display_box(page, paragraph):
    """IL bottom-left coordinates -> normalized unrotated page coordinates."""
    box = paragraph.box
    crop = page.cropbox.box
    width, height = crop.x2 - crop.x, crop.y2 - crop.y
    return [max(0, (box.x - crop.x) / width), max(0, (crop.y2 - box.y2) / height),
            min(1, (box.x2 - crop.x) / width), min(1, (crop.y2 - box.y) / height)]


def parse_session(job, emit):
    import pymupdf
    import babeldoc.format.pdf.high_level as hl
    from babeldoc.docvision.doclayout import DocLayoutModel
    from babeldoc.format.pdf.document_il.midend.layout_parser import LayoutParser
    from babeldoc.format.pdf.document_il.midend.paragraph_finder import ParagraphFinder
    from babeldoc.format.pdf.document_il.midend.styles_and_formulas import StylesAndFormulas

    folder = Path(job["session_dir"])
    state = load_state(folder)
    if state["parse_status"] == "ready" and parse_cache_ready(folder):
        emit("session", session=state)
        return
    emit("progress", stage="Parsing PDF structure", stage_id="pt-stage-parse-structure", overall=5)
    hl.init()
    model = DocLayoutModel.load_onnx()
    config = make_config(folder, job, model)
    getattr(model, "init_font_mapper", lambda _: None)(config)
    source = folder / "source.pdf"
    pdf = hl.open_pdf_with_save_fallback(folder / "original.pdf", source)
    try:
        # The native parser reports inverted crop boxes for rotated pages.
        # Normalize the private working copy; export restores each source page's
        # rotation after rendering. The original snapshot remains untouched.
        for source_page in pdf:
            source_page.set_rotation(0)
        hl.fix_null_page_content(pdf)
        hl.fix_filter(pdf)
        hl.fix_null_xref(pdf)
        media = hl.fix_media_box(pdf)
        pdf = hl.save_pdf_with_same_path_fallback(pdf, source)
        try:
            from babeldoc.format.pdf.new_parser.native_parse import parse_prepared_pdf_with_new_parser_to_legacy_ir
        except ImportError as error:
            raise RuntimeError("The BabelDOC parser interface is incompatible. Repair the environment in the settings.") from error
        docs = parse_prepared_pdf_with_new_parser_to_legacy_ir(source, config=config, doc_pdf=pdf)
        emit("progress", stage="Detecting text, tables and figures", stage_id="pt-stage-detect-layout", overall=35)
        docs = LayoutParser(config).process(docs, pdf)
        emit("progress", stage="Grouping paragraphs and preserving formulas", stage_id="pt-stage-prepare-paragraphs", overall=65)
        ParagraphFinder(config).process(docs)
        StylesAndFormulas(config).process(docs)
        engine = formatter(config)
        records = []
        section = ""
        excluded = False
        for page in docs.page:
            for ordinal, paragraph in enumerate(page.pdf_paragraph):
                if not paragraph.unicode or not paragraph.box:
                    continue
                text, inp, _ = prepare_input(engine, page, paragraph)
                label = paragraph.layout_label or "text"
                if label == "title":
                    section = paragraph.unicode
                    if re.match(r"^\s*(?:\d+[.\s]+)?(?:appendix|appendices|references|bibliography|supplementary)\b", section, re.I):
                        excluded = True
                identifier = f"p{page.page_number + 1}-b{ordinal}-{hashlib.sha256(paragraph.unicode.encode()).hexdigest()[:8]}"
                paragraph.debug_id = identifier
                translatable = bool(text and inp and re.search(r"[^\W\d_]", paragraph.unicode, re.UNICODE))
                records.append({"id": identifier, "page": page.page_number + 1,
                                "text": paragraph.unicode, "input": text or "",
                                "box": display_box(page, paragraph), "kind": label,
                                "section": section, "suggested": translatable and not excluded,
                                "translatable": translatable, "status": "pending",
                                "translation": "", "error": "", "attempts": 0})
        if not records:
            raise ValueError("No selectable text paragraphs were found. Scanned PDFs require OCR first.")
        # Materialize lazy drawing instructions through BabelDOC's serializer.
        save_structure(folder, docs)
        atomic_json(folder / "mediabox.json", media)
        # Paragraph boxes refer to normalized, unrotated source coordinates.
        # The reader document maps these back to the visible original pages.
        with pymupdf.open(source) as normalized_pdf:
            for index, page in enumerate(normalized_pdf):
                page.set_rotation(0)
                state["pages"][index].update(width=page.rect.width, height=page.rect.height)
        carry_over_translations(state, records)
        state.update(parse_status="ready", paragraphs=records,
                     document_title=next((p["text"] for p in records if p["kind"] == "title"), state["name"]))
        save_state(folder, state)
        emit("session", session=state)
        publish(folder, state, job, emit)
    finally:
        pdf.close()
        clear_scratch(folder)


TRANSLATION_FIELDS = ("translation", "history", "usage", "translated_at", "model", "attempts")


def carry_over_translations(state, records):
    """Keep paid-for translations when an expired cache is parsed again.

    The same BabelDOC version yields the same paragraph ids. After an upgrade
    ids may shift, so fall back to matching the page and source text.
    """
    previous = [p for p in state.get("paragraphs", []) if p.get("translation")]
    by_id = {p["id"]: p for p in previous}
    by_text = {(p["page"], p["text"]): p for p in previous}
    used = set()
    for record in records:
        old = by_id.get(record["id"]) or by_text.get((record["page"], record["text"]))
        if not old or old["id"] in used:
            continue
        used.add(old["id"])
        if old["input"] == record["input"]:
            record.update({key: old[key] for key in TRANSLATION_FIELDS if key in old}, status="done")
        else:
            # Placeholders differ, so the old text cannot be typeset here.
            # Offer it as history instead of losing it.
            record["history"] = (old.get("history", []) + [
                {"translation": old["translation"], "at": old.get("translated_at")}])[-5:]
    orphans = [p for p in previous if p["id"] not in used]
    if orphans:
        state.setdefault("orphaned_translations", []).extend(
            {key: p.get(key) for key in ("page", "text", "translation", "translated_at")} for p in orphans)


def apply_results(docs, state, config, *, blank_pending):
    engine = formatter(config)
    results = {p["id"]: p for p in state["paragraphs"]}
    for page in docs.page:
        for paragraph in page.pdf_paragraph:
            record = results.get(paragraph.debug_id)
            if record and record.get("translation"):
                _, inp, tracker = prepare_input(engine, page, paragraph)
                if inp:
                    text = validate_translation(record["translation"], record["input"])
                    engine.post_translate_paragraph(paragraph, tracker, inp, text)
            # Only blank text still awaiting translation. Numbers, short labels
            # and vertical text are never translatable and keep the source.
            elif blank_pending and record and record["translatable"]:
                paragraph.unicode = ""
                paragraph.pdf_paragraph_composition = []
    return docs


def render_pdf(folder, state, job, *, pages=None, blank_pending=False):
    """Typeset the given page numbers for the reader, or every page for export."""
    import babeldoc.format.pdf.high_level as hl
    from babeldoc.format.pdf.document_il.midend.typesetting import Typesetting
    from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater

    hl.init()
    config = make_config(folder, job, rendering=pages is not None)
    docs = read_structure(folder, pages)
    apply_results(docs, state, config, blank_pending=blank_pending)
    Typesetting(config).typesetting_document(docs)
    media = {} if pages is not None else {int(k): v for k, v in json.loads((folder / "mediabox.json").read_text()).items()}
    config.no_dual = True
    config.no_mono = False
    creator = PDFCreater(folder / "source.pdf", docs, config, media)
    result = creator.write(config)
    if pages is None:
        finish_export(folder, job, result, creator, config)
    return result


def finish_export(folder, job, result, creator, config):
    import pymupdf
    from babeldoc.format.pdf.high_level import safe_save

    mono_path = Path(result.mono_pdf_path)
    # Preserve the user's original crop/rotation on exported pages, and use
    # the untouched original snapshot for the left side of a bilingual PDF.
    with pymupdf.open(folder / "original.pdf") as original:
        with pymupdf.open(mono_path) as translated:
            rotated = False
            for index, page in enumerate(translated):
                rotation = original[index].rotation
                if page.rotation != rotation:
                    page.set_rotation(rotation)
                    rotated = True
            if rotated:
                temp = mono_path.with_suffix(".rotated.pdf")
                safe_save(translated, temp)
        if rotated:
            os.replace(temp, mono_path)
        if job.get("output", "dual") != "mono":
            dual_path = mono_path.with_name(mono_path.name.replace(".mono.pdf", ".dual.pdf"))
            with pymupdf.open(mono_path) as translated:
                dual = creator.create_side_by_side_dual_pdf(original, translated, dual_path, config)
                try:
                    safe_save(dual, dual_path)
                finally:
                    dual.close()
            result.dual_pdf_path = dual_path
            result.no_watermark_dual_pdf_path = dual_path
        if job.get("output") == "dual":
            result.mono_pdf_path = None


def parse_cache_ready(folder):
    """The parse result needed to typeset pages is still on disk.

    The plugin deletes it after a week unused; translations in session.json
    are kept and survive the next parse.
    """
    folder = Path(folder)
    return ((structure_path(folder).exists() or (folder / "structure.json").exists())
            and (folder / "source.pdf").exists() and (folder / "mediabox.json").exists())


def page_translation_fingerprint(state, number):
    values = [(p["id"], p.get("translation", "")) for p in state["paragraphs"] if p["page"] == number]
    return hashlib.sha256(json.dumps(values, ensure_ascii=False).encode()).hexdigest()


def stale_pages(state):
    """Translated pages that the dual PDF shows out of date, or not at all."""
    drawn = (state.get("reader_document") or {}).get("pages", {})
    translated = {p["page"] for p in state["paragraphs"] if p.get("translation")}
    return {n for n in translated if drawn.get(str(n)) != page_translation_fingerprint(state, n)}


def reader_base(state, job):
    """The dual PDF Zotero already shows, when it is the one recorded here.

    The plugin passes the attachment's path and the generation it last copied
    there. Generations travel as strings: JavaScript numbers would round them.
    """
    reader = state.get("reader_document") or {}
    path = job.get("reader_base")
    if not path or "generation" not in reader or job.get("reader_generation") != str(reader["generation"]):
        return None
    return Path(path) if Path(path).is_file() else None


def native_paragraph_rect(record, page_info, original_page):
    """Map normalized, upright IL coordinates to the visible native PDF page."""
    import pymupdf
    box = record["box"]
    crop = original_page.cropbox
    rect = pymupdf.Rect(box[0] * page_info["width"] - crop.x0,
                        box[1] * page_info["height"] - crop.y0,
                        box[2] * page_info["width"] - crop.x0,
                        box[3] * page_info["height"] - crop.y0)
    rect = rect * original_page.rotation_matrix
    rect &= original_page.rect
    height = original_page.rect.height
    return [rect.x0, height - rect.y1, rect.x1, height - rect.y0]


def reader_geometry(original, state):
    """Where each paragraph sits on the side-by-side pages, for hover and menus."""
    geometry = []
    for index, source in enumerate(original):
        number = index + 1
        width, height = source.rect.width, source.rect.height
        paragraphs = []
        if state.get("parse_status") == "ready":
            for record in state["paragraphs"]:
                if record["page"] != number or not record["translatable"]:
                    continue
                rect = native_paragraph_rect(record, state["pages"][index], source)
                paragraphs.append({"id": record["id"], "source": rect,
                                   "target": [rect[0] + width, rect[1], rect[2] + width, rect[3]]})
        geometry.append({"page": number, "source_width": width, "width": 2 * width,
                         "height": height, "paragraphs": paragraphs})
    return geometry


def draw_reader_page(combined, index, original, rendered):
    """Original page on the left; its typeset translation, if any, on the right."""
    import pymupdf
    source = original[index]
    width, height, angle = source.rect.width, source.rect.height, source.rotation
    crop = source.cropbox
    source.set_rotation(0)
    page = combined.new_page(pno=index, width=2 * width, height=height)
    if source.get_contents():
        page.show_pdf_page(pymupdf.Rect(0, 0, width, height), original, index,
                           rotate=-angle, keep_proportion=True)
    if rendered is not None:
        translated = rendered[index]
        translated.set_rotation(0)
        translated.set_cropbox(crop)
        if translated.get_contents():
            page.show_pdf_page(pymupdf.Rect(width, 0, 2 * width, height), rendered, index,
                               rotate=-angle, keep_proportion=True)


def publish(folder, state, job, emit, *, force=False):
    """Bring the dual PDF in Zotero up to date, drawing only pages that changed.

    The attachment itself is the store of finished pages, so nothing else is
    kept between runs. Without a matching attachment (first open, deleted, or
    force) every translated page is drawn into a fresh document.
    """
    import pymupdf
    folder = Path(folder)
    base = None if force else reader_base(state, job)
    pages = stale_pages(state) if base else {p["page"] for p in state["paragraphs"] if p.get("translation")}
    if state.get("parse_status") != "ready" or not parse_cache_ready(folder):
        pages = set()  # Drawn once the expired parse result is rebuilt.
    reader = state.get("reader_document") or {}
    with pymupdf.open(folder / "original.pdf") as original:
        geometry = reader_geometry(original, state)
        if base and not pages:
            # The attachment is already current; only the paragraph map may
            # have changed, e.g. after a new parse.
            reader["geometry"] = geometry
            state["reader_document"] = reader
            save_state(folder, state)
            emit("reader_document", path=None, generation=str(reader["generation"]), geometry=geometry)
            return
        rendered = None
        try:
            if pages:
                emit("progress", stage="Typesetting translation", stage_id="pt-stage-typeset", overall=95)
                rendered = pymupdf.open(render_pdf(folder, state, job, pages=pages, blank_pending=True).mono_pdf_path)
            combined = pymupdf.open(base) if base else pymupdf.open()
            try:
                for index in range(len(original)):
                    if base and index + 1 not in pages:
                        continue
                    if base:
                        combined.delete_page(index)
                    draw_reader_page(combined, index, original,
                                     rendered if index + 1 in pages else None)
                toc = original.get_toc()
                if toc:
                    combined.set_toc(toc)
                combined.subset_fonts()
                generation = time.time_ns()
                filename = f"reader-{generation}.pdf"
                combined.save(folder / filename, garbage=3, deflate=True)
            finally:
                combined.close()
        finally:
            if rendered is not None:
                rendered.close()
            clear_scratch(folder)
    drawn = dict(reader.get("pages", {})) if base else {}
    drawn.update({str(n): page_translation_fingerprint(state, n) for n in pages})
    state["reader_document"] = {"generation": generation, "geometry": geometry, "pages": drawn}
    save_state(folder, state)
    # The plugin copies this file into the attachment, then deletes it.
    emit("reader_document", path=str(folder / filename), generation=str(generation), geometry=geometry)


def clear_scratch(folder):
    """BabelDOC's typesetting output and working files are only needed mid-run."""
    for name in ("output", "working"):
        shutil.rmtree(Path(folder) / name, ignore_errors=True)


def clear_leftovers(folder, state):
    """Remove files an interrupted or older run left behind."""
    folder = Path(folder)
    clear_scratch(folder)
    current = f"reader-{(state.get('reader_document') or {}).get('generation')}.pdf"
    for path in list(folder.glob("translation-*.pdf")) + list(folder.glob("reader-*.pdf")):
        if path.name != current:
            path.unlink(missing_ok=True)


def translate_selection(job, emit):
    import openai
    folder = Path(job["session_dir"])
    state = load_state(folder)
    if state["parse_status"] != "ready":
        raise ValueError("Parse the PDF structure before translating.")
    identifiers = set(job.get("ids") or [])
    records = [p for p in state["paragraphs"] if p["id"] in identifiers and p["translatable"]]
    if not records:
        raise ValueError("Select at least one translatable paragraph.")
    cancel_name = job.get("cancel_file", "cancel")
    if not re.fullmatch(r"cancel(?:-[a-zA-Z0-9]+)?", cancel_name):
        raise ValueError("Invalid cancellation task identifier.")
    cancel_path = folder / cancel_name
    if not job.get("cancel_file"):
        cancel_path.unlink(missing_ok=True)
    cancelled = cancel_path.exists
    job = {**job, "document_title": state.get("document_title", "")}
    for record in records:
        record.update(status="queued", error="")
    save_state(folder, state)
    lock = threading.Lock()
    # Shared, so a field one worker finds rejected is fixed for all of them
    options = RequestOptions(job, on_adjust=lambda **fields: emit("request_options", **fields))
    workers = max(1, min(int(job.get("qps") or 4), 16))
    limiter = threading.Lock()
    next_start = [0.0]

    def work(record):
        if cancelled():
            return
        with limiter:
            delay = max(0, next_start[0] - time.monotonic())
            if delay:
                time.sleep(delay)
            next_start[0] = time.monotonic() + 1 / workers
        if cancelled():
            return
        with lock:
            record.update(status="running", attempts=record.get("attempts", 0) + 1)
            save_state(folder, state)
            emit("paragraph", paragraph=copy.deepcopy(record))
        try:
            with openai.OpenAI(base_url=job["base_url"], api_key=job["api_key"], timeout=90, max_retries=0) as client:
                messages = paragraph_messages(record, state["paragraphs"], job, job.get("instruction", ""))
                translated, usage = request_translation(
                    client, job, messages, options=options, source=record["input"], cancelled=cancelled,
                    on_retry=lambda attempt, error: emit("retry", id=record["id"], attempt=attempt, message=error),
                )
            with lock:
                history = record.setdefault("history", [])
                if record.get("translation"):
                    history.append({"translation": record["translation"], "at": record.get("translated_at")})
                    del history[:-5]
                record.update(status="done", translation=translated, error="", usage=usage,
                              translated_at=time.time(), model=job["model"])
        except InterruptedError:
            with lock:
                record.update(status="done" if record.get("translation") else "pending", error="Translation was cancelled and can be resumed.")
        except Exception as error:
            with lock:
                # A failed retry never overwrites the previous valid translation.
                record.update(status="failed", error=str(error)[:1500])
        with lock:
            state["revision"] += 1
            save_state(folder, state)
            emit("paragraph", paragraph=copy.deepcopy(record))

    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(work, record) for record in records]
            for future in as_completed(futures):
                future.result()
        # Persist paragraph progress immediately, but publish a PDF only after
        # the entire selection finishes (or stops). Native PDF reload replaces
        # its views, so publishing intermediate paragraphs interrupts reading.
        publish_or_report(folder, state, job, emit)
    finally:
        for record in records:
            if record["status"] in ("running", "queued"):
                record["status"] = "done" if record.get("translation") else "pending"
        save_state(folder, state)
        cancel_path.unlink(missing_ok=True)
    emit("session", session=state)


def edit_paragraph(job, emit):
    folder = Path(job["session_dir"])
    state = load_state(folder)
    record = next(p for p in state["paragraphs"] if p["id"] == job["id"])
    text = validate_translation(job.get("text"), record["input"])
    if record.get("translation"):
        record.setdefault("history", []).append({"translation": record["translation"], "at": record.get("translated_at")})
        del record["history"][:-5]
    record.update(translation=text, status="done", error="", translated_at=time.time(), model="manual")
    state["revision"] += 1
    save_state(folder, state)
    emit("paragraph", paragraph=record)
    publish_or_report(folder, state, job, emit)
    emit("session", session=state)


def publish_or_report(folder, state, job, emit):
    """Publish changed pages; a typesetting failure leaves translations intact."""
    pages = stale_pages(state)
    if not pages:
        return
    try:
        publish(folder, state, job, emit)
    except Exception as error:
        for number in sorted(pages):
            emit("preview_error", page=number, message=str(error))


def export_session(job, emit):
    folder = Path(job["session_dir"])
    state = load_state(folder)
    if not any(p.get("translation") for p in state["paragraphs"]):
        raise ValueError("There is no valid translation to export yet.")
    emit("progress", stage="Typesetting and exporting PDF", stage_id="pt-stage-export", overall=10)
    result = render_pdf(folder, state, job, blank_pending=job.get("untranslated") == "blank")
    emit("export", mono=str(result.mono_pdf_path) if result.mono_pdf_path else None,
         dual=str(result.dual_pdf_path) if result.dual_pdf_path else None)


def restore_reader(job, emit):
    folder = Path(job["session_dir"])
    state = load_state(folder)
    if job.get("force_reader") or not reader_base(state, job) or stale_pages(state):
        publish(folder, state, job, emit, force=bool(job.get("force_reader")))


def run(command, job, emit):
    from filelock import FileLock, Timeout
    folder = Path(job["session_dir"])
    folder.mkdir(parents=True, exist_ok=True)
    operations = {"session-open": open_session, "session-parse": parse_session,
                  "session-translate": translate_selection, "session-edit": edit_paragraph,
                  "session-export": export_session, "session-reader": restore_reader}
    if command not in operations:
        raise ValueError("Unknown text translation operation.")
    try:
        with FileLock(str(folder / "session.lock"), timeout=0):
            if (folder / "session.json").exists():
                clear_leftovers(folder, load_state(folder))
            operations[command](job, emit)
    except Timeout as error:
        raise ValueError("Another task for this document is still running. Try again later.") from error
    emit("done")
