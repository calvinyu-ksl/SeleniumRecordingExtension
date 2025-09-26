# Selenium Recorder Chrome Extension

## Overview

Selenium Recorder is a Google Chrome browser extension designed to simplify the creation of basic automated test scripts or web automation workflows. It allows users to record their interactions (clicks, text input, selections) on a webpage and export these actions as a functional Selenium Python script, along with snapshots of the page's HTML source code at specific points.

## Features

* **User Interaction Recording:** Captures clicks, text inputs (final value on change/blur), and dropdown selections.
* **Real-time Action Display:** Shows a list of recorded actions, including HTML capture confirmations, in the browser's side panel.
* **HTML Source Capture:** Allows users to capture the full HTML source of the webpage at any point during the recording.
* **Selenium Script Generation:** Automatically generates a Python script using the `selenium-webdriver` library based on the recorded actions. Selectors prioritize unique IDs, falling back to Absolute XPath if no unique ID is found.
* **Recording Control:** Provides options to "Save & Export" the recording or "Cancel & Exit" to discard it.
* **ZIP Export:** Packages the generated Python script and all captured HTML files into a single downloadable ZIP archive.
* **Manifest V3:** Built using the modern Chrome extension platform.

## File Structure

| File             | Description                                                    |
| :--------------- | :------------------------------------------------------------- |
| `manifest.json`  | Extension configuration and permissions                        |
| `background.js`  | Service worker (handles state, script generation, export)      |
| `content.js`     | Injected into webpage to capture events                        |
| `popup.html`     | UI for the extension's toolbar button popup                    |
| `popup.js`       | Logic for the popup                                            |
| `sidepanel.html` | UI for the side panel (displays actions, controls)             |
| `sidepanel.js`   | Logic for the side panel                                       |
| `jszip.min.js`   | Library (required) for creating ZIP files in background script |

## Installation

1.  **Download/Clone:** Obtain the extension files and place them in a dedicated folder (e.g., `selenium_recorder_extension`). Ensure the `jszip.min.js` file is included in the root of this folder.
2.  **Open Chrome Extensions:** Open Google Chrome, navigate to `chrome://extensions/`.
3.  **Enable Developer Mode:** Ensure the "Developer mode" toggle (usually in the top-right corner) is switched **ON**.
4.  **Load Unpacked:** Click the "Load unpacked" button (usually in the top-left corner).
5.  **Select Folder:** Browse to and select the folder containing the extension files (e.g., `selenium_recorder_extension`).
6.  **Verify:** The "Selenium Recorder" extension should now appear in your list of extensions and its icon (or a default puzzle piece icon) should be visible in the Chrome toolbar.

## Usage

1.  **Navigate:** Go to the webpage where you want to start recording interactions.
2.  **Start Recording:** Click the Selenium Recorder extension icon in the Chrome toolbar. In the popup that appears, click the "Start Recording" button.
3.  **Side Panel Opens:** The browser's side panel should open, displaying the recording interface.
4.  **Interact:** Perform actions on the webpage (click elements, type into text fields and then click away/tab out, select options from dropdowns). These actions should appear sequentially in the side panel list.
5.  **Capture HTML (Optional):** At any point during the recording, click the "Capture HTML (X)" button in the side panel to save a snapshot of the current page's HTML source. A confirmation entry ("HTML Capture Completed") will appear in the actions list. The count in the button label will update.
6.  **Finish Recording:**
    * **Save:** Click the "Save & Export" button to generate the script and ZIP file. You'll be prompted to save the `selenium_recording.zip` file. The recording stops.
    * **Cancel:** Click the "Cancel & Exit" button to discard the current recording and close the side panel. No file will be generated.
7.  **Extract & Use (If Saved):** Extract the contents of the ZIP file. You will find:
    * `selenium_script.py`: The generated Python Selenium script.
    * `capture_1.html`, `capture_2.html`, etc.: The HTML snapshots you captured (if any).
8.  **Run Script:** To run the Python script, you need Python and `selenium` installed (`pip install selenium`), along with the appropriate WebDriver (e.g., ChromeDriver) accessible in your system's PATH or specified in the script.

## Technical Details

* **Manifest Version:** Manifest V3
* **Selector Strategy:** Prioritizes unique element `id`. If no unique `id` is found, it falls back to generating an Absolute XPath. As a last resort, it uses the tag name.
* **Key Chrome APIs:**
    * `chrome.sidePanel`: For displaying the recording UI.
    * `chrome.scripting`: For injecting the content script (`content.js`).
    * `chrome.runtime`: For messaging between extension components.
    * `chrome.tabs`: For querying tab information and sending messages to content scripts.
    * `chrome.downloads`: For initiating the ZIP file download.
* **Libraries:**
    * [JSZip](https://stuk.github.io/jszip/): Used client-side in the background script to create the ZIP archive.

## Limitations & Known Issues

* **Selector Robustness:** While unique IDs are preferred, the fallback Absolute XPath strategy is inherently **brittle**. Any change in the page structure between recording and playback can cause the XPath to fail. Manually adjusting selectors in the generated script might still be necessary for complex or frequently changing websites.
* **No Automatic Waits (Beyond Basic):** The generated script includes basic explicit waits (`WebDriverWait` for element presence/clickability) before each action, but it doesn't intelligently add waits based on application state changes or asynchronous operations triggered by actions. Longer `time.sleep()` pauses or more specific `WebDriverWait` conditions might need to be added manually, especially if actions depend on elements loading after a previous step.
* **No Navigation Handling in Script:** While recording *continues* if you navigate within the same tab, the generated Selenium script *does not* include `driver.get()` or other commands to perform those navigations. It only starts at the initial URL and executes all recorded actions sequentially. This will likely cause scripts recorded across multiple pages to fail without manual modification.
* **Limited Event Recording:** Only clicks, final text inputs (on change/blur), and select dropdown changes are currently recorded. Other events like hover, drag-and-drop, keyboard shortcuts, etc., are not captured.
* **iFrame Support:** Recording interactions within iFrames is not explicitly supported and may not work correctly.

## Potential Future Enhancements

* Implement more robust relative XPath or CSS selector strategies as alternatives.
* Record navigation events and generate corresponding `driver.get()` commands.
* Introduce options for adding explicit waits or assertions during recording.
* Record a wider range of browser events (hover, right-click, keyboard events).
* Allow editing or deleting recorded steps before export.
* Add configuration options (e.g., preferred selector strategy, default wait times).
* Improve handling of dynamic elements and waits.

