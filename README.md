# Selenium Recorder Chrome Extension

## Overview

Selenium Recorder is a Google Chrome browser extension designed to simplify the creation of basic automated test scripts or web automation workflows. It allows users to record their interactions (clicks, text input, selections) on a webpage and export these actions as a functional Selenium Python script, along with snapshots of the page's HTML source code at specific points.

## Features

* **User Interaction Recording:** Captures clicks, text inputs (final value on change/blur), and dropdown selections.
* **Real-time Action Display:** Shows a list of recorded actions in the browser's side panel, indicating the selector type (CSS/XPath) used and confirming HTML captures or pauses. Allows deletion of individual steps.
* **HTML Source Capture:** Allows users to capture the full HTML source of the webpage at any point during the recording.
* **Pause Recording:** Allows inserting custom pauses (in seconds) into the recording sequence via the side panel.
* **Popup/New Tab Recording:** Automatically detects new tabs/windows opened by the recorded tab and continues recording interactions within the new tab. (Note: Generated script does not yet handle window switching).
* **Selenium Script Generation:** Automatically generates a Python script using the `selenium-webdriver` library based on the recorded actions.
    * **Selector Strategy:** Prioritizes unique & stable IDs, falls back to attributes (`name`, `data-testid`, `role`, `title`), then stable classes, then simple structure (`nth-of-type`/`nth-child`), then text content XPath, then Absolute XPath, and finally tag name. Attempts to ignore dynamic/unstable IDs and common state/framework classes.
    * **Screenshots:** Includes commands to save a PNG screenshot after each recorded action step (and after initial navigation) into a `selenium_screenshots` subfolder. Also saves screenshots on errors.
    * **Pauses:** Translates recorded "Pause" actions into `time.sleep()` commands in the script.
    * **JS Click Fallback:** Includes a fallback to use JavaScript to click elements if the standard Selenium click is intercepted.
    * **Configurable Pause:** Adds a 3-second pause (`time.sleep(3)`) between other steps in the generated script.
* **Recording Control:** Provides options to "Save & Export" the recording, "Cancel & Exit" to discard it, and delete individual steps.
* **ZIP Export:** Packages the generated Python script and all captured HTML files into a single downloadable ZIP archive.
* **Manifest V3:** Built using the modern Chrome extension platform.

## File Structure

| File             | Description                                                    |
| :--------------- | :------------------------------------------------------------- |
| `manifest.json`  | Extension configuration and permissions                        |
| `background.js`  | Service worker (handles state, script generation, export)      |
| `content.js`     | Injected into webpage to capture events & generate selectors   |
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
4.  **Interact:** Perform actions on the webpage (click elements, type into text fields and then click away/tab out, select options from dropdowns). These actions should appear sequentially in the side panel list, indicating the selector type used (e.g., `(CSS):`, `(XPath):`). If a click opens a new tab/window, recording will automatically continue in the new tab (a "Switch Tab" action will be logged).
5.  **Add Pause (Optional):** Enter a duration (in seconds) into the "Pause (sec)" input field in the side panel and click "Add Pause" to insert a wait step into the recording.
6.  **Delete Step (Optional):** Click the `✕` button next to any recorded step in the side panel to remove it from the recording. Step numbers will be automatically adjusted.
7.  **Capture HTML (Optional):** At any point during the recording, click the "Capture HTML (X)" button in the side panel to save a snapshot of the current page's HTML source. A confirmation entry ("HTML Capture Completed") will appear in the actions list. The count in the button label will update.
8.  **Finish Recording:**
    * **Save:** Click the "Save & Export" button to generate the script and ZIP file. You'll be prompted to save the `selenium_recording.zip` file. The recording stops.
    * **Cancel:** Click the "Cancel & Exit" button to discard the current recording and close the side panel. No file will be generated.
9.  **Extract & Use (If Saved):** Extract the contents of the ZIP file. You will find:
    * `selenium_script.py`: The generated Python Selenium script.
    * `capture_1.html`, `capture_2.html`, etc.: The HTML snapshots you captured (if any).
    * A `selenium_screenshots` folder will be created in the directory where you run the Python script, containing PNG screenshots for each step and any errors.
10. **Run Script:** To run the Python script, you need Python and `selenium` installed (`pip install selenium`), along with the appropriate WebDriver (e.g., ChromeDriver) accessible in your system's PATH or specified in the script. **Note:** You may need to manually add `driver.switch_to.window(...)` commands if your recording involved new tabs/windows.

## Technical Details

* **Manifest Version:** Manifest V3
* **Selector Strategy:** Prioritizes unique & stable `id`, then attributes (`name`, `data-testid`, `role`, `title`), then stable `class` combinations, then simple structure (`nth-of-type`/`nth-child`), then text content XPath, and finally Absolute XPath as a fallback. Attempts to ignore dynamic/unstable IDs and common state/framework classes.
* **Key Chrome APIs:**
    * `chrome.sidePanel`: For displaying the recording UI.
    * `chrome.scripting`: For injecting the content script (`content.js`).
    * `chrome.runtime`: For messaging between extension components.
    * `chrome.tabs`: For querying tab information, detecting new tabs, and sending messages.
    * `chrome.downloads`: For initiating the ZIP file download.
* **Libraries:**
    * [JSZip](https://stuk.github.io/jszip/): Used client-side in the background script to create the ZIP archive.

## Limitations & Known Issues

* **No Window Switching in Script:** While recording *continues* in new tabs/windows opened from the recorded tab, the generated Selenium script **does not** currently include the necessary `driver.switch_to.window(...)` commands to replicate this switching during playback. This will cause scripts involving popups to fail without manual modification.
* **Selector Robustness:** While the strategy attempts to find stable selectors, it may still fall back to Absolute XPath or text-based XPath, which can be **brittle**. Any change in page structure or text content between recording and playback can cause these selectors to fail. Dynamic IDs/classes not caught by the filtering logic can also cause CSS selectors to fail. Manually adjusting selectors in the generated script is often necessary for complex or frequently changing websites. **Relative selectors are not generated.**
* **No Automatic Waits (Beyond Basic):** The generated script includes basic explicit waits (`WebDriverWait` for element presence/clickability) before each action and fixed `time.sleep()` pauses after actions (including custom pauses). It doesn't intelligently add waits based on application state changes or asynchronous operations. More specific `WebDriverWait` conditions might need to be added manually.
* **Limited Event Recording:** Only clicks, final text inputs (on change/blur), select dropdown changes, and manual pauses are currently recorded. Other events like hover, drag-and-drop, keyboard shortcuts, etc., are not captured.
* **iFrame Support:** Recording interactions within iFrames is not explicitly supported and may not work correctly.
* **Shadow DOM:** Interactions within Shadow DOM elements are not supported.
* **Context Invalidation:** Clicking elements that cause immediate navigation might prevent that final click action from being recorded due to the browser context being invalidated before the message can be sent.

## Potential Future Enhancements

* Implement generation of `driver.switch_to.window()` commands for recorded tab switches.
* Implement more robust relative XPath or CSS selector strategies.
* Record navigation events and generate corresponding `driver.get()` commands.
* Introduce options for adding explicit waits or assertions during recording.
* Record a wider range of browser events (hover, right-click, keyboard events).
* Allow editing or deleting recorded steps before export (Delete is implemented, Edit is not).
* Add configuration options (e.g., preferred selector strategy, default wait times, screenshot options).
* Improve handling of dynamic elements beyond basic filtering.
* Add support for iFrames and Shadow DOM.
