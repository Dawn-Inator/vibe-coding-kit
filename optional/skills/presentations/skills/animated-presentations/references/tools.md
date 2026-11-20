# Tool usage

Resolve scripts relative to this skill directory, not the caller’s working directory. Quote file paths. These tools do not install dependencies, authenticate, or open applications automatically. Python tools target Python 3.10+ on macOS, Linux, and Windows (use `py -3` where appropriate).

## PPTX extraction

Requires `python-pptx` in the chosen Python environment. When setup is requested, use a project/tool virtual environment, not the system Python:

```sh
python3 -m venv /path/to/slide-tools
/path/to/slide-tools/bin/python -m pip install python-pptx playwright
/path/to/slide-tools/bin/python -m playwright install chromium
```

On Windows use the environment’s `Scripts/python.exe`. Install only the dependencies needed for the operation: PPTX extraction needs `python-pptx`; PDF export needs `playwright` and Chromium. HTML authoring/viewing needs neither.

```sh
python3 /path/to/skill/scripts/extract-pptx.py input.pptx new-output-folder
```

Choose a new output folder so extracted files do not overwrite earlier work. Outputs are `extracted-slides.json` and `assets/`. The extractor handles top-level text frames, pictures, and notes. It does not preserve original layout, charts, tables, grouped shapes, animations, video, or all embedded media. Inspect the source deck and account for missing content manually or through a suitable rendering/conversion tool. Use the extracted material to create an outline and HTML deck; confirm consequential content changes.

## Static PDF export

```sh
python3 /path/to/skill/scripts/export-pdf.py deck/index.html deck/slides.pdf
```

Optional `--width 1280 --height 720` produces smaller screenshots; set both dimensions to match the deck’s intended aspect ratio. The output path must be new. All local assets must be inside the HTML’s parent folder and referenced relatively. A loopback-only server serves that directory while the exporter runs and is closed afterwards.

The deck must contain `.slide` elements and expose the async hook `window.renderSlide(index, {exportMode: true})` described in [HTML architecture](../html-template.md). Adapt existing deck controllers explicitly before using this exporter. It does not guess navigation state or manipulate arbitrary decks’ layout.

The hook must settle motion, show all intended content reveals, and hide controls/temporary overlays. Each slide is captured as a raster image and assembled as one PDF page. Animations, video playback, interactivity, selectable text, and accessibility structure do not survive. Missing requests/images fail the export; inspect rendered fonts, CSS backgrounds, charts, page count, clipping, and export-only state in the resulting PDF before delivery. Source browser checks alone do not validate PDF output.

## Publishing (optional)

Publish only when the user explicitly requests it. Choose hosting based on the user’s project and existing setup. The bundled helper is an optional Vercel adapter, not a default hosting choice.

Stage a dedicated folder with `index.html` and every referenced asset, including CSS backgrounds, fonts, scripts, and media. Review the entire folder for intended public content; the helper’s limited metadata checks are not a secret scanner. Do not point it at a repository or a workspace root. Avoid depending on an HTML regex to collect assets.

Requires an already installed Vercel CLI and authenticated account. Do not install it, log in, create paid resources, or promise permanent URLs/free usage implicitly. If the user chooses Vercel and setup is needed, follow the current official provider instructions within the authorized scope.

```sh
python3 /path/to/skill/scripts/deploy.py /path/to/reviewed-public-deck --publish
```

The helper verifies the folder, runs `vercel whoami`, and invokes the CLI interactively without `--yes` or `--prod`. Let the user resolve any account authorization prompt. Use the returned deployment URL and check all slides and assets there. Do not claim an existing URL was updated or a production alias moved unless verified.
