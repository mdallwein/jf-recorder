(() => {
  /************************************************************
   * AIRTABLE / MINITEXTENSIONS GUARD
   ************************************************************/
  if (window.__JF_RECORDER_INIT__) {
    console.warn("JF Recorder already initialized — skipping re-init.");
    return;
  }
  window.__JF_RECORDER_INIT__ = true;

  /************************************************************
   * CONFIG
   ************************************************************/
  const ZAPIER_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/969295/2xvqqx7/";
  const firebaseConfig = {
    apiKey: "AIzaSyANNgPBST98x3oVXi-mF-lt7z7kkSp0teQ",
    authDomain: "jf-recordings.firebaseapp.com",
    projectId: "jf-recordings",
    storageBucket: "jf-recordings.firebasestorage.app",
    messagingSenderId: "945026048865",
    appId: "1:945026048865:web:a0adff79cb4c23c9825b20",
    measurementId: "G-E2VZ7XPJRG"
  };
  const STORAGE_BASE_PATH = "jazzfest_adjudication";

  /************************************************************
   * SMALL UTILS
   ************************************************************/
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function domReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  async function waitForFirebaseCompat(maxMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (window.firebase && typeof window.firebase.initializeApp === "function") return true;
      await sleep(50);
    }
    return false;
  }

  function safeGet(id) {
    return document.getElementById(id);
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  /************************************************************
   * INIT (DOM + Firebase must exist)
   ************************************************************/
  domReady(async () => {
    // Wait for firebase compat scripts (since Airtable/GH ordering varies)
    const hasFirebase = await waitForFirebaseCompat();
    if (!hasFirebase) {
      console.error("Firebase compat not found. Ensure firebase-app-compat and firebase-storage-compat are loaded BEFORE jf-recorder.js");
      return;
    }

    /************************************************************
     * FIREBASE INIT (safe for re-runs)
     ************************************************************/
    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
      }
    } catch (e) {
      // ignore "already exists" cases
      console.warn("Firebase init warning:", e?.message || e);
    }
    const storage = firebase.storage();

    /************************************************************
     * DOM (must exist in page)
     ************************************************************/
    const recordButton = safeGet("recordButton");
    const pauseButton = safeGet("pauseButton");
    const stopRecordingButton = safeGet("stopRecording");
    const resetButton = safeGet("resetButton");
    const submitButton = safeGet("submitButton");

    const audioPlayer = safeGet("audioPlayer");
    const audioPlayerContainer = safeGet("audioPlayerContainer");
    const recordingDurationEl = safeGet("recordingDuration");
    const progressBar = safeGet("uploadProgressBar");
    const statusPill = safeGet("statusPill");

    // If you’re testing in a bare page, submitButton may not exist — that’s OK.
    if (!recordButton || !pauseButton || !stopRecordingButton || !resetButton || !audioPlayer || !audioPlayerContainer || !recordingDurationEl) {
      console.error("Recorder DOM missing. Required ids: recordButton, pauseButton, stopRecording, resetButton, audioPlayer, audioPlayerContainer, recordingDuration");
      return;
    }


    /************************************************************
     * OVERALL RATING CALCULATION (Average of rating1–rating5 -> overallRating)
     * FIX: This must run AFTER the DOM exists (inside domReady), otherwise
     *      listeners attach to null elements and nothing updates.
     ************************************************************/
    function updateOverallRating() {
      const ids = ["rating1","rating2","rating3","rating4","rating5"];
      let total = 0;
      let count = 0;

      ids.forEach(id => {
        const el = safeGet(id);
        if (!el) return;

        // Handle <input>, <select>, etc. Treat blanks as "not scored"
        const raw = (el.value ?? "").toString().trim();
        if (raw === "") return;

        const v = parseFloat(raw);
        if (!isNaN(v)) {
          total += v;
          count++;
        }
      });

      const overall = safeGet("overallRating");
      if (!overall) return;

      if (count > 0) {
        const avg = total / count;
        overall.value = Number.isInteger(avg) ? String(avg) : avg.toFixed(1);
      } else {
        overall.value = "";
      }
    }

    ["rating1","rating2","rating3","rating4","rating5"].forEach(id => {
      const el = safeGet(id);
      if (!el) return;
      el.addEventListener("input", updateOverallRating);
      el.addEventListener("change", updateOverallRating);
    });

    // Run once in case the form is pre-filled
    updateOverallRating();

    /************************************************************
     * RECORDING STATE (Pause/Resume)
     ************************************************************/
    let mediaRecorder = null;
    let mediaStream = null;
    let audioChunks = [];
    let lastAudioBlob = null;

    let isRecording = false;
    let isPaused = false;

    let startTime = 0;     // recording started
    let pausedAt = 0;      // when pause began
    let totalPausedMs = 0; // accumulated pause time
    let durationInterval = null;

    /************************************************************
     * IDLE POPUP (optional; safe if Bootstrap not present)
     ************************************************************/
    let popupTimeout = null;
    let autoSubmitTimeout = null;

    const popupOverlay = document.createElement("div");
    popupOverlay.id = "overlay";
    popupOverlay.style.cssText =
      "display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:999;";

    const popupBox = document.createElement("div");
    popupBox.id = "popup";
    popupBox.style.cssText =
      "display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:320px;padding:20px;background:#fff;box-shadow:0 4px 8px rgba(0,0,0,.2);border-radius:10px;text-align:center;z-index:1000;";
    popupBox.innerHTML = `
      <h3 style="margin:0 0 12px;color:#013c65;font-family:gala,sans-serif;font-weight:800;">Are you still working?</h3>
      <p style="font-size:12px;margin:0 0 16px;">If not, we can stop and submit automatically.</p>
      <button id="yesButton" style="margin-right:8px;">Yes</button>
      <button id="noButton">No, submit now</button>
    `;

    document.body.appendChild(popupOverlay);
    document.body.appendChild(popupBox);

    const yesButton = popupBox.querySelector("#yesButton");
    const noButton = popupBox.querySelector("#noButton");

    function armIdlePopup() {
      clearTimeout(popupTimeout);
      clearTimeout(autoSubmitTimeout);

      popupTimeout = setTimeout(() => {
        popupOverlay.style.display = "block";
        popupBox.style.display = "block";

        autoSubmitTimeout = setTimeout(async () => {
          try {
            if (isRecording) await stopRecording();
            if (typeof submitFormAndRecording === "function") await submitFormAndRecording();
          } catch (e) {
            console.error("Auto-submit error:", e);
          } finally {
            hideIdlePopup();
          }
        }, 10 * 1000);
      }, 29 * 60 * 1000);
    }

    function hideIdlePopup() {
      popupOverlay.style.display = "none";
      popupBox.style.display = "none";
      clearTimeout(autoSubmitTimeout);
    }

    yesButton.addEventListener("click", () => {
      hideIdlePopup();
      armIdlePopup();
    });

    noButton.addEventListener("click", async () => {
      try {
        if (isRecording) await stopRecording();
        if (typeof submitFormAndRecording === "function") await submitFormAndRecording();
      } catch (e) {
        console.error("Submit-now error:", e);
      } finally {
        hideIdlePopup();
      }
    });

    armIdlePopup();

    /************************************************************
     * HELPERS
     ************************************************************/
    function setStatus(text) { setText(statusPill, text); }

    function setProgress(pct) {
      if (!progressBar) return;
      const clamped = Math.max(0, Math.min(100, pct));
      progressBar.style.width = clamped + "%";
      progressBar.textContent = clamped + "%";
    }

    function pad2(n) { return String(n).padStart(2, "0"); }

    // Timer freezes when paused
    function updateRecordingDuration() {
      if (!isRecording) return;
      if (isPaused) return;
      const elapsed = Date.now() - startTime - totalPausedMs;
      const minutes = Math.floor(elapsed / 60000);
      const seconds = Math.floor((elapsed % 60000) / 1000);
      const centis = Math.floor((elapsed % 1000) / 10);
      recordingDurationEl.textContent = `${minutes}:${pad2(seconds)}:${pad2(centis)}`;
    }

    function safeSlug(s) {
      return String(s || "")
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 80) || "unknown";
    }

    function fileExtForMime(mime) {
      if (!mime) return "webm";
      if (mime.includes("ogg")) return "ogg";
      if (mime.includes("webm")) return "webm";
      return "webm";
    }

    function getPreferredMimeType() {
      const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
      for (const t of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
      }
      return "";
    }

    function buildAudioBlob() {
      if (!audioChunks.length) return null;
      const type = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : "audio/webm";
      return new Blob(audioChunks, { type });
    }


function triggerLocalDownload(blob, fileName) {
  try {
    // Most browsers require a user gesture; call this directly from a click/tap handler (e.g., Submit).
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "recording.webm";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (e) {}
      try { a.remove(); } catch (e) {}
    }, 1000);
    return true;
  } catch (e) {
    console.warn("Local download failed:", e);
    return false;
  }
}

