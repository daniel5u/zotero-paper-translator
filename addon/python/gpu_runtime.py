"""Hardware detection and the optional GPU runtime.

The GPU runtime is onnxruntime-gpu plus NVIDIA's CUDA/cuDNN wheels. It shares
the import name `onnxruntime` with the CPU build in the venv, so it lives in
its own folder that is put first on sys.path when wanted. It is only ever
installed when the user asks for it.
"""

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
# The optional wheels are built for CUDA 13, which needs this driver or newer
MIN_DRIVER = 580
DEVICES = {"auto", "coreml", "cuda", "cpu"}


def lock_hash():
    return hashlib.sha256(LOCK.read_bytes()).hexdigest()


def runtime_ready():
    try:
        return json.loads((RUNTIME / "ready.json").read_text())["lock"] == lock_hash()
    except (OSError, ValueError, KeyError):
        return False


def activate(device):
    """Put the GPU build of onnxruntime first, before anything imports it."""
    if device in {"auto", "cuda"} and str(RUNTIME) not in sys.path and runtime_ready():
        sys.path.insert(0, str(RUNTIME))


def cpu_name():
    try:
        if sys.platform == "darwin":
            return subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True,
                                  text=True, timeout=5, check=False).stdout.strip() or platform.machine()
        if sys.platform.startswith("linux"):
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
        if sys.platform == "win32":
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return platform.processor() or platform.machine()


def nvidia_smi():
    binary = shutil.which("nvidia-smi")
    if not binary:
        candidates = [Path("/usr/bin/nvidia-smi")]
        if sys.platform == "win32":
            candidates += [Path(os.environ.get("WINDIR", "C:/Windows")) / "System32/nvidia-smi.exe",
                           Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "NVIDIA Corporation/NVSMI/nvidia-smi.exe"]
        binary = next((str(path) for path in candidates if path.is_file()), None)
    return binary


def nvidia_gpu():
    """The first NVIDIA GPU, or None. Only x86-64 Windows and Linux have wheels."""
    if sys.platform not in {"linux", "win32"} or platform.machine().lower() not in {"amd64", "x86_64"}:
        return None
    binary = nvidia_smi()
    if not binary:
        return None
    try:
        result = subprocess.run([binary, "--query-gpu=name,driver_version,memory.total",
                                 "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    for line in result.stdout.splitlines() if result.returncode == 0 else []:
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 3 and re.match(r"^\d+\.", parts[1]):
            return {"name": parts[0], "driver": parts[1], "memory_mb": int(float(parts[2] or 0)),
                    "supported": int(parts[1].split(".")[0]) >= MIN_DRIVER}
    return None


def detect():
    """What this computer can accelerate with. Never installs anything."""
    info = {"os": sys.platform, "machine": platform.machine(), "cpu": cpu_name(), "accelerator": None}
    if sys.platform == "darwin":
        import onnxruntime as ort
        if platform.machine() == "arm64" and "CoreMLExecutionProvider" in ort.get_available_providers():
            info["accelerator"] = {"kind": "coreml", "name": "Apple Neural Engine"}
    else:
        gpu = nvidia_gpu()
        if gpu:
            info["accelerator"] = {"kind": "cuda", **gpu}
    info["min_driver"] = MIN_DRIVER
    return info


def folder_size(path):
    return sum(entry.stat().st_size for entry in path.rglob("*") if entry.is_file() and not entry.is_symlink())


def lock_version(name):
    match = re.search(rf"^{re.escape(name)}==([^\s;]+)", LOCK.read_text(), re.MULTILINE)
    return match[1] if match else None


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
                            capture_output=True, text=True, timeout=60, check=False)
    if result.returncode:
        lines = [line for line in (result.stderr or result.stdout).splitlines() if line.strip()]
        raise RuntimeError(lines[-1] if lines else f"GPU test exited with code {result.returncode}.")


def status():
    """Whether the GPU runtime is installed and whether it runs on this GPU."""
    info = {"installed": runtime_ready(), "path": str(RUNTIME), "onnxruntime": lock_version("onnxruntime-gpu"),
            "cudnn": lock_version("nvidia-cudnn-cu13"), "cuda": lock_version("nvidia-cuda-runtime")}
    if RUNTIME.exists():
        info["size"] = folder_size(RUNTIME)
    if info["installed"]:
        try:
            info["bundled_cuda"] = json.loads((RUNTIME / "ready.json").read_text()).get("bundled_cuda", True)
        except (OSError, ValueError):
            pass
        try:
            check_runtime(RUNTIME)
            info["working"] = True
        except (RuntimeError, subprocess.SubprocessError) as error:
            info["working"] = False
            info["error"] = str(error)
    return info


def install_packages(command):
    """Terminate the installer too when Zotero cancels on Unix."""
    process = subprocess.Popen(command)
    previous = signal.getsignal(signal.SIGTERM)

    def terminate(signum, frame):
        process.terminate()
        raise SystemExit(143)
    signal.signal(signal.SIGTERM, terminate)
    try:
        returncode = process.wait(timeout=3600)
        if returncode:
            raise subprocess.CalledProcessError(returncode, command)
    finally:
        signal.signal(signal.SIGTERM, previous)
        if process.poll() is None:
            process.kill()
        process.wait()


def install(uv, emit):
    """Download the GPU runtime into a staging folder, test it, then swap it in.

    Tries onnxruntime-gpu alone first, which is enough when the system already
    has CUDA 13 libraries; otherwise downloads NVIDIA's wheels as well.
    """
    gpu = nvidia_gpu()
    if not gpu:
        raise RuntimeError("No NVIDIA GPU was found.")
    if not gpu["supported"]:
        raise RuntimeError(f"NVIDIA driver {gpu['driver']} is too old. Version {MIN_DRIVER} or newer is needed.")
    for stale in ROOT.glob("gpu-install-*"):
        shutil.rmtree(stale, ignore_errors=True)
    with tempfile.TemporaryDirectory(prefix="gpu-install-", dir=ROOT) as temporary:
        staging = Path(temporary)
        package = re.search(r"^onnxruntime-gpu==[^\s;]+", LOCK.read_text(), re.MULTILINE)[0]
        command = [uv, "pip", "install", "--python", sys.executable, "--target", str(staging), "--no-deps"]
        emit("progress", stage_id="onnxruntime")
        install_packages([*command, package])
        emit("progress", stage_id="test")
        bundled = False
        try:
            check_runtime(staging)
        except (RuntimeError, subprocess.SubprocessError):
            bundled = True
            emit("progress", stage_id="cuda")
            install_packages([*command, "-r", str(LOCK)])
            emit("progress", stage_id="test")
            check_runtime(staging)
        (staging / "ready.json").write_text(json.dumps({"lock": lock_hash(), "bundled_cuda": bundled}))
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
    return {"bundled_cuda": bundled, "size": folder_size(RUNTIME)}


if __name__ == "__main__":
    probe(Path(sys.argv[2]))
