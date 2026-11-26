# MarkItDown Web (Client-Side Pyodide)

A 100% client-side, zero-build static web application that runs Microsoft's [`markitdown`](https://www.google.com/search?q=https%3A%2F%2Fgithub.com%2Fmicrosoft%2Fmarkitdown) Python library directly inside the browser using [Pyodide](https://www.google.com/search?q=https%3A%2F%2Fwww.google.com%2Fsearch%3Fq%3Dhttps%253A%252F%252Fpyodide.org%252F) (WebAssembly). Files are converted locally in memory—no backend server is required, and documents never leave your device.

## Architecture Overview

| File | Responsibility | 
| ----- | ----- | 
| `index.html` | Static UI layout, theme bootstrap, and pinned CDN imports (`marked@18.3.0`, `dompurify@3.4.18`, `jszip@3.10.2`). | 
| `styles.css` | Zero-dependency dark/light theme system, custom scrollbars, responsive split-pane workspace, and rendered Markdown typography. | 
| `app.js` | Main-thread ES module controller handling drag-and-drop uploads, sequential batch queue, editable raw Markdown with live line/word/character stats, sanitized HTML preview, ZIP export, and Vision LLM settings (`localStorage`). | 
| `worker.js` | Dedicated Web Worker running Pyodide `v0.27.4` off the main thread so Python initialization and PDF/Office parsing never block the UI. | 

### Key Pyodide + `markitdown` Workarounds

1. **Pure-Python Dependency Installation (`deps=False`)**: Standard `micropip.install("markitdown")` fails in WebAssembly because `magika` depends on native `onnxruntime`. Instead, `worker.js` loads Pyodide's pre-built WASM packages (`micropip`, `lxml`, `pillow`, `pandas`), installs the pure-Python parsers (`beautifulsoup4`, `markdownify`, `pdfminer.six`, `python-docx`, `python-pptx`, `openpyxl`, `mammoth`, `charset-normalizer`, `defusedxml`, `requests`), and then installs `markitdown` with `deps=False`.

2. **`magika` Compatibility Shim**: Before importing `markitdown`, `worker.js` registers a lightweight `magika` module in `sys.modules` implementing `Magika().identify_stream(...)` (compatible with both `result.output` and `result.prediction.output`). Returning `label="unknown"` lets `markitdown` fall back cleanly to file extensions via `StreamInfo(extension=...)`.

3. **In-Memory Virtual Filesystem Cleanup**: Uploaded `ArrayBuffer` payloads are transferred to the worker with zero-copy transferables, written to `/tmp/<unique>_<filename>`, converted via `md.convert(tmp_path)`, and removed inside a `finally:` block to prevent memory leaks.

4. **Optional Browser-Side Vision LLM**: When an OpenAI-compatible API key is configured in the **Vision LLM** modal, `worker.js` installs `openai` on demand and routes requests through a synchronous `XMLHttpRequest` transport (valid inside Web Workers) with a lightweight fallback client if native wheels are unavailable.

## Supported Browser Formats

| Category | Extensions | 
| ----- | ----- | 
| Documents & Presentations | `.pdf`, `.docx`, `.pptx`, `.xlsx` | 
| Web & Structured Text | `.html`, `.htm`, `.csv`, `.json`, `.xml`, `.txt`, `.md` | 
| Images (EXIF + Optional Vision LLM) | `.png`, `.jpg`, `.jpeg`, `.webp` | 

> **Unsupported Formats:** Audio and video files (`.mp3`, `.mp4`, `.wav`, etc.) require native OS binaries (`ffmpeg`) and are gracefully rejected with an explanatory message.

## Local Development

Because browsers restrict Web Workers and ES modules over `file://`, serve the directory with any static HTTP server:

```
python3 -m http.server 8000

```

Then open `http://localhost:8000` in your browser.

## Deploying to GitHub Pages

1. Create a new GitHub repository and push `index.html`, `styles.css`, `app.js`, `worker.js`, and `README.md` to the `main` branch.

2. In your repository, go to **Settings → Pages**.

3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.

4. Select the `main` branch and `/ (root)` folder, then click **Save**.

5. Wait \~1 minute for GitHub Pages to publish your site at `https://<your-username>.github.io/<repo-name>/`.

6. Update the GitHub repository link in `index.html` to point to your repository URL.