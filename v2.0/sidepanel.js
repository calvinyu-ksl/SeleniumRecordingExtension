/**
 * sidepanel.js
 * Manages the UI and logic for the extension's side panel.
 * - Displays recorded actions.
 * - Handles user interactions like deleting actions, saving, and canceling.
 */

// Guard to prevent the script from being initialized multiple times, which can cause errors.
if (typeof window.sidePanelInitialized === 'undefined') {
    window.sidePanelInitialized = true;

    // --- DOM Elements ---
    const actionsList = document.getElementById('actions-list');
    const saveButton = document.getElementById('save-button');
    const cancelButton = document.getElementById('cancel-button');
    const statusMessage = document.getElementById('status-message');
    const htmlCountSpan = document.getElementById('html-count');
    const startUrlSpan = document.getElementById('start-url');
    const captureHtmlButton = document.getElementById('capture-html-button');
    const screenRecordButton = document.getElementById('screen-record-button');
    const fullBrowserShotButton = document.getElementById('full-browser-shot-button');

    let isRecording = false;
    let mediaRecorder = null;
    let recordedChunks = [];
    let recordStart = null;
    let timerInterval = null;

    /**
     * Renders the list of recorded actions in the side panel.
     * @param {Array<Object>} actions - The array of action objects to display.
     */
    function renderActions(actions = []) {
        actionsList.innerHTML = ''; // Clear previous list

        if (actions.length === 0) {
            const placeholder = document.createElement('div');
            placeholder.className = 'action-item-placeholder';
            placeholder.textContent = 'No actions recorded yet. Interact with the page to begin.';
            actionsList.appendChild(placeholder);
            return;
        }

        actions.forEach(action => {
            const item = document.createElement('div');
            item.className = 'action-item';
            item.dataset.step = action.step;

            const content = document.createElement('div');
            content.className = 'action-content';

            const step = document.createElement('span');
            step.className = 'action-step';
            step.textContent = `${action.step}.`;

            const type = document.createElement('span');
            type.className = 'action-type';
            type.textContent = action.type;

            const details = document.createElement('span');
            details.className = 'action-details';
            
            let detailText = '';
            if (action.type === 'HTML_Capture') {
                item.classList.add('html-capture-item');
                detailText = 'Page source captured';
            } else if (action.selector) {
                detailText = `${action.selectorType}: ${action.selector}`;
            }
            if (action.value && action.type !== 'HTML_Capture') {
                detailText += ` | Value: "${action.value}"`;
            }
            details.textContent = detailText;
            details.title = detailText;

            const deleteButton = document.createElement('button');
            deleteButton.className = 'delete-button';
            deleteButton.textContent = '✖';
            deleteButton.title = `Delete step ${action.step}`;
            deleteButton.addEventListener('click', (e) => {
                e.stopPropagation();
                // Pass the action type and recordingId so handler can require confirmation
                // for screen markers and target the correct video for deletion.
                handleDeleteAction(action.step, action.type, action.recordingId || null);
            });

            content.appendChild(step);
            content.appendChild(type);
            content.appendChild(details);
            item.appendChild(content);
            item.appendChild(deleteButton);
            actionsList.appendChild(item);
        });
    }

    /**
     * Updates the entire UI state based on data from the background script.
     * @param {Object} data - The state data.
     */
    function updateUI(data) {
        if (!data) return;

        isRecording = data.isRecording;
        
        renderActions(data.actions || []);
        htmlCountSpan.textContent = data.htmlCount || 0;
        if (data.startUrl) {
            startUrlSpan.textContent = data.startUrl;
            startUrlSpan.href = data.startUrl;
        }

        saveButton.disabled = !isRecording || (data.actions && data.actions.length === 0);
        cancelButton.disabled = !isRecording;
        captureHtmlButton.disabled = !isRecording;
    if (fullBrowserShotButton) fullBrowserShotButton.disabled = !isRecording;


        if (isRecording) {
            statusMessage.textContent = 'Recording in progress...';
            statusMessage.classList.remove('status-stopped');
            statusMessage.classList.add('status-recording');
        } else {
            statusMessage.textContent = 'Recording stopped.';
            statusMessage.classList.remove('status-recording');
            statusMessage.classList.add('status-stopped');
        }
    }

    // --- Event Handlers ---

    function handleDeleteAction(step, actionType, recordingId) {
        if (!isRecording) return;
        // If deleting a screen recording marker, ask for confirmation first
        if (actionType === 'ScreenRecordingStart' || actionType === 'ScreenRecordingStop') {
            const promptMsg = `Are you sure you want to delete the screen recording marker at step ${step}? This will remove the associated recorded video only.`;
            if (!confirm(promptMsg)) return;
        }
        console.log(`Side Panel: Requesting to delete action step ${step}`);
        const payload = { step };
        if (recordingId) payload.recordingId = recordingId;
        chrome.runtime.sendMessage({ command: 'delete_action', data: payload })
            .catch(e => console.error("Side Panel: Error sending delete request:", e));
    }

    function handleSave() {
        if (!isRecording) return;
        console.log("Side Panel: Save & Export button clicked.");
        saveButton.disabled = true;
        saveButton.textContent = 'Saving...';
        chrome.runtime.sendMessage({ command: 'save_export' })
            .finally(() => {
                saveButton.textContent = 'Save & Export';
            });
    }

    function handleCancel() {
        if (!isRecording) return;
        console.log("Side Panel: Cancel button clicked.");
        if (confirm("Are you sure you want to cancel this recording? All recorded data will be lost.")) {
            chrome.runtime.sendMessage({ command: 'cancel_recording' })
                .catch(e => console.error("Side Panel: Error sending cancel request:", e));
        }
    }

    function handleCaptureHtml() {
        if (!isRecording) return;
        console.log("Side Panel: Manual HTML capture button clicked.");
        captureHtmlButton.disabled = true;
        chrome.runtime.sendMessage({ command: 'capture_html' })
            .finally(() => {
                setTimeout(() => {
                    if (isRecording) captureHtmlButton.disabled = false;
                }, 500);
            });
    }

    function formatTime(ms){
        const total = Math.floor(ms/1000); const m = String(Math.floor(total/60)).padStart(2,'0'); const s = String(total%60).padStart(2,'0'); return `${m}:${s}`;
    }
    function updateTimer(){
        if(!recordStart) return; const elapsed = Date.now()-recordStart; screenRecordButton.querySelector('.timer').textContent = formatTime(elapsed);
    }
    async function startScreenRecording(){
        try {
            chrome.runtime.sendMessage({ command: 'screen_recording_start' }).catch(()=>{});
            recordedChunks = [];
            const stream = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:30}, audio:true });
            stream.getVideoTracks().forEach(t=>t.addEventListener('ended', stopScreenRecording));
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
            mediaRecorder.ondataavailable = e=>{ if(e.data && e.data.size) recordedChunks.push(e.data); };
            mediaRecorder.onstop = () => {
                (async () => {
                    try {
                        const ts = new Date().toISOString().replace(/[:.]/g,'-');
                        const fileName = `recording_${ts}.webm`;
                        const blob = new Blob(recordedChunks, { type: 'video/webm' });
                        const arrayBuffer = await blob.arrayBuffer();
                        const chunkSize = 256 * 1024; // 256KB
                        const total = Math.ceil(arrayBuffer.byteLength / chunkSize);
                        const id = 'vid_' + Date.now();
                        for (let i=0;i<total;i++) {
                            const part = arrayBuffer.slice(i*chunkSize, (i+1)*chunkSize);
                            const b64 = arrayBufferToBase64(part);
                            await sendVideoChunk({ id, fileName, index: i, total, chunkBase64: b64 });
                        }
                        chrome.runtime.sendMessage({ command: 'screen_recording_stop', data: { fileName } }).catch(()=>{});
                        console.log('Side Panel: Video chunks sent:', fileName, 'total parts:', total);
                    } catch(err) {
                        console.warn('Side Panel: Failed to send video to background', err);
                        chrome.runtime.sendMessage({ command: 'screen_recording_stop' }).catch(()=>{});
                    }
                })();
            };
            mediaRecorder.start();
            recordStart = Date.now();
            screenRecordButton.classList.add('recording');
            screenRecordButton.innerHTML = 'Stop Screen Capture <span class="timer">00:00</span>';
            updateTimer();
            timerInterval = setInterval(updateTimer,1000);
        } catch(err){
            alert('Screen capture failed: '+ err.message);
            resetScreenRecordButton();
        }
    }

    function arrayBufferToBase64(buf){
        let binary = '';
        const bytes = new Uint8Array(buf);
        const len = bytes.length;
        for (let i=0;i<len;i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }
    function sendVideoChunk(payload){
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ command: 'video_chunk', data: payload }, () => resolve());
        });
    }
    function stopScreenRecording(){
        if(timerInterval){ clearInterval(timerInterval); timerInterval = null; }
        if(mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch(e) { chrome.runtime.sendMessage({ command: 'screen_recording_stop' }).catch(()=>{}); } }
        else { chrome.runtime.sendMessage({ command: 'screen_recording_stop' }).catch(()=>{}); }
        mediaRecorder=null; recordStart=null; resetScreenRecordButton();
    }
    function resetScreenRecordButton(){
        screenRecordButton.classList.remove('recording');
        screenRecordButton.textContent = 'Start Screen Capture';
    }
    screenRecordButton?.addEventListener('click', ()=>{
        if(!mediaRecorder || mediaRecorder.state === 'inactive') startScreenRecording(); else stopScreenRecording();
    });

    // --- Initialization ---

    saveButton.addEventListener('click', handleSave);
    cancelButton.addEventListener('click', handleCancel);
    captureHtmlButton.addEventListener('click', handleCaptureHtml);
    fullBrowserShotButton?.addEventListener('click', async ()=>{
        if(!isRecording) return;
        fullBrowserShotButton.disabled = true;
        fullBrowserShotButton.textContent = 'Capturing...';
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
            const track = stream.getVideoTracks()[0];
            const imageCapture = new ImageCapture(track);
            const bitmap = await imageCapture.grabFrame();
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap,0,0);
            const dataUrl = canvas.toDataURL('image/png');
            track.stop(); stream.getTracks().forEach(t=>t.stop());
            chrome.runtime.sendMessage({ command:'add_external_screenshot', data:{ dataUrl } });
        } catch(e){ alert('Full browser capture failed: '+ e.message); }
        setTimeout(()=>{ if(isRecording){ fullBrowserShotButton.disabled=false; fullBrowserShotButton.textContent='Full Browser Screenshot'; } },600);
    });


    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.command === 'update_ui') {
            console.log("Side Panel: Received UI update from background script.", message.data);
            updateUI(message.data);
            sendResponse({success: true});
        }
        else if (message.command === 'force_stop_screen_recording') {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                console.log('Side Panel: Force stop screen recording received.');
                stopScreenRecording();
            }
            sendResponse({ success: true });
        }
        return true;
    });

    document.addEventListener('DOMContentLoaded', () => {
        console.log("Side Panel: DOM loaded. Requesting current state.");
        chrome.runtime.sendMessage({ command: 'request_current_state' })
            .then(response => {
                if (response) {
                    updateUI(response);
                } else {
                    updateUI({ isRecording: false, actions: [], htmlCount: 0 });
                }
            })
            .catch(e => console.error("Side Panel: Error requesting initial state:", e));
    });

    window.addEventListener('beforeunload', () => {
        if (isRecording) {
            chrome.runtime.sendMessage({ command: 'stop_recording_internal' })
                .catch(e => console.error("Side Panel: Error informing background of closure:", e));
        }
    });

    console.log("Side Panel Initialized.");
} else {
    console.log("Side Panel already initialized. Skipping re-initialization.");
}
