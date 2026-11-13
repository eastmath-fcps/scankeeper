(() => {
	"use strict";

	const $ = (id) => document.getElementById(id);
	const log = $("scan-log");
	const skipDuplicates = $("skip-duplicates");
	const scannerDialog = $("scanner-dialog");
	const clearDialog = $("clear-dialog");
	const cameraSelect = $("camera-select");
	const torchButton = $("torch-button");
	const preview = $("camera-preview");
	const snapshot = $("scan-snapshot");
	const captureButton = $("capture-button");
	const projectPath = location.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
	const storageKey = `scankeeper:v1:${projectPath}`;
	let values = new Set();
	let storageSaved = true;
	let noticeTimer;
	let cameraStream = null;
	let decoder = null;
	let running = false;
	let cameraStarting = false;
	let captureBusy = false;
	let torchBusy = false;
	let torchOn = false;
	let selectedCamera = null;
	let generation = 0;
	let cameraQueue = Promise.resolve();

	function announce(message) {
		clearTimeout(noticeTimer);
		$("notice").textContent = message;
		$("notice").hidden = false;
		noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 4500);
	}

	function showStorageState() {
		$("storage-status").textContent = storageSaved
			? "Saved on this device only."
			: "Not saved on this device. Copy or save your log.";
		$("storage-status").classList.toggle("warning", !storageSaved);
		$("scanner-storage").hidden = storageSaved;
	}

	function saveLog() {
		try {
			localStorage.setItem(storageKey, JSON.stringify({ text: log.value, skipDuplicates: skipDuplicates.checked }));
			storageSaved = true;
		} catch (_) {
			storageSaved = false;
		}
		showStorageState();
	}

	function updateLog(persist = true) {
		const lines = log.value.split(/\r\n|[\n\r\u2028\u2029]/).filter((line) => line.trim().length > 0);
		values = new Set(lines);
		const count = `${lines.length} ${lines.length === 1 ? "scan" : "scans"}`;
		$("scan-count").textContent = count;
		$("scanner-count").textContent = count;
		for (const id of ["copy-button", "download-button", "clear-button"]) $(id).disabled = log.value.length === 0;
		if (persist) saveLog();
	}

	function restoreLog() {
		try {
			const raw = localStorage.getItem(storageKey);
			if (raw !== null) {
				const stored = JSON.parse(raw);
				if (!stored || typeof stored.text !== "string") throw new Error("Invalid saved log");
				log.value = stored.text;
				skipDuplicates.checked = stored.skipDuplicates !== false;
			}
		} catch (_) {
			storageSaved = false;
			announce("Couldn’t restore the saved log. Copy or save any new scans.");
		}
		updateLog(false);
		showStorageState();
	}

	function oneLine(text) {
		return text.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n")
			.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
	}

	function feedback(label, value, kind) {
		$("feedback-label").textContent = label;
		$("last-scan").textContent = value;
		$("scan-feedback").dataset.kind = kind;
	}

	function acceptScan(decodedText) {
		if (typeof decodedText !== "string" || !decodedText.trim()) {
			feedback("No readable value found", "Hold steady and tap Scan again", "warning");
			return;
		}
		const value = oneLine(decodedText);
		if (skipDuplicates.checked && values.has(value)) {
			feedback("Already in your log · skipped", value, "duplicate");
			return;
		}
		const separator = log.value && !/[\n\r\u2028\u2029]$/.test(log.value) ? "\n" : "";
		log.value += separator + value + "\n";
		updateLog();
		log.scrollTop = log.scrollHeight;
		feedback("Added to your log", value, "success");
		try { navigator.vibrate?.(60); } catch (_) { /* No haptic support. */ }
	}

	function current(token) {
		return token === generation && scannerDialog.open && !document.hidden;
	}

	function showCameraMessage(message, retry = false) {
		$("camera-message-text").textContent = message;
		$("camera-message").hidden = false;
		$("retry-camera").hidden = !retry;
	}

	function cameraError(error) {
		const detail = `${error?.name || ""} ${error?.message || error || ""}`;
		if (/NotAllowed|Permission|denied|SecurityError/i.test(detail)) {
			return "Camera access is blocked. Allow camera access in this site’s browser settings, then try again. On iPhone, also check Safari’s camera permission in Settings.";
		}
		if (/NotFound|DevicesNotFound/i.test(detail)) return "No camera was found. Connect or enable a camera, then try again.";
		if (/NotReadable|TrackStart|in use|Could not start/i.test(detail)) return "The camera is unavailable. Close other apps using it, then try again.";
		if (/Overconstrained|ConstraintNotSatisfied/i.test(detail)) return "This camera couldn’t start. Choose another camera or try again.";
		return "Couldn’t start the camera. Check camera permission and try again in Safari or Chrome. You can also type tags into the log.";
	}

	function frameReady() {
		const track = cameraStream?.getVideoTracks()[0];
		return running && track?.readyState === "live" && !track.muted
			&& !preview.paused && preview.readyState >= 2
			&& preview.videoWidth > 0 && preview.videoHeight > 0;
	}

	function updateCameraControls() {
		captureButton.disabled = !frameReady() || captureBusy || torchBusy;
		captureButton.setAttribute("aria-busy", String(captureBusy));
		$("capture-label").textContent = captureBusy ? "Analyzing…" : "Scan";
		cameraSelect.disabled = cameraStarting || captureBusy || cameraSelect.options.length < 2;
		torchButton.disabled = !running || captureBusy || torchBusy;
	}

	function releaseCamera() {
		running = false;
		const stream = cameraStream;
		cameraStream = null;
		stream?.getTracks().forEach((track) => track.stop());
		preview.pause();
		preview.srcObject = null;
		snapshot.hidden = true;
		torchOn = false;
		torchButton.setAttribute("aria-pressed", "false");
		torchButton.hidden = true;
		updateCameraControls();
	}

	function queueCamera(work) {
		const token = generation;
		cameraQueue = cameraQueue.then(work).catch(() => {
			if (token !== generation) return;
			cameraStarting = false;
			releaseCamera();
			if (current(token)) showCameraMessage("The camera stopped unexpectedly. Try again.", true);
		});
	}

	async function populateCameras(token, stream) {
		try {
			const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
			if (!current(token) || cameraStream !== stream) return;
			const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId;
			if (cameras.length) {
				cameraSelect.replaceChildren(...cameras.map((camera, index) => new Option(camera.label || `Camera ${index + 1}`, camera.deviceId)));
				if (cameras.some((camera) => camera.deviceId === activeId)) {
					cameraSelect.value = activeId;
					selectedCamera = activeId;
				}
			}
		} catch (_) { /* Preview and capture can work without a camera list. */ }
		if (current(token)) updateCameraControls();
	}

	function startCamera() {
		const token = ++generation;
		cameraStarting = true;
		releaseCamera();
		showCameraMessage("Starting camera… Allow access when your browser asks.");
		queueCamera(async () => {
			if (!current(token)) return;
			let stream;
			try {
				if (!window.isSecureContext) {
					showCameraMessage("Camera scanning requires HTTPS. Open the secure GitHub Pages address, or use localhost for testing.");
					return;
				}
				if (!navigator.mediaDevices?.getUserMedia) {
					showCameraMessage("This browser cannot access a camera. Open this page directly in Safari or Chrome, or enter tags in the log.");
					return;
				}
				if (typeof window.Html5Qrcode !== "function") {
					showCameraMessage("The scanner couldn’t load. Refresh the page and try again.");
					return;
				}
				stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: {
						...(selectedCamera ? { deviceId: { exact: selectedCamera } } : { facingMode: { ideal: "environment" } }),
						width: { ideal: 1920 },
						height: { ideal: 1440 }
					}
				});
				if (!current(token)) { stream.getTracks().forEach((track) => track.stop()); return; }
				cameraStream = stream;
				preview.srcObject = stream;
				await preview.play();
				if (!current(token) || cameraStream !== stream) { stream.getTracks().forEach((track) => track.stop()); return; }
				running = true;
				$("camera-message").hidden = true;
				const track = stream.getVideoTracks()[0];
				try {
					torchButton.hidden = track.getCapabilities?.().torch !== true;
				} catch (_) { torchButton.hidden = true; }
				track.addEventListener("ended", () => {
					if (!current(token) || cameraStream !== stream) return;
					releaseCamera();
					showCameraMessage("The camera stopped. Try again.", true);
				});
				track.addEventListener("mute", updateCameraControls);
				track.addEventListener("unmute", updateCameraControls);
				void populateCameras(token, stream);
			} catch (error) {
				stream?.getTracks().forEach((track) => track.stop());
				if (current(token)) {
					releaseCamera();
					showCameraMessage(cameraError(error), true);
				}
			} finally {
				if (current(token)) { cameraStarting = false; updateCameraControls(); }
			}
		});
	}

	async function captureScan() {
		if (!current(generation) || !frameReady() || captureBusy || torchBusy) return;
		const token = generation;
		const stream = cameraStream;
		captureBusy = true;
		updateCameraControls();
		feedback("Analyzing captured image…", "One moment…", "ready");
		let decoding = false;
		try {
			snapshot.width = preview.videoWidth;
			snapshot.height = preview.videoHeight;
			const context = snapshot.getContext("2d");
			if (!context) throw new Error("Could not create a captured image");
			context.drawImage(preview, 0, 0, snapshot.width, snapshot.height);
			snapshot.hidden = false;
			const blob = await new Promise((resolve, reject) => snapshot.toBlob(
				(image) => image ? resolve(image) : reject(new Error("Could not capture image")), "image/png"));
			if (!current(token) || cameraStream !== stream) return;
			decoder ||= new Html5Qrcode("reader", { verbose: false });
			decoding = true;
			const text = await decoder.scanFile(new File([blob], "scan.png", { type: "image/png" }), false);
			if (current(token) && cameraStream === stream) acceptScan(text);
		} catch (_) {
			if (current(token) && cameraStream === stream) {
				feedback(decoding ? "No barcode found · nothing added" : "Couldn’t capture image · nothing added",
					"Hold steady and tap Scan again", "warning");
			}
		} finally {
			try { decoder?.clear(); } catch (_) { /* The next scan can recreate the canvas. */ }
			snapshot.hidden = true;
			snapshot.width = snapshot.height = 1;
			captureBusy = false;
			updateCameraControls();
		}
	}

	function stopCameraSession() {
		++generation;
		cameraStarting = false;
		releaseCamera();
	}

	function closeScanner() {
		stopCameraSession();
		if (scannerDialog.open) scannerDialog.close();
	}

	$("scan-button").addEventListener("click", () => {
		log.blur();
		$("notice").hidden = true;
		feedback("Ready when you are", "Line up a code, then tap Scan", "ready");
		scannerDialog.showModal();
		startCamera();
	});
	$("close-scanner").addEventListener("click", closeScanner);
	$("done-scanning").addEventListener("click", closeScanner);
	scannerDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeScanner(); });
	scannerDialog.addEventListener("close", () => { if (!scannerDialog.open) stopCameraSession(); });
	$("retry-camera").addEventListener("click", startCamera);
	captureButton.addEventListener("click", captureScan);
	for (const event of ["loadeddata", "canplay", "playing", "pause", "emptied", "resize"]) {
		preview.addEventListener(event, updateCameraControls);
	}
	cameraSelect.addEventListener("change", () => { selectedCamera = cameraSelect.value; startCamera(); });
	torchButton.addEventListener("click", () => {
		if (!running || captureBusy || torchBusy) return;
		const token = generation;
		torchBusy = true;
		updateCameraControls();
		queueCamera(async () => {
			try {
				if (!current(token) || !running || !cameraStream) return;
				const next = !torchOn;
				await cameraStream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: next }] });
				if (!current(token)) return;
				torchOn = next;
				torchButton.setAttribute("aria-pressed", String(torchOn));
			} catch (_) {
				if (current(token)) feedback("Light isn’t available on this camera", "Try moving to a brighter area", "ready");
			} finally { torchBusy = false; updateCameraControls(); }
		});
	});

	log.addEventListener("input", () => updateLog());
	skipDuplicates.addEventListener("change", saveLog);
	$("copy-button").addEventListener("click", async () => {
		const text = log.value;
		if (!text) return;
		try {
			if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
			await navigator.clipboard.writeText(text);
			announce("Copied your scan log.");
		} catch (_) {
			const wasReadOnly = log.readOnly;
			const start = log.selectionStart;
			const end = log.selectionEnd;
			const scrollTop = log.scrollTop;
			const focus = document.activeElement;
			log.readOnly = true;
			log.focus({ preventScroll: true });
			log.select();
			log.setSelectionRange(0, text.length);
			let copied = false;
			try { copied = document.execCommand("copy"); } catch (_) { /* Manual fallback below. */ }
			log.readOnly = wasReadOnly;
			if (copied) {
				log.setSelectionRange(start, end);
				log.scrollTop = scrollTop;
				focus?.focus({ preventScroll: true });
			}
			announce(copied ? "Copied your scan log." : "Copy unavailable. Touch and hold the selected log to copy it.");
		}
	});

	$("download-button").addEventListener("click", () => {
		if (!log.value) return;
		const now = new Date();
		const pad = (n) => String(n).padStart(2, "0");
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const blob = new Blob([log.value], { type: "text/plain;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `scankeeper-${date}-${time}.txt`;
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60000);
		announce("Text file ready. Check your browser’s downloads.");
	});

	$("clear-button").addEventListener("click", () => {
		$("notice").hidden = true;
		clearDialog.showModal();
	});
	$("cancel-clear").addEventListener("click", () => clearDialog.close());
	$("confirm-clear").addEventListener("click", () => {
		log.value = "";
		updateLog();
		clearDialog.close();
		announce("Scan log cleared.");
	});

	document.addEventListener("visibilitychange", () => {
		if (document.hidden && scannerDialog.open) closeScanner();
	});
	window.addEventListener("pagehide", () => {
		closeScanner();
	});
	window.addEventListener("beforeunload", (event) => {
		if (!storageSaved && log.value) { event.preventDefault(); event.returnValue = ""; }
	});

	function fitViewport() {
		const viewport = window.visualViewport;
		if (viewport && Math.abs(viewport.scale - 1) < .05) {
			document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
			document.documentElement.style.setProperty("--app-top", `${viewport.offsetTop}px`);
		}
		const height = viewport && Math.abs(viewport.scale - 1) < .05 ? viewport.height : window.innerHeight;
		document.documentElement.classList.toggle("compact-viewport", height <= 600);
		document.documentElement.classList.toggle("short-viewport", height <= 420);
	}
	window.visualViewport?.addEventListener("resize", fitViewport);
	window.visualViewport?.addEventListener("scroll", fitViewport);
	window.addEventListener("resize", fitViewport);
	fitViewport();
	updateCameraControls();
	restoreLog();
})();
