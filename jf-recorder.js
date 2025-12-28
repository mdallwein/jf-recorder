
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
     * FIREBASE INIT
     ************************************************************/
    firebase.initializeApp(firebaseConfig);
    const storage = firebase.storage();

    /************************************************************
     * DOM
     ************************************************************/
    const recordButton = document.getElementById("recordButton");
    const pauseButton = document.getElementById("pauseButton");
    const stopRecordingButton = document.getElementById("stopRecording");
    const resetButton = document.getElementById("resetButton");
    const submitButton = document.getElementById("submitButton");

    const audioPlayer = document.getElementById("audioPlayer");
    const audioPlayerContainer = document.getElementById("audioPlayerContainer");
    const recordingDurationEl = document.getElementById("recordingDuration");
    const progressBar = document.getElementById("uploadProgressBar");
    const statusPill = document.getElementById("statusPill");

    /************************************************************
     * RECORDING STATE (Pause/Resume)
     ************************************************************/
    let mediaRecorder = null;
    let mediaStream = null;
    let audioChunks = [];
    let lastAudioBlob = null;

    let isRecording = false;
    let isPaused = false;

    let startTime = 0;         // time when recording began
    let pausedAt = 0;          // time when pause started
    let totalPausedMs = 0;     // accumulated paused time

    let durationInterval = null;

    /************************************************************
     * IDLE POPUP (kept from your version)
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
      <button id="yesButton" class="btn btn-outline-primary btn-sm" style="margin-right:8px;">Yes</button>
      <button id="noButton" class="btn btn-danger btn-sm">No, submit now</button>
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
            await submitFormAndRecording();
          } catch (e) {
            console.error(e);
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
        await submitFormAndRecording();
      } catch (e) {
        console.error(e);
      } finally {
        hideIdlePopup();
      }
    });

    armIdlePopup();

    /************************************************************
     * HELPERS
     ************************************************************/
    function setStatus(text) { statusPill.textContent = text; }
    function setProgress(pct) {
      const clamped = Math.max(0, Math.min(100, pct));
      progressBar.style.width = clamped + "%";
      progressBar.textContent = clamped + "%";
    }
    function pad2(n) { return String(n).padStart(2, "0"); }

    // ✅ Timer freezes when paused (requirement #1)
    function updateRecordingDuration() {
      if (!isRecording) return;
      if (isPaused) return; // freeze display while paused

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

    function disableDuringSubmit(disabled) {
      submitButton.disabled = disabled;
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
     * RECORDING CONTROLS (Pause/Resume)
     ************************************************************/
    recordButton.addEventListener("click", async () => {
      armIdlePopup();
      if (!isRecording) await startRecording();
    });

    // ✅ Pause/Resume button: stops timer + stops pulsing while paused
    pauseButton.addEventListener("click", () => {
      armIdlePopup();
      if (!mediaRecorder) return;

      // Pause
      if (isRecording && !isPaused && mediaRecorder.state === "recording") {
        mediaRecorder.pause();
        isPaused = true;
        pausedAt = Date.now();

        // ✅ Stop pulsing when paused (requirement #2)
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

        // ✅ Resume pulsing when resumed
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
      await submitFormAndRecording();
    });

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
        recordButton.disabled = true; // prevent accidental clicks while active

        pauseButton.style.display = "inline-block";
        pauseButton.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';

        stopRecordingButton.style.display = "inline-block";
        resetButton.style.display = "none";
        audioPlayerContainer.style.display = "none";

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
          clearInterval(durationInterval);
          stopStreamTracks();
          resolve();
          return;
        }

        mediaRecorder.onstop = () => {
          // If stopped while paused, account for that paused time
          if (isPaused && pausedAt) {
            totalPausedMs += (Date.now() - pausedAt);
            pausedAt = 0;
          }
          isPaused = false;

          clearInterval(durationInterval);
          durationInterval = null;

          isRecording = false;

          lastAudioBlob = buildAudioBlob();

          if (lastAudioBlob) {
            audioPlayer.src = URL.createObjectURL(lastAudioBlob);
            audioPlayerContainer.style.display = "block";
            resetButton.style.display = "inline-block";
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

          // Final duration snapshot (even if paused when stopped)
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
      audioPlayerContainer.style.display = "none";

      recordButton.classList.remove("recording");
      recordButton.innerHTML = '<i class="fa-solid fa-circle"></i> Start Recording';
      recordButton.disabled = false;

      pauseButton.style.display = "none";
      stopRecordingButton.style.display = "none";

      resetButton.style.display = "inline-block";

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
     * SUBMISSION (same as your working version)
     * NOTE: Keep your existing form-field appends + ratings logic;
     *       this example includes only the audio upload + Zapier post skeleton.
     ************************************************************/
    async function submitFormAndRecording() {
      const ensembleID = (document.getElementById("recordID")?.value || "").trim();
      const fname = (document.getElementById("fname")?.value || "").trim();
      const lname = (document.getElementById("lname")?.value || "").trim();

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
          uploadTask.on("state_changed",
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

      fd.append("Rating1", document.getElementById("rating1").value);
      fd.append("Comments1", document.getElementById("comments1").value);
      fd.append("Rating2", document.getElementById("rating2").value);
      fd.append("Comments2", document.getElementById("comments2").value);
      fd.append("Rating3", document.getElementById("rating3").value);
      fd.append("Comments3", document.getElementById("comments3").value);
      fd.append("Rating4", document.getElementById("rating4").value);
      fd.append("Comments4", document.getElementById("comments4").value);
      fd.append("Rating5", document.getElementById("rating5").value);
      fd.append("Comments5", document.getElementById("comments5").value);

      fd.append("OutstandingSoloist1", solo1);
      fd.append("OutstandingSoloist1_Scholarship", String(document.getElementById("solo1Schol").checked));
      fd.append("OutstandingSoloist2", solo2);
      fd.append("OutstandingSoloist2_Scholarship", String(document.getElementById("solo2Schol").checked));

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

        try {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(audioBlob);
          a.download = fileName;
          a.click();
        } catch (e) {}

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
     * OPTIONAL: Populate fields from URL params (kept)
     ************************************************************/
    (function hydrateFromQuery() {
      const params = new URLSearchParams(window.location.search);
      const setIf = (id, key) => {
        const el = document.getElementById(id);
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
      const membersEl = document.getElementById("ensMembers");
      if (members !== null && membersEl) membersEl.value = members;
    })();