function buildLocalFileName(blob) {
  const ensembleID = (safeGet("recordID")?.value || "").trim();
  const fname = (safeGet("fname")?.value || "").trim();
  const lname = (safeGet("lname")?.value || "").trim();

  const ext = fileExtForMime(blob?.type);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeEns = safeSlug(ensembleID);
  const safeAdj = safeSlug(fname + "_" + lname);

  // Example: 2026-03-04T18-22-10-123Z_12345_Jane_Doe.webm
  return `${stamp}_${safeEns}_${safeAdj}.${ext}`;
}

    function disableDuringSubmit(disabled) {
      if (submitButton) submitButton.disabled = disabled;
      recordButton.disabled = disabled;
      pauseButton.disabled = disabled;
      stopRecordingButton.disabled = disabled;
      resetButton.disabled = disabled;
    }

    function stopStreamTracks() {
      try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      mediaStream = null;
    }

    /************************************************************
     * UI DEFAULTS
     ************************************************************/
    pauseButton.style.display = "none";
    stopRecordingButton.style.display = "none";

    /************************************************************
     * RECORDING CONTROLS (Pause/Resume)
     ************************************************************/
    recordButton.addEventListener("click", async () => {
      armIdlePopup();
      if (!isRecording) await startRecording();
    });

    pauseButton.addEventListener("click", () => {
      armIdlePopup();
      if (!mediaRecorder) return;

      // Pause
      if (isRecording && !isPaused && mediaRecorder.state === "recording") {
        mediaRecorder.pause();
        isPaused = true;
        pausedAt = Date.now();

        // stop pulsing while paused
        recordButton.classList.remove("recording");

        pauseButton.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
        setStatus("Paused");
        return;
      }

      // Resume
      if (isRecording && isPaused && mediaRecorder.state === "paused") {
        mediaRecorder.resume();
        if (pausedAt) totalPausedMs += (Date.now() - pausedAt);
        pausedAt = 0;
        isPaused = false;

        // resume pulsing
        recordButton.classList.add("recording");

        pauseButton.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
        setStatus("Recording…");
      }
    });

    stopRecordingButton.addEventListener("click", async () => {
      armIdlePopup();
      if (isRecording) await stopRecording();
    });

    resetButton.addEventListener("click", () => {
      armIdlePopup();
      resetRecorder(true);
    });

    if (submitButton) {
      submitButton.addEventListener("click", async () => {
        armIdlePopup();
        if (isRecording) {
          alert("Please stop the recording before submitting.");
          return;
        }
        if (!audioChunks.length) {
          alert("No recording found. Please record audio (or reset and try again).");
          return;
        }
        // Download a local copy *on submit click* (user gesture), before any awaits.
        const blobForDownload = lastAudioBlob || buildAudioBlob();
        if (blobForDownload) {
          const fileName = buildLocalFileName(blobForDownload);
          triggerLocalDownload(blobForDownload, fileName);
        }
        await submitFormAndRecording();
      });
    }

    async function startRecording() {
      try {
        resetRecorder(false);

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStream = stream;

        const mimeType = getPreferredMimeType();
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

        audioChunks = [];
        lastAudioBlob = null;

        isRecording = true;
        isPaused = false;
        pausedAt = 0;
        totalPausedMs = 0;

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.start();

        startTime = Date.now();
        durationInterval = setInterval(updateRecordingDuration, 250);

        recordButton.classList.add("recording");
        recordButton.innerHTML = "Recording...";
        recordButton.disabled = true;

        pauseButton.style.display = "inline-block";
        pauseButton.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';

        stopRecordingButton.style.display = "inline-block";
        if (audioPlayerContainer) audioPlayerContainer.style.display = "none";

        setStatus("Recording…");
        setProgress(0);
      } catch (error) {
        console.error("Mic error:", error);
        alert("Could not access the microphone. Please check permissions.");
        setStatus("Mic error");
      }
    }

    function stopRecording() {
      return new Promise((resolve) => {
        if (!mediaRecorder || (mediaRecorder.state !== "recording" && mediaRecorder.state !== "paused")) {
          isRecording = false;
          if (durationInterval) clearInterval(durationInterval);
          durationInterval = null;
          stopStreamTracks();
          resolve();
          return;
        }

        mediaRecorder.onstop = () => {
          if (isPaused && pausedAt) {
            totalPausedMs += (Date.now() - pausedAt);
            pausedAt = 0;
          }
          isPaused = false;

          if (durationInterval) clearInterval(durationInterval);
          durationInterval = null;

          isRecording = false;
          lastAudioBlob = buildAudioBlob();

          if (lastAudioBlob) {
            audioPlayer.src = URL.createObjectURL(lastAudioBlob);
            audioPlayerContainer.style.display = "block";
            setStatus("Recording ready");
          } else {
            setStatus("No audio captured");
          }

          recordButton.classList.remove("recording");
          recordButton.innerHTML = '<i class="fa-solid fa-circle"></i> Start Recording';
          recordButton.disabled = false;

          pauseButton.style.display = "none";
          stopRecordingButton.style.display = "none";

          stopStreamTracks();

          // final duration snapshot
          const elapsed = Date.now() - startTime - totalPausedMs;
          const minutes = Math.floor(elapsed / 60000);
          const seconds = Math.floor((elapsed % 60000) / 1000);
          const centis = Math.floor((elapsed % 1000) / 10);
          recordingDurationEl.textContent = `${minutes}:${pad2(seconds)}:${pad2(centis)}`;

          resolve();
        };

        mediaRecorder.stop();
      });
    }

    function resetRecorder(resetDuration = true) {
      audioChunks = [];
      lastAudioBlob = null;
      try { audioPlayer.pause(); } catch(e) {}
      audioPlayer.src = "";
      if (audioPlayerContainer) audioPlayerContainer.style.display = "none";

      recordButton.classList.remove("recording");
      recordButton.innerHTML = '<i class="fa-solid fa-circle"></i> Start Recording';
      recordButton.disabled = false;

      pauseButton.style.display = "none";
      stopRecordingButton.style.display = "none";

      if (durationInterval) clearInterval(durationInterval);
      durationInterval = null;

      isRecording = false;
      isPaused = false;

      startTime = 0;
      pausedAt = 0;
      totalPausedMs = 0;

      stopStreamTracks();

      if (resetDuration) recordingDurationEl.textContent = "0:00:00";
      setProgress(0);
      setStatus("Ready");
    }

    /************************************************************
     * SUBMISSION: Firebase upload + Zapier post
     ************************************************************/
    async function submitFormAndRecording() {
      const ensembleID = (safeGet("recordID")?.value || "").trim();
      const fname = (safeGet("fname")?.value || "").trim();
      const lname = (safeGet("lname")?.value || "").trim();
      const solo1 = (safeGet("solo1")?.value || "").trim();
      const solo2 = (safeGet("solo2")?.value || "").trim();
      const overallRating = (safeGet("overallRating")?.value || "").trim();

      const audioBlob = lastAudioBlob || buildAudioBlob();
      if (!audioBlob) {
        alert("No recording found. Please record audio and stop before submitting.");
        return;
      }

      const ext = fileExtForMime(audioBlob.type);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const safeEns = safeSlug(ensembleID);
      const safeAdj = safeSlug(fname + "_" + lname);
      const fileName = `${stamp}_${safeEns}_${safeAdj}.${ext}`;
      const storagePath = `${STORAGE_BASE_PATH}/${safeEns}/${fileName}`;

      try {
        disableDuringSubmit(true);
        setStatus("Uploading audio…");
        setProgress(0);

        const storageRef = storage.ref().child(storagePath);
        const uploadTask = storageRef.put(audioBlob, {
          contentType: audioBlob.type || "audio/webm",
          customMetadata: { ensembleID: ensembleID || "", fname: fname || "", lname: lname || "" }
        });

        const downloadURL = await new Promise((resolve, reject) => {
          uploadTask.on(
            "state_changed",
            (snap) => {
              if (snap.totalBytes > 0) {
                const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
                setProgress(pct);
              }
            },
            (err) => reject(err),
            async () => {
              try {
                const url = await uploadTask.snapshot.ref.getDownloadURL();
                resolve(url);
              } catch (e) { reject(e); }
            }
          );
        });

        setStatus("Submitting form…");

        const fd = new FormData();
        fd.append("EnsembleID", ensembleID);
        fd.append("AdjudicatorFirstName", fname);
        fd.append("AdjudicatorLastName", lname);

        // Safe-append rubric fields if they exist
        const safeVal = (id) => (safeGet(id)?.value ?? "");
        fd.append("Rating1", safeVal("rating1"));
        fd.append("Comments1", safeVal("comments1"));
        fd.append("Rating2", safeVal("rating2"));
        fd.append("Comments2", safeVal("comments2"));
        fd.append("Rating3", safeVal("rating3"));
        fd.append("Comments3", safeVal("comments3"));
        fd.append("Rating4", safeVal("rating4"));
        fd.append("Comments4", safeVal("comments4"));
        fd.append("Rating5", safeVal("rating5"));
        fd.append("Comments5", safeVal("comments5"));

        fd.append("OutstandingSoloist1", solo1);
        fd.append("OutstandingSoloist1_Scholarship", String(!!safeGet("solo1Schol")?.checked));
        fd.append("OutstandingSoloist2", solo2);
        fd.append("OutstandingSoloist2_Scholarship", String(!!safeGet("solo2Schol")?.checked));
        fd.append("OverallRating", overallRating);

        fd.append("AudioUrl", downloadURL);
        fd.append("AudioStoragePath", storagePath);
        fd.append("AudioMimeType", audioBlob.type || "audio/webm");
        fd.append("AudioFileName", fileName);

        let zapierResp;
        try {
          zapierResp = await fetch(ZAPIER_WEBHOOK_URL, { method: "POST", body: fd, keepalive: true });
        } catch (e) {
          await fetch(ZAPIER_WEBHOOK_URL, { method: "POST", body: fd, mode: "no-cors", keepalive: true });
          zapierResp = null;
        }

        if (zapierResp && !zapierResp.ok) {
          throw new Error(`Zapier error: ${zapierResp.status} ${zapierResp.statusText}`);
        }

        setStatus("Submitted ✅");
        alert("✅ Form submitted! Recording uploaded successfully.\n\nYou may close this tab.");
        resetRecorder(true);
      } catch (err) {
        console.error(err);
        setStatus("Error ❗️");
        alert("Something went wrong submitting the form.\n\n" + (err?.message || "Unknown error"));
      } finally {
        disableDuringSubmit(false);
      }
    }

    /************************************************************
     * OPTIONAL: Populate fields from URL params
     ************************************************************/
    (function hydrateFromQuery() {
      const params = new URLSearchParams(window.location.search);
      const setIf = (id, key) => {
        const el = safeGet(id);
        if (!el) return;
        const v = params.get(key);
        if (v !== null) el.value = v;
      };

      setIf("ensemble", "ensemble");
      setIf("school", "school");
      setIf("enstype", "enstype");
      setIf("enslevel", "enslevel");
      setIf("recordID", "recordID");
      setIf("director", "director");

      const members = params.get("ensMembers");
      const membersEl = safeGet("ensMembers");
      if (members !== null && membersEl) membersEl.value = members;
    })();

    // Defensive cleanup
    window.addEventListener("beforeunload", () => {
      try { if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); } catch(e) {}
      try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch(e) {}
    });
  });
})();

