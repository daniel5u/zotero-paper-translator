"""Bridge between the Zotero plugin and BabelDOC.

Usage:
    python runner.py check      print versions and exit
    python runner.py warmup     download BabelDOC models, fonts and cmaps
    python runner.py ping       read a JSON job from stdin and test the API settings
    python runner.py session-* read a JSON job from stdin and run a text translation task

Every message meant for the plugin is one line on stdout prefixed with
PROTOCOL_PREFIX and followed by a JSON object. Anything else on stdout or
stderr is log output, which the plugin keeps for error reports.
"""

import json
import multiprocessing as mp
import os
import sys
import threading
import traceback

PROTOCOL_PREFIX = "@@PT "

# Libraries print to stdout freely; keep a private handle to the real stdout
# for protocol messages and send everything else to stderr.
_protocol_out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
_protocol_lock = threading.Lock()
os.dup2(2, 1)
sys.stdout = sys.stderr


def emit(message_type, **fields):
    with _protocol_lock:
        _protocol_out.write(
            PROTOCOL_PREFIX + json.dumps({"type": message_type, **fields}, ensure_ascii=False) + "\n"
        )
        _protocol_out.flush()


def check():
    import babeldoc

    emit("check", python=sys.version.split()[0], babeldoc=babeldoc.__version__)


def warmup():
    import babeldoc.assets.assets
    import babeldoc.format.pdf.high_level

    babeldoc.format.pdf.high_level.init()
    babeldoc.assets.assets.warmup()
    emit("done")


class ApiCheckError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def ping(job):
    """Validate the API settings with a short request."""
    import openai

    try:
        from translation import request_translation
        with openai.OpenAI(base_url=job["base_url"], api_key=job["api_key"], timeout=60, max_retries=0) as client:
            request_translation(client, job, [{"role": "user", "content": "Translate to Chinese: Hello"}])
    except openai.AuthenticationError as e:
        raise ApiCheckError("auth", str(e)) from e
    except openai.NotFoundError as e:
        raise ApiCheckError("not_found", str(e)) from e
    except openai.APIConnectionError as e:
        raise ApiCheckError("connection", str(e)) from e
    except openai.APIStatusError as e:
        raise ApiCheckError("api", str(e)) from e


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if command == "check":
            check()
        elif command == "warmup":
            warmup()
        elif command == "ping":
            ping(json.loads(sys.stdin.read()))
            emit("done")
        elif command.startswith("session-"):
            from text_translation import run
            run(command, json.loads(sys.stdin.read()), emit)
        else:
            emit("error", message=f"unknown command: {command!r}")
            return 2
    except ApiCheckError as e:
        emit("error", code=e.code, message=str(e))
        return 1
    except Exception as e:
        traceback.print_exc()
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1
    return 0


if __name__ == "__main__":
    mp.set_start_method("spawn" if sys.platform in ("darwin", "win32") else "forkserver")
    sys.exit(main())
