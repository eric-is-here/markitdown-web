/* ==========================================================================
   MarkItDown Web — Dedicated Web Worker (Pyodide + MarkItDown)
   Runs CPython in WebAssembly off the main UI thread.
   ========================================================================== */

const PYODIDE_INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.4/full/";
importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);

const UNSUPPORTED_MEDIA_EXTENSIONS = new Set([
  ".mp3",
  ".mp4",
  ".wav",
  ".m4a",
  ".ogg",
  ".flac",
  ".aac",
  ".wma",
  ".webm",
  ".avi",
  ".mov",
  ".mkv",
  ".mpeg",
  ".mpg",
]);

const MEDIA_ERROR_MESSAGE =
  "Audio/video transcription requires native system binaries (ffmpeg) and is not supported in the browser version.";

let pyodide = null;
let isReady = false;
let currentLlmConfig = null;

function postStatus(stage, message, progress) {
  self.postMessage({
    type: "status",
    stage,
    message,
    progress,
  });
}

function getFileExtension(filename) {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

/**
 * Python bootstrap code:
 * 1. Registers a `magika` compatibility shim in sys.modules matching
 *    markitdown's `from magika import Magika` and `Magika().identify_stream(...)`.
 * 2. Provides conversion helper that writes ArrayBuffer bytes to /tmp/<file>,
 *    runs MarkItDown.convert(), and deletes the temporary file in a finally block.
 * 3. Supports on-demand Vision LLM configuration via OpenAI-compatible endpoints
 *    using a Web Worker XMLHttpRequest transport so HTTP calls work inside WASM.
 */
const PYTHON_ENGINE_BOOTSTRAP = `
import base64
import json
import os
import sys
import types
import uuid

# ---------------------------------------------------------------------------
# 1. Magika Compatibility Shim
# ---------------------------------------------------------------------------
# markitdown imports: from magika import Magika
# and calls: result = self._magika.identify_stream(file_stream)
# checking: result.status == "ok" and result.prediction.output / result.output
# Returning status="ok" with label="unknown" forces clean fallback to
# StreamInfo(extension=...) without requiring onnxruntime.

class _MagikaOutput:
    def __init__(self):
        self.label = "unknown"
        self.ct_label = "unknown"
        self.mime_type = None
        self.extensions = []
        self.is_text = False
        self.group = "unknown"
        self.description = "Unknown"
        self.magic = "Unknown"

class _MagikaPrediction:
    def __init__(self):
        self.output = _MagikaOutput()
        self.score = 0.0

class _MagikaResult:
    def __init__(self):
        self.status = "ok"
        self.ok = True
        self.prediction = _MagikaPrediction()
        self.output = self.prediction.output
        self.score = 0.0

class _MagikaShim:
    def __init__(self, *args, **kwargs):
        pass

    def identify_stream(self, stream):
        # Preserve stream position as expected by markitdown invariants
        try:
            pos = stream.tell()
            stream.seek(pos)
        except Exception:
            pass
        return _MagikaResult()

    def identify_bytes(self, content):
        return _MagikaResult()

    def identify_path(self, path):
        return _MagikaResult()

_magika_module = types.ModuleType("magika")
_magika_module.Magika = _MagikaShim
sys.modules["magika"] = _magika_module

from markitdown import MarkItDown

# ---------------------------------------------------------------------------
# 2. Browser-Compatible OpenAI Vision Client (Sync XHR inside Web Worker)
# ---------------------------------------------------------------------------
def _xhr_request(method, url, headers, body_bytes):
    from js import XMLHttpRequest
    xhr = XMLHttpRequest.new()
    # Synchronous XHR is valid inside dedicated Web Workers
    xhr.open(method, url, False)
    for k, v in headers.items():
        if k.lower() not in ("host", "content-length", "user-agent", "accept-encoding", "connection"):
            xhr.setRequestHeader(k, v)
    if body_bytes is not None:
        if isinstance(body_bytes, (bytes, bytearray)):
            xhr.send(body_bytes.decode("utf-8", errors="replace"))
        else:
            xhr.send(str(body_bytes))
    else:
        xhr.send()
    return int(xhr.status), str(xhr.responseText)

class _FallbackChoiceMessage:
    def __init__(self, content):
        self.content = content

class _FallbackChoice:
    def __init__(self, content):
        self.message = _FallbackChoiceMessage(content)

class _FallbackCompletion:
    def __init__(self, content):
        self.choices = [_FallbackChoice(content)]

class _FallbackCompletionsAPI:
    def __init__(self, api_key, base_url):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")

    def create(self, model, messages, **kwargs):
        url = f"{self._base_url}/chat/completions"
        payload = {"model": model, "messages": messages}
        for key in ("max_tokens", "temperature"):
            if key in kwargs and kwargs[key] is not None:
                payload[key] = kwargs[key]
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
        }
        status, text = _xhr_request("POST", url, headers, json.dumps(payload))
        if status < 200 or status >= 300:
            raise RuntimeError(f"Vision LLM API error (HTTP {status}): {text[:300]}")
        data = json.loads(text)
        content = data["choices"][0]["message"]["content"]
        return _FallbackCompletion(content)

class _FallbackOpenAIClient:
    def __init__(self, api_key, base_url):
        self.chat = types.SimpleNamespace(
            completions=_FallbackCompletionsAPI(api_key, base_url)
        )

def _build_openai_client(api_key, base_url):
    try:
        import httpx
        from openai import OpenAI

        class _PyodideXHRTransport(httpx.BaseTransport):
            def handle_request(self, request):
                body = request.read()
                status, text = _xhr_request(
                    request.method,
                    str(request.url),
                    dict(request.headers),
                    body,
                )
                return httpx.Response(
                    status_code=status,
                    headers={"content-type": "application/json"},
                    content=text.encode("utf-8"),
                    request=request,
                )

        http_client = httpx.Client(transport=_PyodideXHRTransport())
        return OpenAI(api_key=api_key, base_url=base_url, http_client=http_client)
    except Exception:
        # Fallback if openai/jiter native wheel is unavailable in Pyodide
        return _FallbackOpenAIClient(api_key=api_key, base_url=base_url)

# ---------------------------------------------------------------------------
# 3. MarkItDown Engine Lifecycle & Conversion Helper
# ---------------------------------------------------------------------------
_md_engine = MarkItDown()

def configure_engine(api_key="", base_url="https://api.openai.com/v1", model="gpt-4o-mini"):
    global _md_engine
    api_key = (api_key or "").strip()
    base_url = (base_url or "https://api.openai.com/v1").strip()
    model = (model or "gpt-4o-mini").strip()

    if api_key:
        client = _build_openai_client(api_key, base_url)
        _md_engine = MarkItDown(llm_client=client, llm_model=model)
        return {"llm_enabled": True, "model": model}
    else:
        _md_engine = MarkItDown()
        return {"llm_enabled": False, "model": None}

def convert_uploaded_file(filename, file_bytes):
    os.makedirs("/tmp", exist_ok=True)
    safe_base = os.path.basename(filename).replace("/", "_").replace("\\\\", "_")
    unique_name = f"{uuid.uuid4().hex[:8]}_{safe_base}"
    tmp_path = os.path.join("/tmp", unique_name)

    try:
        raw_data = bytes(file_bytes.to_py()) if hasattr(file_bytes, "to_py") else bytes(file_bytes)
        with open(tmp_path, "wb") as f:
            f.write(raw_data)

        result = _md_engine.convert(tmp_path)
        markdown_text = getattr(result, "markdown", None)
        if markdown_text is None:
            markdown_text = getattr(result, "text_content", "")
        return markdown_text or ""
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass
`;

async function installOpenAIOnDemand() {
  try {
    await pyodide.runPythonAsync(`
import micropip
try:
    import openai
except ImportError:
    await micropip.install("openai")
`);
  } catch (err) {
    // Some Pyodide versions lack a WASM wheel for openai's Rust dependency (jiter).
    // The Python bootstrap gracefully falls back to _FallbackOpenAIClient.
    console.warn("Optional openai wheel install skipped; using XHR-compatible fallback:", err);
  }
}

async function applyLlmConfig(config) {
  currentLlmConfig = config || null;
  if (!pyodide || !isReady) return;

  const apiKey = (config && config.apiKey ? config.apiKey : "").trim();
  const baseUrl = (config && config.baseUrl ? config.baseUrl : "https://api.openai.com/v1").trim();
  const model = (config && config.model ? config.model : "gpt-4o-mini").trim();

  if (apiKey) {
    await installOpenAIOnDemand();
  }

  const configureFn = pyodide.globals.get("configure_engine");
  try {
    const res = configureFn(apiKey, baseUrl, model);
    const jsRes = res.toJs ? Object.fromEntries(res.toJs()) : res;
    if (res && typeof res.destroy === "function") res.destroy();
    self.postMessage({
      type: "llm_configured",
      llmEnabled: Boolean(jsRes.llm_enabled),
      model: jsRes.model || null,
    });
  } finally {
    configureFn.destroy();
  }
}

async function initializeRuntime(initialLlmConfig) {
  try {
    // Stage 1: Load WebAssembly Python runtime
    postStatus("loading_runtime", "Loading WebAssembly Python runtime...", 15);
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX_URL });

    // Load pre-built WASM packages needed by micropip and office parsers
    postStatus("installing_parsers", "Installing document parsers...", 40);
    await pyodide.loadPackage(["micropip", "lxml", "pillow", "pandas"]);

    // Stage 2: Manually install pure-Python dependencies & markitdown (deps=False)
    await pyodide.runPythonAsync(`
import micropip

await micropip.install([
    "beautifulsoup4",
    "markdownify",
    "pdfminer.six",
    "python-docx",
    "python-pptx",
    "openpyxl",
    "mammoth",
    "charset-normalizer",
    "defusedxml",
    "requests",
])
await micropip.install("markitdown", deps=False)
`);

    // Stage 3: Register magika shim and initialize MarkItDown engine
    postStatus("initializing_engine", "Initializing MarkItDown engine...", 85);
    await pyodide.runPythonAsync(PYTHON_ENGINE_BOOTSTRAP);

    isReady = true;

    if (initialLlmConfig && initialLlmConfig.apiKey && initialLlmConfig.apiKey.trim()) {
      await applyLlmConfig(initialLlmConfig);
    }

    // Stage 4: Ready
    postStatus("ready", "Ready", 100);
  } catch (err) {
    isReady = false;
    self.postMessage({
      type: "init_error",
      error: err && err.message ? err.message : String(err),
    });
  }
}

