/**
 * sidepanel.js
 * Extension sidebar (Side Panel) UI and logic.
 * - Display recorded actions.
 * - Handle user interactions: delete, save/export, cancel recording, etc.
 */

// Protection: prevent duplicate initialization of this file (multiple executions may cause event binding duplication or errors).
if (typeof window.sidePanelInitialized === "undefined") {
  window.sidePanelInitialized = true;

  // Create a persistent connection to detect side panel closure
  const port = chrome.runtime.connect({ name: "sidepanel" });
  console.log("Side Panel: Created persistent connection to background");

  // Track if user confirmed closure
  let userConfirmedClose = false;

  // When port disconnects, it means side panel was closed
  port.onDisconnect.addListener(() => {
    console.log("Side Panel: Port disconnected - panel was closed");
    // Send one final message before disconnect (if possible)
    if (isRecording && !userConfirmedClose) {
      console.log(
        "Side Panel: Recording was active but not confirmed - notifying background"
      );
    }
  });

  // --- Get DOM elements in Side Panel ---
  const actionsList = document.getElementById("actions-list");
  const saveButton = document.getElementById("save-button");
  const cancelButton = document.getElementById("cancel-button");
  const statusMessage = document.getElementById("status-message");
  const htmlCountSpan = document.getElementById("html-count");
  const startUrlSpan = document.getElementById("start-url");
  const captureHtmlButton = document.getElementById("capture-html-button");
  const screenRecordButton = document.getElementById("screen-record-button");
  const fullBrowserShotButton = document.getElementById(
    "full-browser-shot-button"
  );

  // Editor mode elements
  const modeIndicator = document.getElementById("mode-indicator");
  const editorToolbar = document.getElementById("editor-toolbar");
  const importJsonButton = document.getElementById("import-json-button");
  const jsonFileInput = document.getElementById("json-file-input");
  const actionCountBadge = document.getElementById("action-count-badge");

  // Debug: Check if editor elements exist
  console.log("Editor elements check at initialization:");
  console.log("- modeIndicator:", modeIndicator);
  console.log("- editorToolbar:", editorToolbar);
  console.log("- importJsonButton:", importJsonButton);
  console.log("- jsonFileInput:", jsonFileInput);
  console.log("- actionCountBadge:", actionCountBadge);

  // Recording state and screen recording related variables
  let isRecording = false; // Whether recording is in progress
  let isEditorMode = false; // Whether in editor mode
  let mediaRecorder = null; // MediaRecorder instance (screen recording)
  let recordedChunks = []; // Temporary recording segment data
  let recordStart = null; // Recording start time (for timer purposes)
  let timerInterval = null; // Timer interval reference
  let isUserScrolling = false; // Track if user is manually scrolling
  let scrollTimeout = null; // Timeout for scroll detection
  let lastActionCount = 0; // Track the last known action count

  /**
   * Renders the list of recorded actions in the side panel.
   * @param {Array<Object>} actions - The array of action objects to display.
   */
  function renderActions(actions = []) {
    // Render recorded actions to the list
    actionsList.innerHTML = ""; // Clear previous list

    if (actions.length === 0) {
      const placeholder = document.createElement("div");
      placeholder.className = "action-item-placeholder";
      placeholder.textContent =
        "No actions recorded yet. Interact with the page to begin.";
      actionsList.appendChild(placeholder);
      lastActionCount = 0;
      return;
    }

    actions.forEach((action) => {
      if (action.type === "DragAndDrop") {
        //try { console.log('[SidePanel][DND] Rendering DragAndDrop action:', action); } catch(e) {}
      }
      const item = document.createElement("div");
      item.className = "action-item";
      item.dataset.step = action.step;

      const content = document.createElement("div");
      content.className = "action-content";

      const step = document.createElement("span");
      step.className = "action-step";
      step.textContent = `${action.step}.`;

      const type = document.createElement("span");
      type.className = "action-type";
      type.textContent = action.type;

      const details = document.createElement("span");
      details.className = "action-details";

      let detailText = "";
      if (action.type === "HTML_Capture") {
        item.classList.add("html-capture-item");
        detailText = "Page source captured";
      } else if (action.type === "DragAndDrop") {
        // Prefer explicit source/target fields if present
        const src = action.sourceSelector || action.selector || "";
        const tgt = action.targetSelector || "";
        if (src && tgt) {
          detailText = `Drag: ${src} -> ${tgt}`;
          if (action.containerKind) detailText += ` (${action.containerKind})`;
        } else if (action.value) {
          // Fallback to value summary provided by background enrichment
          detailText = action.value;
        } else if (action.selector) {
          detailText = `XPath: ${action.selector}`;
        } else {
          detailText = "DragAndDrop action";
        }
      } else if (action.selector) {
        // Smart selector type detection
        let selectorType = action.selectorType || "XPath";
        const selector = action.selector;

        // Detect ID-based selectors
        if (selector.startsWith("#")) {
          selectorType = "ID (CSS)";
        } else if (/^\/\/\*\[@id=/.test(selector)) {
          // XPath using ID attribute: //*[@id="..."]
          selectorType = "ID (XPath)";
        } else if (selectorType === "XPath") {
          selectorType = "XPath";
        } else if (selectorType === "CSS") {
          selectorType = "CSS";
        }

        detailText = `${selectorType}: ${selector}`;
      }

      // Add value display with smart text extraction
      if (
        action.value &&
        action.type !== "HTML_Capture" &&
        action.type !== "DragAndDrop"
      ) {
        let displayValue = action.value;

        // For Input type, try to extract meaningful text from selector
        if (
          action.type === "Input" &&
          action.elementInfo &&
          action.elementInfo.textContent
        ) {
          displayValue = action.elementInfo.textContent.trim();
        } else if (
          typeof action.value === "string" &&
          action.value.length > 50
        ) {
          // Truncate long values
          displayValue = action.value.substring(0, 47) + "...";
        }

        detailText += ` | Value: "${displayValue}"`;
      }

      details.textContent = detailText;
      details.title = detailText;

      // Create buttons container
      const buttonsContainer = document.createElement("div");
      buttonsContainer.className = "action-buttons";

      // Only create edit button if not HTML_Capture
      if (action.type !== "HTML_Capture") {
        // Create replace button (only in editor mode)
        if (
          isEditorMode &&
          action.type !== "Navigate" &&
          action.type !== "DragAndDrop"
        ) {
          const replaceButton = document.createElement("button");
          replaceButton.className = "replace-button";
          replaceButton.textContent = "🔄";
          replaceButton.title = `Replace selector/value for step ${action.step}`;

          replaceButton.addEventListener("click", (e) => {
            e.stopPropagation();
            handleReplaceAction(action);
          });

          buttonsContainer.appendChild(replaceButton);
        }

        // Create edit (comment) button
        const editButton = document.createElement("button");
        editButton.className = "edit-button";
        editButton.textContent = "✏️";
        editButton.title = `Add comment to step ${action.step}`;

        // Add visual indicator if action has comment
        if (action.comment && action.comment.trim()) {
          editButton.classList.add("has-comment");
          editButton.title = `Edit comment for step ${
            action.step
          }: "${action.comment.trim()}"`;
        }

        editButton.addEventListener("click", (e) => {
          e.stopPropagation();
          handleEditComment(action.step, action.comment || "");
        });

        buttonsContainer.appendChild(editButton);
      }

      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-button";
      deleteButton.textContent = "✖";
      deleteButton.title = `Delete step ${action.step}`;
      deleteButton.addEventListener("click", (e) => {
        e.stopPropagation();
        // Pass action type and recordingId for background page to determine (e.g., delete screen recording markers and corresponding videos).
        handleDeleteAction(
          action.step,
          action.type,
          action.recordingId || null
        );
      });

      buttonsContainer.appendChild(deleteButton);

      content.appendChild(step);
      content.appendChild(type);
      content.appendChild(details);

      item.appendChild(content);
      item.appendChild(buttonsContainer);
      actionsList.appendChild(item);
    });

    // Auto-scroll to bottom when new actions are added
    const currentActionCount = actions.length;
    console.log(
      `[SidePanel] Action count changed: ${lastActionCount} -> ${currentActionCount}`
    );

    if (currentActionCount > lastActionCount) {
      console.log(
        `[SidePanel] New actions detected, forcing scroll to bottom for ALL action types`
      );
      // Use setTimeout to ensure DOM is updated before scrolling
      setTimeout(() => {
        const actionsContainer = document.querySelector(".actions-container");
        if (actionsContainer) {
          console.log(
            `[SidePanel] Scroll container found, forcing scroll regardless of user activity`
          );

          // ALWAYS scroll to bottom for ANY new action - no conditions!
          actionsContainer.scrollTop = actionsContainer.scrollHeight;
          console.log(
            `[SidePanel] FORCED scroll to bottom - scrollTop set to: ${actionsContainer.scrollHeight}`
          );

          // Reset user scrolling flag after any scroll
          isUserScrolling = false;
          if (scrollTimeout) {
            clearTimeout(scrollTimeout);
            scrollTimeout = null;
          }
        } else {
          console.log(`[SidePanel] Actions container not found`);
        }
      }, 10);
    }

    // Update the last action count
    lastActionCount = currentActionCount;
  }

  /**
   * Updates the entire UI state based on data from the background script.
   * @param {Object} data - The state data.
   */
  function updateUI(data) {
    // Update overall UI state based on data provided by background page
    if (!data) return;

    isRecording = data.isRecording;

    renderActions(data.actions || []);
    htmlCountSpan.textContent = data.htmlCount || 0;
    if (data.startUrl) {
      const maxUrlLength = 50; // 最大顯示 50 個字符
      const url = data.startUrl;

      // 如果 URL 超過最大長度，截斷並添加省略號
      if (url.length > maxUrlLength) {
        startUrlSpan.textContent = url.substring(0, maxUrlLength) + "...";
      } else {
        startUrlSpan.textContent = url;
      }

      startUrlSpan.href = data.startUrl;
      startUrlSpan.title = data.startUrl; // 懸停時顯示完整 URL
    }

    // Update action count badge (for both editor and recorder modes)
    const actionCount = (data.actions && data.actions.length) || 0;
    updateActionCountBadge(actionCount);

    // In Editor mode, allow saving if there are actions
    if (isEditorMode) {
      const hasActions = data.actions && data.actions.length > 0;
      saveButton.disabled = !hasActions;
      cancelButton.disabled = false; // Enable cancel to clear actions in editor mode
      captureHtmlButton.disabled = true; // Can't capture in editor mode
      if (fullBrowserShotButton) fullBrowserShotButton.disabled = true;

      console.log(
        `[Editor Mode] updateUI: actions=${data.actions?.length}, saveButton.disabled=${saveButton.disabled}`
      );

      // Don't override editor mode status message
      return;
    }

    // Normal recording mode
    // Save button: enabled if there are actions (can save during recording or after stopping)
    saveButton.disabled = !data.actions || data.actions.length === 0;
    // Cancel button: only enabled while recording
    cancelButton.disabled = !isRecording;
    // Capture buttons: only enabled while recording
    captureHtmlButton.disabled = !isRecording;
    if (fullBrowserShotButton) fullBrowserShotButton.disabled = !isRecording;

    if (isRecording) {
      statusMessage.textContent = "Recording in progress...";
      statusMessage.classList.remove("status-stopped");
      statusMessage.classList.add("status-recording");
    } else {
      statusMessage.textContent = "Recording stopped.";
      statusMessage.classList.remove("status-recording");
      statusMessage.classList.add("status-stopped");
    }
  }

  // --- Event Handlers ---

  /**
   * Handles replacing selector/value for a recorded action.
   * @param {Object} action - The action object to replace.
   */
  function handleReplaceAction(action) {
    // Build current info
    let currentInfo = `Step ${action.step} - ${action.type}\n\n`;
    if (action.selector)
      currentInfo += `Current Selector:\n${action.selector}\n\n`;
    if (action.value) currentInfo += `Current Value: ${action.value}\n\n`;

    // Prompt for what to replace
    const choice = prompt(
      `${currentInfo}What do you want to replace?\n` +
        `1 - Selector\n` +
        `2 - Value\n` +
        `3 - Both\n\n` +
        `Enter your choice (1/2/3):`
    );

    if (!choice) return; // User cancelled

    let newSelector = action.selector;
    let newValue = action.value;

    // Helper function to send replace action to background
    const sendReplaceAction = (stepNumber, selector, value) => {
      chrome.runtime
        .sendMessage({
          command: "replace_action",
          data: {
            stepNumber: stepNumber,
            selector: selector,
            value: value,
          },
        })
        .then((response) => {
          if (response && response.success) {
            console.log(`Action replaced for step ${stepNumber}`);
            // Refresh the UI
            chrome.runtime.sendMessage({ command: "get_recording_state" });
          } else {
            console.error("Failed to replace action:", response);
            alert("Failed to replace action. Please try again.");
          }
        })
        .catch((error) => {
          console.error("Error replacing action:", error);
          alert("Error replacing action. Please check console.");
        });
    };

    // Helper function to get element info and send replace action
    const sendReplaceActionWithElementInfo = (
      stepNumber,
      selector,
      value,
      elementInfo
    ) => {
      chrome.runtime
        .sendMessage({
          command: "replace_action",
          data: {
            stepNumber: stepNumber,
            selector: selector,
            value: value,
            tagName: elementInfo?.tagName,
            elementType: elementInfo?.elementType, // 新增：元素類型信息
          },
        })
        .then((response) => {
          if (response && response.success) {
            console.log(
              `Action replaced for step ${stepNumber} with element info`
            );
            // Refresh the UI
            chrome.runtime.sendMessage({ command: "get_recording_state" });
          } else {
            console.error("Failed to replace action:", response);
            alert("Failed to replace action. Please try again.");
          }
        })
        .catch((error) => {
          console.error("Error replacing action:", error);
          alert("Error replacing action. Please check console.");
        });
    };

    if (choice === "1" || choice === "3") {
      // Start element picker mode in the content script
      alert(
        "Click on the element you want to select on the page, or press ESC to cancel."
      );

      // Get the current active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          alert("Could not find active tab. Please try again.");
          return;
        }

        const activeTabId = tabs[0].id;

        // Send message to content script to start element picker
        chrome.tabs.sendMessage(
          activeTabId,
          { command: "start_element_picker" },
          (response) => {
            if (chrome.runtime.lastError) {
              console.error(
                "Failed to start element picker:",
                chrome.runtime.lastError
              );
              alert("Failed to start element picker. Please try again.");
              return;
            }

            if (response && response.success) {
              newSelector = response.selector;
              console.log("Selected element:", response);

              // Prepare element info for type detection
              const elementInfo = {
                tagName: response.tagName,
                elementType: response.tagName, // Will be used to detect action type
              };

              // Continue with value replacement if choice was '3' (both)
              if (choice === "3") {
                const promptedValue = prompt(
                  `Enter new value for step ${action.step}:`,
                  action.value || ""
                );
                if (promptedValue !== null) {
                  newValue = promptedValue;
                } else {
                  return; // User cancelled value input
                }
              }

              // Send update to background with element info
              sendReplaceActionWithElementInfo(
                action.step,
                newSelector,
                newValue,
                elementInfo
              );
            } else if (response && response.cancelled) {
              console.log("Element picker cancelled by user");
            }
          }
        );
      });

      return; // Exit early as we're handling async
    }

    if (choice === "2") {
      const promptedValue = prompt(
        `Enter new value for step ${action.step}:`,
        action.value || ""
      );
      if (promptedValue !== null) {
        newValue = promptedValue;
        // Send update to background
        sendReplaceAction(action.step, newSelector, newValue);
      }
    }
  }

  /**
   * Handles editing comments for a recorded action.
   * @param {number} stepNumber - The step number to edit.
   * @param {string} currentComment - The current comment text.
   */
  function handleEditComment(stepNumber, currentComment) {
    const newComment = prompt(
      `Add comment for step ${stepNumber}:`,
      currentComment
    );
    if (newComment !== null) {
      // User didn't cancel
      chrome.runtime
        .sendMessage({
          command: "update_action_comment",
          data: { stepNumber, comment: newComment.trim() },
        })
        .then((response) => {
          if (response && response.success) {
            console.log(`Comment updated for step ${stepNumber}`);
            // Refresh the UI to show the updated comment
            chrome.runtime.sendMessage({ command: "get_recording_state" });
          } else {
            console.error("Failed to update comment:", response);
          }
        })
        .catch((error) => {
          console.error("Error updating comment:", error);
        });
    }
  }

  function handleDeleteAction(step, actionType, recordingId) {
    // Delete specified step (confirm first when deleting screen recording markers)
    // Allow delete in both recording mode and editor mode
    if (!isRecording && !isEditorMode) return;

    // Ask user for confirmation before deleting any action
    const confirmMsg =
      actionType === "ScreenRecordingStart" ||
      actionType === "ScreenRecordingStop"
        ? `Are you sure you want to delete the screen recording marker at step ${step}? This will remove the associated recorded video only.`
        : `Are you sure you want to delete step ${step} (${actionType})?`;

    if (!confirm(confirmMsg)) return;

    console.log(`Side Panel: Requesting to delete action step ${step}`);
    const payload = { step };
    if (recordingId) payload.recordingId = recordingId;
    chrome.runtime
      .sendMessage({ command: "delete_action", data: payload })
      .then(() => {
        // Update action count badge in editor mode
        if (isEditorMode && actionCountBadge) {
          // Request updated state to refresh UI
          chrome.runtime
            .sendMessage({ command: "get_recording_state" })
            .then((response) => {
              if (response && response.actions) {
                updateActionCountBadge(response.actions.length);
              }
            });
        }
      })
      .catch((e) =>
        console.error("Side Panel: Error sending delete request:", e)
      );
  }

  function handleSave() {
    // Trigger save and export ZIP (background script generates Python script and packages)
    console.log("=== handleSave called ===");
    console.log("isRecording:", isRecording);
    console.log("isEditorMode:", isEditorMode);
    console.log("saveButton:", saveButton);
    console.log("saveButton.disabled:", saveButton?.disabled);

    // Allow save if:
    // 1. Currently recording, OR
    // 2. In editor mode, OR
    // 3. Recording stopped but has actions (normal save after stop)
    // Basically: just check if button is enabled (which checks for actions)
    if (saveButton.disabled) {
      console.log("❌ Save button is disabled, returning early");
      return;
    }

    console.log(
      "✅ Side Panel: Save & Export button clicked - proceeding with save"
    );
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";
    statusMessage.textContent = "Starting export...";
    chrome.runtime
      .sendMessage({ command: "save_export" })
      .then((response) => {
        console.log("Save export response:", response);
        if (response && response.success) {
          // Show success message briefly before closing
          statusMessage.textContent = "Export completed! Closing...";
          statusMessage.style.color = "#4CAF50";

          // Disable side panel based on mode
          const disablePromise = isEditorMode
            ? disableSidePanelForAllTabs() // Editor: disable all tabs
            : disableSidePanelGlobally(); // Recorder: disable globally

          disablePromise.then(() => {
            setTimeout(() => {
              console.log("Auto-closing side panel after successful save");
              window.close();
            }, 1000); // 1 second delay to show success message
          });
        }
      })
      .catch((error) => {
        console.error("Save export error:", error);
        // Re-enable button on error so user can retry
        saveButton.textContent = "Save & Export";
        saveButton.disabled = false;
        statusMessage.textContent = "Export failed. Please try again.";
        statusMessage.style.color = "#f44336";
      });
  }

  function handleCancel() {
    // Cancel entire recording process (clears background script state)
    console.log("Side Panel: Cancel button clicked.");
    console.log("isEditorMode:", isEditorMode);
    console.log("isRecording:", isRecording);

    // In Editor mode, confirm before closing
    if (isEditorMode) {
      if (
        confirm(
          "Are you sure you want to close the editor? Any unsaved changes will be lost."
        )
      ) {
        console.log("Editor mode: Closing window");
        // Reset editor state before closing
        isEditorMode = false;
        document.body.classList.remove("editor-mode");
        // Editor mode: Only disable side panel for all tabs (since editor is tab-specific)
        disableSidePanelForAllTabs().then(() => {
          window.close();
        });
      }
      return;
    }

    // Normal recording mode - only allow cancel if recording
    if (!isRecording) {
      console.log("Not recording, cancel ignored");
      return;
    }

    if (
      confirm(
        "Are you sure you want to cancel this recording? All recorded data will be lost."
      )
    ) {
      console.log("Sending cancel_recording command");
      chrome.runtime
        .sendMessage({ command: "cancel_recording" })
        .then((response) => {
          console.log("Cancel recording response:", response);
          // Force reset local state
          lastActionCount = 0;
          if (actionCountBadge) {
            actionCountBadge.textContent = "0 actions";
          }
          // Recorder mode: Disable side panel globally
          return disableSidePanelGlobally();
        })
        .catch((e) =>
          console.error("Side Panel: Error sending cancel request:", e)
        );
    }
  }

  // Helper function to disable side panel globally
  async function disableSidePanelGlobally() {
    try {
      await chrome.sidePanel.setOptions({
        enabled: false,
      });
      console.log("Side panel disabled globally");
    } catch (error) {
      console.error("Error disabling side panel globally:", error);
    }
  }

  // Helper function to disable side panel for all tabs
  async function disableSidePanelForAllTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      console.log(`Disabling side panel for ${tabs.length} tabs`);
      for (const tab of tabs) {
        try {
          await chrome.sidePanel.setOptions({
            tabId: tab.id,
            enabled: false,
          });
        } catch (err) {
          // Ignore errors for tabs that don't support side panel
          console.log(
            `Could not disable side panel for tab ${tab.id}:`,
            err.message
          );
        }
      }
      console.log("Side panel disabled for all tabs");
    } catch (error) {
      console.error("Error disabling side panel:", error);
    }
  }

  function handleCaptureHtml() {
    // Manually capture current page HTML (useful for debugging or offline viewing)
    if (!isRecording) return;
    console.log("Side Panel: Manual HTML capture button clicked.");
    captureHtmlButton.disabled = true;
    chrome.runtime.sendMessage({ command: "capture_html" }).finally(() => {
      setTimeout(() => {
        if (isRecording) captureHtmlButton.disabled = false;
      }, 500);
    });
  }

  function formatTime(ms) {
    // Convert milliseconds to MM:SS format
    const total = Math.floor(ms / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, "0");
    const s = String(total % 60).padStart(2, "0");
    return `${m}:${s}`;
  }
  function updateTimer() {
    // Update recording timer
    if (!recordStart) return;
    const elapsed = Date.now() - recordStart;
    screenRecordButton.querySelector(".timer").textContent =
      formatTime(elapsed);
  }
  async function startScreenRecording() {
    // Start screen recording (using getDisplayMedia + MediaRecorder)
    try {
      chrome.runtime
        .sendMessage({ command: "screen_recording_start" })
        .catch(() => {});
      recordedChunks = [];
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      });
      stream
        .getVideoTracks()
        .forEach((t) => t.addEventListener("ended", stopScreenRecording));
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: "video/webm;codecs=vp8,opus",
      });
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = () => {
        (async () => {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const fileName = `recording_${ts}.webm`;
            const blob = new Blob(recordedChunks, { type: "video/webm" });
            const arrayBuffer = await blob.arrayBuffer();
            const chunkSize = 256 * 1024; // Chunk size 256KB
            const total = Math.ceil(arrayBuffer.byteLength / chunkSize);
            const id = "vid_" + Date.now(); // ID for segmented assembly in background script
            for (let i = 0; i < total; i++) {
              const part = arrayBuffer.slice(
                i * chunkSize,
                (i + 1) * chunkSize
              );
              const b64 = arrayBufferToBase64(part);
              await sendVideoChunk({
                id,
                fileName,
                index: i,
                total,
                chunkBase64: b64,
              });
            }
            chrome.runtime
              .sendMessage({
                command: "screen_recording_stop",
                data: { fileName },
              })
              .catch(() => {});
            console.log(
              "Side Panel: Video chunks sent:",
              fileName,
              "total parts:",
              total
            );
          } catch (err) {
            console.warn("Side Panel: Failed to send video to background", err);
            chrome.runtime
              .sendMessage({ command: "screen_recording_stop" })
              .catch(() => {});
          }
        })();
      };
      mediaRecorder.start();
      recordStart = Date.now();
      screenRecordButton.classList.add("recording");
      screenRecordButton.innerHTML =
        'Stop Screen Capture <span class="timer">00:00</span>';
      updateTimer();
      timerInterval = setInterval(updateTimer, 1000);
    } catch (err) {
      alert("Screen capture failed: " + err.message);
      resetScreenRecordButton();
    }
  }

  function arrayBufferToBase64(buf) {
    // Convert ArrayBuffer to base64 for transmission
    let binary = "";
    const bytes = new Uint8Array(buf);
    const len = bytes.length;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function sendVideoChunk(payload) {
    // Send video chunk to background script (background script assembles)
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { command: "video_chunk", data: payload },
        () => resolve()
      );
    });
  }
  function stopScreenRecording() {
    // Stop screen recording and cleanup state
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (e) {
        chrome.runtime
          .sendMessage({ command: "screen_recording_stop" })
          .catch(() => {});
      }
    } else {
      chrome.runtime
        .sendMessage({ command: "screen_recording_stop" })
        .catch(() => {});
    }
    mediaRecorder = null;
    recordStart = null;
    resetScreenRecordButton();
  }
  function resetScreenRecordButton() {
    // Reset button UI
    screenRecordButton.classList.remove("recording");
    screenRecordButton.textContent = "Start Screen Capture";
  }
  screenRecordButton?.addEventListener("click", () => {
    // Click toggle: Not recording -> Start recording; Recording -> Stop recording
    if (!mediaRecorder || mediaRecorder.state === "inactive")
      startScreenRecording();
    else stopScreenRecording();
  });

  // --- Initialization ---

  // Set up scroll detection for actions container
  const actionsContainer = document.querySelector(".actions-container");
  if (actionsContainer) {
    actionsContainer.addEventListener("scroll", () => {
      // User is scrolling manually
      isUserScrolling = true;

      // Clear existing timeout
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }

      // Reset scroll detection after 2 seconds of no scrolling
      scrollTimeout = setTimeout(() => {
        isUserScrolling = false;
      }, 2000);

      // If user scrolls to near bottom, reset the flag immediately
      const isNearBottom =
        actionsContainer.scrollTop + actionsContainer.clientHeight >=
        actionsContainer.scrollHeight - 50;
      if (isNearBottom) {
        isUserScrolling = false;
      }
    });
  }

  // Get HTML capture config elements (now only in modal)
  // const captureModeSelect = document.getElementById('capture-mode'); // Removed from main panel
  // const captureFrequencySelect = document.getElementById('capture-frequency'); // Removed from main panel

  // Settings modal elements
  const settingsModal = document.getElementById("settings-modal");
  const openSettingsButton = document.getElementById("open-settings-button");
  const closeSettingsButton = document.getElementById("close-settings-button");
  const settingsCancelButton = document.getElementById(
    "settings-cancel-button"
  );
  const settingsSaveButton = document.getElementById("settings-save-button");

  // Modal form elements
  const modalCaptureMode = document.getElementById("modal-capture-mode");
  const modalCaptureFrequency = document.getElementById(
    "modal-capture-frequency"
  );
  const enableScreenshots = document.getElementById("enable-screenshots");
  const scriptSleepInterval = document.getElementById("script-sleep-interval");

  // Default settings
  let htmlCaptureSettings = {
    mode: "smart",
    minInterval: 1000,
    similarityThreshold: 0.85,
    maxCapturesPerMinute: 15,
    enableScreenshots: true,
    scriptSleepInterval: 1, // Default 1 second between steps
  };

  // HTML capture configuration handlers
  function updateHtmlCaptureConfig() {
    // Since main panel elements are removed, we'll use the current settings object values
    // and send the complete config including screenshot setting to background script
    chrome.runtime
      .sendMessage({
        command: "update_html_capture_config",
        config: htmlCaptureSettings,
      })
      .catch(() => {
        console.warn("Failed to update HTML capture config");
      });
  }

  // Settings modal functions
  function openSettingsModal() {
    // Populate modal with current settings
    modalCaptureMode.value = htmlCaptureSettings.mode;

    // Set frequency based on minInterval
    if (htmlCaptureSettings.minInterval <= 500) {
      modalCaptureFrequency.value = "frequent";
    } else if (htmlCaptureSettings.minInterval <= 1000) {
      modalCaptureFrequency.value = "normal";
    } else {
      modalCaptureFrequency.value = "minimal";
    }

    enableScreenshots.checked = htmlCaptureSettings.enableScreenshots;

    // Set script sleep interval
    if (scriptSleepInterval) {
      scriptSleepInterval.value = String(
        htmlCaptureSettings.scriptSleepInterval != null
          ? htmlCaptureSettings.scriptSleepInterval
          : 1
      );
    }

    // Update frequency option visibility based on mode
    updateFrequencyVisibility();

    settingsModal.classList.add("show");
  }

  function closeSettingsModal() {
    settingsModal.classList.remove("show");
  }

  function updateFrequencyVisibility() {
    const frequencyOption = modalCaptureFrequency.closest(".settings-option");
    if (modalCaptureMode.value === "manual") {
      frequencyOption.style.display = "none";
    } else {
      frequencyOption.style.display = "flex";
    }
  }

  function saveSettings() {
    // Update settings from modal
    htmlCaptureSettings.mode = modalCaptureMode.value;

    // Update frequency only if not manual mode
    if (htmlCaptureSettings.mode !== "manual") {
      switch (modalCaptureFrequency.value) {
        case "minimal":
          htmlCaptureSettings.minInterval = 2000;
          break;
        case "normal":
          htmlCaptureSettings.minInterval = 1000;
          break;
        case "frequent":
          htmlCaptureSettings.minInterval = 500;
          break;
      }
    }

    htmlCaptureSettings.enableScreenshots = enableScreenshots.checked;

    // Save script sleep interval
    if (scriptSleepInterval) {
      const parsedValue = parseFloat(scriptSleepInterval.value);
      htmlCaptureSettings.scriptSleepInterval = !isNaN(parsedValue)
        ? parsedValue
        : 1;
    }

    console.log("Saving settings:", htmlCaptureSettings); // Debug log

    // Send updated config to background script
    chrome.runtime
      .sendMessage({
        command: "update_html_capture_config",
        config: htmlCaptureSettings,
      })
      .then(() => {
        console.log("Settings saved successfully:", htmlCaptureSettings);
        closeSettingsModal();
      })
      .catch(() => {
        console.warn("Failed to save settings");
        alert("Failed to save settings. Please try again.");
      });
  }

  // Bind config change events (removed since main panel elements are gone)
  // captureModeSelect?.addEventListener('change', updateHtmlCaptureConfig);
  // captureFrequencySelect?.addEventListener('change', updateHtmlCaptureConfig);

  // Bind settings modal events
  openSettingsButton?.addEventListener("click", openSettingsModal);
  closeSettingsButton?.addEventListener("click", closeSettingsModal);
  settingsCancelButton?.addEventListener("click", closeSettingsModal);
  settingsSaveButton?.addEventListener("click", saveSettings);

  // Add change listener for mode selection
  modalCaptureMode?.addEventListener("change", updateFrequencyVisibility);

  // Close modal when clicking outside
  settingsModal?.addEventListener("click", (e) => {
    if (e.target === settingsModal) {
      closeSettingsModal();
    }
  });

  // Close modal with Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsModal.classList.contains("show")) {
      closeSettingsModal();
    }
  });

  // Initialize config on load (send initial settings to background)
  updateHtmlCaptureConfig();

  // Bind button events
  console.log("Binding button events...");
  console.log("saveButton element:", saveButton);
  saveButton.addEventListener("click", handleSave);
  console.log("✅ Save button event listener added");
  cancelButton.addEventListener("click", handleCancel);
  captureHtmlButton.addEventListener("click", handleCaptureHtml);
  fullBrowserShotButton?.addEventListener("click", async () => {
    if (!isRecording) return; // Need to be recording to capture full browser window
    fullBrowserShotButton.disabled = true;
    fullBrowserShotButton.textContent = "Capturing...";
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      const imageCapture = new ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const dataUrl = canvas.toDataURL("image/png");
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      chrome.runtime.sendMessage({
        command: "add_external_screenshot",
        data: { dataUrl },
      });
    } catch (e) {
      alert("Full browser capture failed: " + e.message);
    }
    setTimeout(() => {
      if (isRecording) {
        fullBrowserShotButton.disabled = false;
        fullBrowserShotButton.textContent = "Full Browser Screenshot";
      }
    }, 600);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // UI updates actively pushed by background script or forced screen recording stop
    if (message.command === "update_ui") {
      console.log(
        "Side Panel: Received UI update from background script.",
        message.data
      );
      updateUI(message.data);
      sendResponse({ success: true });
    } else if (message.command === "switch_to_editor") {
      switchToEditorMode(message.data);
      sendResponse({ success: true });
    } else if (message.command === "export_progress") {
      console.log("Side Panel: Received export progress update.", message.data);
      const { current, total, status } = message.data;
      if (total > 0) {
        const percentage = Math.round((current / total) * 100);
        statusMessage.textContent = `Exporting: ${current}/${total} (${percentage}%) - ${status}`;
      } else {
        statusMessage.textContent = status || "Exporting...";
      }
      sendResponse({ success: true });
    } else if (message.command === "force_stop_screen_recording") {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        console.log("Side Panel: Force stop screen recording received.");
        stopScreenRecording();
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // ============= EDITOR MODE FUNCTIONS =============

  /**
   * Switch to Editor Mode
   */
  function switchToEditorMode(data) {
    console.log("Side Panel: Switching to editor mode.", data);
    console.log("Side Panel: Editor elements check:", {
      modeIndicator: modeIndicator,
      editorToolbar: editorToolbar,
      importJsonButton: importJsonButton,
      actionCountBadge: actionCountBadge,
    });

    // Enable editor mode
    isEditorMode = true;

    // Add editor-mode class to body to hide recorder-only elements
    document.body.classList.add("editor-mode");

    // Load actions in editor mode (not recording)
    const { actions, htmlCount } = data || {};
    updateUI({
      isRecording: false,
      actions: actions || [],
      htmlCount: htmlCount || 0,
      startUrl: "Editor Mode",
    });

    // Show editor UI elements
    if (modeIndicator) {
      modeIndicator.style.display = "block";
      console.log("Side Panel: Mode indicator shown");
    } else {
      console.error("Side Panel: Mode indicator element not found!");
    }

    if (editorToolbar) {
      editorToolbar.style.display = "flex";
      console.log("Side Panel: Editor toolbar shown");
    } else {
      console.error("Side Panel: Editor toolbar element not found!");
    }

    // Update status message (even though it will be hidden)
    statusMessage.textContent = "Editor Mode - Import, edit, or export actions";
    statusMessage.style.color = "#2196F3";
    statusMessage.className = "";

    // Update action count badge
    updateActionCountBadge(actions ? actions.length : 0);

    // Enable save button if there are actions
    if (saveButton) {
      saveButton.disabled = !actions || actions.length === 0;
    }
  }

  /**
   * Update action count badge
   */
  function updateActionCountBadge(count) {
    if (actionCountBadge) {
      actionCountBadge.textContent = `${count} action${count !== 1 ? "s" : ""}`;
    }
  }

  /**
   * Import Python Script file
   */
  function importPythonScript(scriptContent, fileName) {
    try {
      console.log("Side Panel: Importing Python script...", fileName);

      // Parse Python script to extract actions
      const importedActions = parsePythonScript(scriptContent);

      console.log(
        `Side Panel: Extracted ${importedActions.length} actions from Python script`
      );

      if (importedActions.length === 0) {
        throw new Error("No valid actions found in script");
      }

      // Send imported actions to background
      chrome.runtime
        .sendMessage({
          command: "import_actions",
          data: { actions: importedActions },
        })
        .then((response) => {
          if (response && response.success) {
            // Set editor mode BEFORE updating UI
            isEditorMode = true;
            document.body.classList.add("editor-mode");

            statusMessage.textContent = `✅ Imported ${importedActions.length} actions from ${fileName}`;
            statusMessage.style.color = "#2ecc71";

            // Update UI with imported actions (now with isEditorMode = true)
            updateUI({
              isRecording: false,
              actions: importedActions,
              htmlCount: 0,
              startUrl: "Imported Script",
            });

            updateActionCountBadge(importedActions.length);

            // Show editor toolbar
            if (editorToolbar) editorToolbar.style.display = "flex";
            if (modeIndicator) modeIndicator.style.display = "block";

            console.log(
              "Side Panel: Editor mode enabled, Save button disabled =",
              saveButton.disabled
            );
          } else {
            throw new Error(response?.message || "Failed to import actions");
          }
        })
        .catch((err) => {
          console.error("Side Panel: Error importing actions:", err);
          statusMessage.textContent = `❌ Import failed: ${err.message}`;
          statusMessage.style.color = "#e74c3c";
        });
    } catch (error) {
      console.error("Side Panel: Error parsing Python script:", error);
      statusMessage.textContent = `❌ Import error: ${error.message}`;
      statusMessage.style.color = "#e74c3c";
    }
  }

  /**
   * Parse Python script to extract actions
   */
  function parsePythonScript(scriptContent) {
    const actions = [];
    const lines = scriptContent.split("\n");
    let stepNumber = 1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Skip comments and empty lines
      if (!line || line.startsWith("#")) continue;

      const action = parsePythonLine(line, stepNumber);
      if (action) {
        actions.push(action);
        stepNumber++;
      }
    }

    return actions;
  }

  /**
   * Parse a single Python line to extract action
   */
  function parsePythonLine(line, stepNumber) {
    const action = {
      step: stepNumber,
      timestamp: Date.now(),
    };

    // self.click(selector)
    if (line.includes(".click(")) {
      const match = line.match(/\.click\(["']([^"']+)["']/);
      if (match) {
        action.type = "Click";
        action.selector = match[1];
        action.selectorType = "XPath";
        return action;
      }
    }

    // self.type(selector, text)
    if (line.includes(".type(")) {
      const match = line.match(/\.type\(["']([^"']+)["'],\s*["']([^"']+)["']/);
      if (match) {
        action.type = "Input";
        action.selector = match[1];
        action.value = match[2];
        action.selectorType = "XPath";
        return action;
      }
    }

    // self.send_keys(selector, text) or self.send_keys(selector, Keys.XXX)
    if (line.includes(".send_keys(")) {
      const textMatch = line.match(
        /\.send_keys\(["']([^"']+)["'],\s*["']([^"']+)["']/
      );
      if (textMatch) {
        action.type = "Input";
        action.selector = textMatch[1];
        action.value = textMatch[2];
        action.selectorType = "XPath";
        return action;
      }

      // Handle Keys constants like Keys.ENTER
      const keysMatch = line.match(
        /\.send_keys\(["']([^"']+)["'],\s*Keys\.(\w+)/
      );
      if (keysMatch) {
        action.type = "KeyPress";
        action.selector = keysMatch[1];
        action.value = keysMatch[2]; // ENTER, TAB, etc.
        action.selectorType = "XPath";
        return action;
      }
    }

    // self.select_option_by_text(selector, text)
    if (line.includes(".select_option_by_text(")) {
      const match = line.match(
        /\.select_option_by_text\(["']([^"']+)["'],\s*["']([^"']+)["']/
      );
      if (match) {
        action.type = "Select";
        action.selector = match[1];
        action.value = match[2];
        action.selectorType = "XPath";
        return action;
      }
    }

    // self.open(url)
    if (line.includes(".open(")) {
      const match = line.match(/\.open\(["']([^"']+)["']/);
      if (match) {
        action.type = "Navigate";
        action.url = match[1];
        action.selector = "URL";
        action.selectorType = "URL";
        return action;
      }
    }

    // self.scroll_to(selector)
    if (line.includes(".scroll_to(")) {
      const match = line.match(/\.scroll_to\(["']([^"']+)["']/);
      if (match) {
        action.type = "Scroll";
        action.selector = match[1];
        action.selectorType = "XPath";
        return action;
      }
    }

    return null;
  }

  // Import button click handler
  if (importJsonButton) {
    console.log("✅ Import button found, adding click listener");
    importJsonButton.addEventListener("click", () => {
      console.log("🔵 Import button clicked!");
      console.log("jsonFileInput element:", jsonFileInput);
      if (jsonFileInput) {
        jsonFileInput.click();
        console.log("✅ File input clicked");
      } else {
        console.error("❌ jsonFileInput not found!");
      }
    });
  } else {
    console.error("❌ Import button not found!");
  }

  // File input change handler
  if (jsonFileInput) {
    console.log("✅ File input found, adding change listener");
    jsonFileInput.addEventListener("change", (event) => {
      console.log("🔵 File input changed!");
      console.log("Selected files:", event.target.files);

      const file = event.target.files[0];
      if (!file) {
        console.log("❌ No file selected");
        return;
      }

      console.log(
        "📄 File selected:",
        file.name,
        "Size:",
        file.size,
        "Type:",
        file.type
      );

      const reader = new FileReader();
      reader.onload = (e) => {
        console.log("📖 File loaded, length:", e.target.result.length);
        try {
          const pythonScript = e.target.result;
          importPythonScript(pythonScript, file.name);
        } catch (error) {
          console.error("Side Panel: Error reading Python file:", error);
          statusMessage.textContent = `❌ Invalid Python file: ${error.message}`;
          statusMessage.style.color = "#e74c3c";
        }
      };
      reader.onerror = (e) => {
        console.error("❌ File reader error:", e);
      };
      reader.readAsText(file);

      // Reset file input
      event.target.value = "";
    });
  } else {
    console.error("❌ File input not found!");
  }

  document.addEventListener("DOMContentLoaded", () => {
    console.log("Side Panel: DOM loaded. Requesting current state."); // Request current state from background script after initialization

    // Initialize HTML capture settings
    updateHtmlCaptureConfig();

    // Check if there's a pending editor mode request
    chrome.storage.local.get(
      ["pendingEditorMode", "editorModeData"],
      (result) => {
        if (result.pendingEditorMode) {
          console.log("Side Panel: Found pending editor mode request");
          // Switch to editor mode
          switchToEditorMode(result.editorModeData || {});
          // Clear the pending flag
          chrome.storage.local.remove(["pendingEditorMode", "editorModeData"]);
        }
      }
    );

    chrome.runtime
      .sendMessage({ command: "request_current_state" })
      .then((response) => {
        if (response) {
          updateUI(response);
        } else {
          updateUI({ isRecording: false, actions: [], htmlCount: 0 });
        }
      })
      .catch((e) =>
        console.error("Side Panel: Error requesting initial state:", e)
      );
  });

  // Handle browser X button closure
  window.addEventListener("beforeunload", (event) => {
    console.log("Side Panel: beforeunload event - browser X button pressed");
    console.log("isRecording:", isRecording);

    // Just log, the actual confirmation will be handled by background.js
    // through port disconnect listener
  });

  // Additional listener for page visibility (more reliable for side panel closure)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && isRecording) {
      console.log("Side Panel: Visibility changed to hidden");
      // Don't stop recording here - let beforeunload handle it
    }
  });

  console.log("Side Panel Initialized."); // Initialization complete
} else {
  console.log("Side Panel already initialized. Skipping re-initialization."); // Already initialized, skip
}
