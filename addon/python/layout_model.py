"""Keep the layout model loaded and run it on the chosen device.

Devices: "cpu"; "coreml" (Apple Silicon); "cuda" (NVIDIA, needs the GPU
runtime from gpu_runtime.py); "auto", the best of these that is already
available. Nothing here downloads anything.
"""

import logging
from functools import lru_cache

logger = logging.getLogger(__name__)
PROVIDER_DEVICES = {"CUDAExecutionProvider": "cuda", "CoreMLExecutionProvider": "coreml"}


def model_info(model):
    provider = model.model.get_providers()[0]
    return {"provider": provider, "device": PROVIDER_DEVICES.get(provider, "cpu")}


@lru_cache(maxsize=1)
def load_model(device="auto"):
    from gpu_runtime import activate
    activate(device)
    import onnxruntime as ort
    from babeldoc.docvision.doclayout import DocLayoutModel

    # BabelDOC picks Core ML on Apple Silicon and the CPU everywhere else
    model = DocLayoutModel.load_onnx()
    cuda = device in {"auto", "cuda"} and "CUDAExecutionProvider" in ort.get_available_providers()
    if device == "cpu" and model_info(model)["device"] != "cpu":
        model.model.set_providers(["CPUExecutionProvider"])
    elif cuda:
        try:
            ort.preload_dlls()
            model.model.set_providers([("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                                       "CPUExecutionProvider"])
            if "CUDAExecutionProvider" not in model.model.get_providers():
                raise RuntimeError("CUDA initialization failed.")
        except Exception as error:  # noqa: BLE001 - GPU library errors must allow CPU fallback
            logger.warning("Could not initialize CUDA; using CPU: %s", error)
            model.model.set_providers(["CPUExecutionProvider"])
    elif device == "cuda":
        logger.warning("The GPU runtime is not installed; using the default provider.")

    predict = model.predict

    def predict_with_fallback(*args, **kwargs):
        try:
            return predict(*args, **kwargs)
        except Exception as error:
            if model_info(model)["device"] == "cpu":
                raise
            logger.warning("Accelerated inference failed; retrying on CPU: %s", error)
            model.model.set_providers(["CPUExecutionProvider"])
            return predict(*args, **kwargs)

    model.predict = predict_with_fallback
    return model
