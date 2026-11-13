(() => {
	"use strict";

	const $ = (id) => document.getElementById(id);
	const log = $("scan-log");
	const skipDuplicates = $("skip-duplicates");
	const scannerDialog = $("scanner-dialog");
	const clearDialog = $("clear-dialog");
	const cameraSelect = $("camera-select");
	const torchButton = $("torch-button");
	const projectPath = location.pathname.replace(/index\.html$/, "").replace(/\/?$/, "/");
	const storageKey = `scankeeper:v1:${projectPath}`;
	let values = new Set();
	let storageSaved = true;
	let noticeTimer;
	let scanner = null;
	let running = false;
	let torchOn = false;
	let selectedCamera = null;
	let generation = 0;
	let cameraQueue = Promise.resolve();
	let lastDetected = null;
	let lastDetectedAt = 0;
	let resizeTimer;
	let readerWidth = 0;

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
		if (typeof decodedText !== "string" || !decodedText.trim()) return;
		const now = performance.now();
		const sameVisibleCode = decodedText === lastDetected && now - lastDetectedAt < 1600;
		lastDetected = decodedText;
		lastDetectedAt = now;
		if (sameVisibleCode) return;
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

	async function releaseCamera() {
		running = false;
		const instance = scanner;
		scanner = null;
		const tracks = Array.from($("reader").querySelectorAll("video"))
			.flatMap((video) => video.srcObject?.getTracks?.() || []);
		try {
			if (instance?.isScanning) await instance.stop();
		} catch (_) {
		} finally {
			tracks.forEach((track) => track.stop());
			try { instance?.clear(); } catch (_) { /* A failed start can already be clear. */ }
			$("reader").replaceChildren();
		}
		torchOn = false;
		torchButton.setAttribute("aria-pressed", "false");
		torchButton.hidden = true;
	}

	function queueCamera(work) {
		cameraQueue = cameraQueue.then(work).catch(async () => {
			await releaseCamera();
			if (scannerDialog.open) showCameraMessage("The camera stopped unexpectedly. Try again.", true);
		});
	}

	function fittedReaderWidth() {
		const stage = $("camera-stage");
		return Math.max(1, Math.floor(Math.min(stage.clientWidth - 2, (stage.clientHeight - 2) * 4 / 3)));
	}

	async function populateCameras(token, instance) {
		try {
			const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
			if (!current(token) || scanner !== instance) return;
			const activeId = instance.getRunningTrackSettings().deviceId;
			if (cameras.length) {
				cameraSelect.replaceChildren(...cameras.map((camera, index) => new Option(camera.label || `Camera ${index + 1}`, camera.deviceId)));
				if (cameras.some((camera) => camera.deviceId === activeId)) {
					cameraSelect.value = activeId;
					selectedCamera = activeId;
				}
			}
			cameraSelect.disabled = cameras.length < 2;
		} catch (_) { cameraSelect.disabled = true; }
	}

	function startCamera() {
		const token = ++generation;
		running = false;
		cameraSelect.disabled = true;
		torchButton.hidden = true;
		showCameraMessage("Starting camera… Allow access when your browser asks.");
		queueCamera(async () => {
			if (!current(token)) return;
			await releaseCamera();
			if (!current(token)) return;
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
			readerWidth = fittedReaderWidth();
			$("reader").style.width = `${readerWidth}px`;
			try {
				const instance = new Html5Qrcode("reader", { verbose: false });
				scanner = instance;
				await instance.start(selectedCamera || { facingMode: "environment" },
					{ fps: 10, aspectRatio: 4 / 3 },
					(text) => { if (current(token) && running) acceptScan(text); },
					() => { /* An undecodable frame is normal while aiming. */ });
				if (!current(token)) { await releaseCamera(); return; }
				running = true;
				$("camera-message").hidden = true;
				try {
					const capabilities = instance.getRunningTrackCapabilities();
					torchButton.hidden = capabilities.torch !== true;
				} catch (_) { torchButton.hidden = true; }
				await populateCameras(token, instance);
			} catch (error) {
				await releaseCamera();
				if (current(token)) {
					showCameraMessage(cameraError(error), true);
					cameraSelect.disabled = cameraSelect.options.length < 2;
				}
			}
		});
	}

	function stopCameraSession() {
		++generation;
		running = false;
		clearTimeout(resizeTimer);
		queueCamera(releaseCamera);
	}

	function closeScanner() {
		stopCameraSession();
		if (scannerDialog.open) scannerDialog.close();
	}

	$("scan-button").addEventListener("click", () => {
		log.blur();
		$("notice").hidden = true;
		lastDetected = null;
		feedback("Ready for your next tag", "Point at a barcode or QR code", "ready");
		scannerDialog.showModal();
		startCamera();
	});
	$("close-scanner").addEventListener("click", closeScanner);
	$("done-scanning").addEventListener("click", closeScanner);
	scannerDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeScanner(); });
	scannerDialog.addEventListener("close", () => { if (!scannerDialog.open) stopCameraSession(); });
	$("retry-camera").addEventListener("click", startCamera);
	cameraSelect.addEventListener("change", () => { selectedCamera = cameraSelect.value; startCamera(); });
	torchButton.addEventListener("click", () => {
		const token = generation;
		torchButton.disabled = true;
		queueCamera(async () => {
			try {
				if (!current(token) || !running || !scanner) return;
				const next = !torchOn;
				await scanner.applyVideoConstraints({ advanced: [{ torch: next }] });
				if (!current(token)) return;
				torchOn = next;
				torchButton.setAttribute("aria-pressed", String(torchOn));
			} catch (_) {
				if (current(token)) feedback("Light isn’t available on this camera", "Try moving to a brighter area", "ready");
			} finally { torchButton.disabled = false; }
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
		$("reader").querySelectorAll("video").forEach((video) => video.srcObject?.getTracks?.().forEach((track) => track.stop()));
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
	const stageObserver = new ResizeObserver(() => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			if (scannerDialog.open && running && Math.abs(fittedReaderWidth() - readerWidth) > 24) startCamera();
		}, 350);
	});
	stageObserver.observe($("camera-stage"));

	fitViewport();
	restoreLog();
})();
