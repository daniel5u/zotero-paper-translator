"""Keep the layout model warm and choose a tested acceleration provider."""

import logging
from functools import lru_cache

logger = logging.getLogger(__name__)


def model_info(model):
    provider = model.model.get_providers()[0]
    return {"provider": provider, "device": "cpu" if provider == "CPUExecutionProvider" else "gpu"}


@lru_cache(maxsize=1)
def load_model(device="auto"):
    from gpu_runtime import activate
    activate(device)
    import onnxruntime as ort
    from babeldoc.docvision.doclayout import DocLayoutModel

    if device != "cpu" and "CUDAExecutionProvider" in ort.get_available_providers():
        ort.preload_dlls()
    model = DocLayoutModel.load_onnx()
    if device == "cpu" and model_info(model)["device"] != "cpu":
        model.model.set_providers(["CPUExecutionProvider"])
    elif device != "cpu" and "CUDAExecutionProvider" in ort.get_available_providers():
        try:
            model.model.set_providers([("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}),
                                       "CPUExecutionProvider"])
            if "CUDAExecutionProvider" not in model.model.get_providers():
                raise RuntimeError("CUDA initialization failed.")
        except Exception as error:  # noqa: BLE001 - GPU library errors must allow CPU fallback
            logger.warning("Could not initialize CUDA; using CPU: %s", error)
            model.model.set_providers(["CPUExecutionProvider"])

    predict = model.predict

    def predict_with_fallback(*args, **kwargs):
        try:
            return predict(*args, **kwargs)
        except Exception as error:
            if model_info(model)["device"] == "cpu":
                raise
            logger.warning("GPU inference failed; retrying on CPU: %s", error)
            model.model.set_providers(["CPUExecutionProvider"])
            return predict(*args, **kwargs)

    model.predict = predict_with_fallback
    return model


def prepare(device):
    from gpu_runtime import activate
    activate(device)
    # Imports are retained in the worker for parsing and subsequent typesetting.
    import babeldoc.format.pdf.document_il.backend.pdf_creater
    import babeldoc.format.pdf.document_il.midend.layout_parser
    import babeldoc.format.pdf.document_il.midend.paragraph_finder
    import babeldoc.format.pdf.document_il.midend.styles_and_formulas
    import babeldoc.format.pdf.document_il.midend.typesetting
    import babeldoc.format.pdf.high_level
    import babeldoc.format.pdf.new_parser.native_parse  # noqa: F401 - preload the parser
    import numpy as np

    model = load_model(device)
    if not getattr(model, "_pt_prepared", False):
        model.predict(np.zeros((1024, 1024, 3), dtype=np.uint8))
        model._pt_prepared = True
    return model_info(model)