async function handleConvert({ id, filename, buffer }) {
  if (!isReady || !pyodide) {
    self.postMessage({
      type: "convert_error",
      id,
      error: "Python runtime is not ready yet.",
    });
    return;
  }

  const ext = getFileExtension(filename);
  if (UNSUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
    self.postMessage({
      type: "convert_error",
      id,
      error: MEDIA_ERROR_MESSAGE,
    });
    return;
  }

  const convertFn = pyodide.globals.get("convert_uploaded_file");
  try {
    const uint8Bytes = new Uint8Array(buffer);
    const markdown = convertFn(filename, uint8Bytes);
    self.postMessage({
      type: "convert_success",
      id,
      markdown: typeof markdown === "string" ? markdown : String(markdown || ""),
    });
  } catch (err) {
    const rawMsg = err && err.message ? err.message : String(err);
    const lower = rawMsg.toLowerCase();
    const isMediaError =
      lower.includes("ffmpeg") ||
      lower.includes("pydub") ||
      lower.includes("speech_recognition") ||
      lower.includes("audio") ||
      UNSUPPORTED_MEDIA_EXTENSIONS.has(ext);

    self.postMessage({
      type: "convert_error",
      id,
      error: isMediaError ? MEDIA_ERROR_MESSAGE : cleanPythonError(rawMsg),
    });
  } finally {
    if (convertFn && typeof convertFn.destroy === "function") {
      convertFn.destroy();
    }
  }
}

function cleanPythonError(rawMessage) {
  if (!rawMessage) return "Unknown conversion error.";
  const lines = rawMessage.trim().split("\n").filter(Boolean);
  // Return the final exception line from a Python traceback for readability
  return lines.length > 0 ? lines[lines.length - 1] : rawMessage;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "init":
      await initializeRuntime(msg.llmConfig);
      break;
    case "configure_llm":
      try {
        await applyLlmConfig(msg.llmConfig);
      } catch (err) {
        self.postMessage({
          type: "llm_error",
          error: err && err.message ? err.message : String(err),
        });
      }
      break;
    case "convert":
      await handleConvert(msg);
      break;
    default:
      break;
  }
};
