// Optimized export function for handling large numbers of HTML files

function performExportOptimized(sendResponse) { // Export ZIP: flush inputs first, then assemble script, capture HTML/CSS/screenshots/videos/uploads
    (async () => {
        try {
            // Send initial export status
            chrome.runtime.sendMessage({ command: 'export_progress', data: { current: 0, total: 0, status: 'Initializing export...' } }).catch(() => {});
            
            await flushAllPendingInputs();
            
            if (typeof JSZip === 'undefined') { 
                sendResponse && sendResponse({ success: false, message: "JSZip not loaded." }); 
                return; 
            }
            
            finalizeIncomingVideos();
            
            // Debug: output video info summary
            try {
                const info = recordedVideos.map(v => ({ fileName: v.fileName, recordingId: v.recordingId, chunks: Array.isArray(v.chunks) ? v.chunks.length : 0 }));
                console.log('Background: recordedVideos for export:', info);
            } catch (e) { 
                console.warn('Background: Failed to log recordedVideos info', e); 
            }

            // Read custom upload directory from storage
            const storageResult = await chrome.storage.local.get(['selbas_upload_dir']).catch(() => ({}));
            const uploadDir = storageResult && storageResult.selbas_upload_dir ? storageResult.selbas_upload_dir : null;
            
            // Clean up consecutive duplicate Input actions before generating script
            const cleanedActions = removeDuplicateInputActions(recordedActions);
            console.log(`Background: Original actions: ${recordedActions.length}, Cleaned actions: ${cleanedActions.length}`);
            
            // Log Input actions for debugging
            const inputActions = cleanedActions.filter(a => a && a.type === 'Input');
            console.log(`Background: Input actions in cleaned list:`, inputActions.map(a => ({
                selector: a.selector,
                value: a.value,
                timestamp: a.timestamp,
                source: a.source
            })));

            // Calculate total files for progress tracking
            const totalFiles = 1 + capturedHTMLs.length + capturedScreenshots.length + (Array.isArray(uploadedFiles) ? uploadedFiles.length : 0) + recordedVideos.length;
            let processedFiles = 0;
            
            function updateProgress(status) {
                processedFiles++;
                chrome.runtime.sendMessage({ 
                    command: 'export_progress', 
                    data: { 
                        current: processedFiles, 
                        total: totalFiles, 
                        status: status || `Processing file ${processedFiles}/${totalFiles}...` 
                    } 
                }).catch(() => {});
            }
            
            // Helper function for batch processing to avoid memory issues
            async function processBatch(items, batchSize, processFn) {
                for (let i = 0; i < items.length; i += batchSize) {
                    const batch = items.slice(i, i + batchSize);
                    await Promise.allSettled(batch.map((item, idx) => processFn(item, i + idx)));
                    
                    // Small delay between batches to prevent overwhelming the browser
                    if (i + batchSize < items.length) {
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                        // Force garbage collection hint (if available)
                        if (global && global.gc) {
                            global.gc();
                        }
                    }
                }
            }
            
            const script = generateSeleniumBaseScript({ uploadDir }, cleanedActions);
            const zip = new JSZip();
            zip.file("test_recorded_script.py", script);
            updateProgress('Generated Python script');
            
            // Process HTML files in batches to avoid memory issues
            if (capturedHTMLs.length > 0) {
                chrome.runtime.sendMessage({ 
                    command: 'export_progress', 
                    data: { 
                        current: processedFiles, 
                        total: totalFiles, 
                        status: `Processing ${capturedHTMLs.length} HTML files in batches...` 
                    } 
                }).catch(() => {});
                
                const batchSize = Math.min(10, Math.max(1, Math.floor(50 / Math.max(1, capturedHTMLs.length / 100)))); // Adaptive batch size
                console.log(`Background: Processing ${capturedHTMLs.length} HTML files with batch size ${batchSize}`);
                
                await processBatch(capturedHTMLs, batchSize, async (h, idx) => {
                    try {
                        if (!h || typeof h.html !== 'string') {
                            updateProgress(`Processed HTML capture ${idx + 1}`);
                            return;
                        }
                        const pageUrl = h.url || startURL || '';
                        
                        // For very large HTML files, skip CSS inlining to save memory
                        let processedHtml = h.html;
                        if (h.html.length < 500000) { // Only inline CSS for files smaller than 500KB
                            try {
                                processedHtml = await inlineCssIntoHtml(h.html, pageUrl);
                            } catch (e) {
                                console.warn(`Background: CSS inlining failed for capture ${idx + 1}, using original HTML:`, e);
                                processedHtml = h.html;
                            }
                        } else {
                            console.log(`Background: Skipping CSS inlining for large HTML file ${idx + 1} (${(h.html.length/1024).toFixed(1)}KB)`);
                        }
                        
                        zip.file(`capture_${idx + 1}.html`, processedHtml);
                        updateProgress(`Processed HTML capture ${idx + 1}`);
                    } catch (e) {
                        console.warn('Background: failed to process HTML capture', idx + 1, e);
                        if (h && h.html) {
                            zip.file(`capture_${idx + 1}.html`, h.html);
                        }
                        updateProgress(`Processed HTML capture ${idx + 1} (with errors)`);
                    }
                });
            }
            
            // Process screenshots in batches
            if (capturedScreenshots.length > 0) {
                chrome.runtime.sendMessage({ 
                    command: 'export_progress', 
                    data: { 
                        current: processedFiles, 
                        total: totalFiles, 
                        status: `Processing ${capturedScreenshots.length} screenshots...` 
                    } 
                }).catch(() => {});
                
                await processBatch(capturedScreenshots, 5, async (s, idx) => {
                    try {
                        if (!s || !s.dataUrl) {
                            updateProgress(`Processed screenshot ${idx + 1}`);
                            return;
                        }
                        const filename = `screenshot_${idx + 1}.png`;
                        const response = await fetch(s.dataUrl);
                        const buf = await response.arrayBuffer();
                        zip.file(filename, buf);
                        updateProgress(`Processed screenshot ${idx + 1}`);
                    } catch (e) {
                        console.warn("Background: screenshot processing failed:", e);
                        updateProgress(`Processed screenshot ${idx + 1} (failed)`);
                    }
                });
            }
            
            // Process uploaded files in batches
            const uploads = Array.isArray(uploadedFiles) ? uploadedFiles : [];
            if (uploads.length > 0) {
                chrome.runtime.sendMessage({ 
                    command: 'export_progress', 
                    data: { 
                        current: processedFiles, 
                        total: totalFiles, 
                        status: `Processing ${uploads.length} upload files...` 
                    } 
                }).catch(() => {});
                
                await processBatch(uploads, 3, async (f) => {
                    try {
                        if (!f || !f.name || !f.dataUrl) {
                            updateProgress(`Processed upload file`);
                            return;
                        }
                        const safeName = String(f.name).replace(/[\\/:*?"<>|]/g, '_');
                        const fname = `uploads/${safeName}`;
                        const response = await fetch(f.dataUrl);
                        const buf = await response.arrayBuffer();
                        zip.file(fname, buf);
                        updateProgress(`Processed upload: ${safeName}`);
                    } catch (e) {
                        console.warn('Background: upload file add failed:', e);
                        updateProgress(`Processed upload file (failed)`);
                    }
                });
            }
            
            // Process videos
            if (recordedVideos.length > 0) {
                chrome.runtime.sendMessage({ 
                    command: 'export_progress', 
                    data: { 
                        current: processedFiles, 
                        total: totalFiles, 
                        status: `Processing ${recordedVideos.length} video files...` 
                    } 
                }).catch(() => {});
                
                recordedVideos.forEach(v => {
                    try {
                        const size = v.chunks.reduce((s, c) => s + c.length, 0);
                        const merged = new Uint8Array(size);
                        let offset = 0; 
                        v.chunks.forEach(c => { 
                            merged.set(c, offset); 
                            offset += c.length; 
                        });
                        let fname = v.fileName || `recording_${Date.now()}.webm`;
                        let counter = 1; 
                        while (zip.file(fname)) {
                            fname = fname.replace(/(\.webm)$/i, `_${counter++}$1`);
                        }
                        zip.file(fname, merged);
                        updateProgress(`Processed video: ${fname}`);
                    } catch (e) { 
                        console.warn('Background: failed to add video', e);
                        updateProgress(`Processed video file (failed)`);
                    }
                });
            }
            
            chrome.runtime.sendMessage({ 
                command: 'export_progress', 
                data: { 
                    current: totalFiles, 
                    total: totalFiles, 
                    status: 'Generating ZIP file...' 
                } 
            }).catch(() => {});
            
            const blob = await zip.generateAsync({ 
                type: "blob",
                compression: "DEFLATE",
                compressionOptions: {
                    level: 6
                }
            });
            
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('Failed to read ZIP blob.'));
                reader.readAsDataURL(blob);
            });
            
            chrome.runtime.sendMessage({ 
                command: 'export_progress', 
                data: { 
                    current: totalFiles, 
                    total: totalFiles, 
                    status: 'Downloading ZIP file...' 
                } 
            }).catch(() => {});
            
            const downloadId = await chrome.downloads.download({ 
                url: dataUrl, 
                filename: "seleniumbase_recording.zip", 
                saveAs: true 
            });
            
            try { 
                ignoredDownloadIds.add(downloadId); 
            } catch (e) { }
            
            chrome.runtime.sendMessage({ 
                command: 'export_progress', 
                data: { 
                    current: totalFiles, 
                    total: totalFiles, 
                    status: 'Export completed!' 
                } 
            }).catch(() => {});
            
            sendResponse && sendResponse({ success: true });
            resetRecordingState(true);
            
        } catch (err) { 
            console.error('Background: Export failed:', err);
            chrome.runtime.sendMessage({ 
                command: 'export_progress', 
                data: { 
                    current: 0, 
                    total: 0, 
                    status: 'Export failed: ' + (err.message || String(err)) 
                } 
            }).catch(() => {});
            sendResponse && sendResponse({ 
                success: false, 
                message: err && err.message ? err.message : String(err) 
            }); 
            resetRecordingState(true); 
        }
    })().catch(err => {
        console.error('Background: Async export wrapper failed:', err);
        sendResponse && sendResponse({ 
            success: false, 
            message: 'Export initialization failed: ' + (err.message || String(err)) 
        });
        resetRecordingState(true);
    });
}