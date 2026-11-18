"""Optional CUDA dependencies, isolated from BabelDOC's CPU installation."""

import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "gpu-runtime"
LOCK = ROOT / "requirements-gpu.lock"


def lock_hash():
    return hashlib.sha256(LOCK.read_bytes()).hexdigest()


def activate(device):
    if device == "cpu" or os.environ.get("PAPER_TRANSLATOR_GPU_RUNTIME") == "0":
        return
    marker = RUNTIME / "ready.json"
    try:
        if str(RUNTIME) not in sys.path and marker.is_file() and json.loads(marker.read_text())["lock"] == lock_hash():
            sys.path.insert(0, str(RUNTIME))
    except (OSError, ValueError, KeyError):
        return


def nvidia_available():
    if sys.platform not in {"linux", "win32"} or platform.machine().lower() not in {"amd64", "x86_64"}:
        return False
    binary = shutil.which("nvidia-smi")
    if not binary:
        candidates = [Path("/usr/bin/nvidia-smi")]
        if sys.platform == "win32":
            candidates += [Path(os.environ.get("WINDIR", "C:/Windows")) / "System32/nvidia-smi.exe",
                           Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "NVIDIA Corporation/NVSMI/nvidia-smi.exe"]
        binary = next((str(path) for path in candidates if path.is_file()), None)
    if not binary:
        return False
    try:
        result = subprocess.run([binary, "--query-gpu=driver_version", "--format=csv,noheader"],
                                capture_output=True, text=True, timeout=5, check=False)
        # This optional wheel uses CUDA 13. Older drivers keep using the CPU runtime.
        return result.returncode == 0 and any(int(version.split(".")[0]) >= 580
                                             for version in result.stdout.splitlines() if re.match(r"^\d+\.", version))
    except (OSError, subprocess.TimeoutExpired):
        return False


def probe(path):
    """Run in a fresh process, before any CPU ONNX module is imported."""
    sys.path.insert(0, str(path))
    import numpy as np
    import onnx
    import onnxruntime as ort

    ort.preload_dlls()
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("The CUDA execution provider is unavailable.")
    graph = onnx.helper.make_graph(
        [onnx.helper.make_node("Relu", ["x"], ["y"])], "gpu-check",
        [onnx.helper.make_tensor_value_info("x", onnx.TensorProto.FLOAT, [2])],
        [onnx.helper.make_tensor_value_info("y", onnx.TensorProto.FLOAT, [2])],
    )
    model = onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 13)], ir_version=8)
    session = ort.InferenceSession(model.SerializeToString(), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    if "CUDAExecutionProvider" not in session.get_providers():
        raise RuntimeError("CUDA initialization failed.")
    np.testing.assert_array_equal(session.run(None, {"x": np.array([-1, 1], dtype=np.float32)})[0], [0, 1])


def check_runtime(path):
    result = subprocess.run([sys.executable, str(Path(__file__)), "probe", str(path)],
                            capture_output=True, text=True, timeout=45, check=False)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-2500:].strip())


def install_packages(command):
    """Terminate the installer too when Zotero stops GPU preparation on Unix."""
    process = subprocess.Popen(command)
    previous = signal.getsignal(signal.SIGTERM)
    def terminate(signum, frame):
        process.terminate()
    signal.signal(signal.SIGTERM, terminate)
    try:
        returncode = process.wait(timeout=600)
        if returncode:
            raise subprocess.CalledProcessError(returncode, command)
    finally:
        signal.signal(signal.SIGTERM, previous)
        if process.poll() is None:
            process.kill()
        process.wait()


def setup(uv, emit):
    if not nvidia_available():
        return {"available": False}
    marker = RUNTIME / "ready.json"
    if marker.is_file():
        try:
            if json.loads(marker.read_text())["lock"] == lock_hash():
                check_runtime(RUNTIME)
                return {"available": True}
        except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired):
            pass
    emit("progress", stage_id="pt-stage-prepare-gpu")
    try:
        with tempfile.TemporaryDirectory(prefix="gpu-install-", dir=ROOT) as temporary:
            staging = Path(temporary)
            package = re.search(r"^onnxruntime-gpu==[^\s;]+", LOCK.read_text(), re.MULTILINE)[0]
            command = [uv, "pip", "install", "--python", sys.executable, "--target", str(staging), "--no-deps"]
            # Existing system CUDA libraries can avoid downloading the larger runtime extras.
            install_packages([*command, package])
            try:
                check_runtime(staging)
            except (RuntimeError, subprocess.TimeoutExpired):
                install_packages([*command, "-r", str(LOCK)])
                check_runtime(staging)
            (staging / "ready.json").write_text(json.dumps({"lock": lock_hash()}))
            backup = ROOT / "gpu-runtime.old"
            shutil.rmtree(backup, ignore_errors=True)
            if RUNTIME.exists():
                RUNTIME.rename(backup)
            try:
                staging.rename(RUNTIME)
            except OSError:
                if backup.exists():
                    backup.rename(RUNTIME)
                raise
            shutil.rmtree(backup, ignore_errors=True)
        return {"available": True}
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"GPU runtime setup failed; using CPU: {error}", file=sys.stderr)
        return {"available": False, "warning": str(error)}


if __name__ == "__main__":
    probe(Path(sys.argv[2]))
