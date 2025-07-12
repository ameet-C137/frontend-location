let keyPair, sharedKey, sessionId;
let map, userMarker, peerMarker, routeLine;
let peerCoords = null;
let username = prompt("Enter your username:");
let peerName = "";

const BACKEND_URL = "https://backend-location-bnpl.onrender.com";
const WS_URL = BACKEND_URL.replace("https", "wss");

function logDebug(msg) {
  console.log("[DEBUG]", msg);
  const logBox = document.getElementById("debug-logs");
  if (logBox) logBox.value += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
}

initMap();

function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  logDebug("Map initialized.");
}

async function generateKeys() {
  logDebug("Generating ECDH key pair...");
  keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true, ["deriveKey"]
  );

  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));

  const res = await fetch(`${BACKEND_URL}/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: b64 })
  });

  const data = await res.json();
  sessionId = data.session;
  document.getElementById("qr").innerHTML = `
    <img src="https://api.qrserver.com/v1/create-qr-code/?data=${sessionId}&size=150x150" />
    <p>Scan this QR (one-time use)</p>
  `;
  logDebug("QR code generated with session ID: " + sessionId);
}

function startQRScanner() {
  const reader = new Html5Qrcode("reader");
  reader.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 250 },
    async (session) => {
      reader.stop();
      await completeKeyExchange(session);
    }
  ).catch(err => {
    alert("Camera error: " + err.message);
    logDebug("QR scan error: " + err.message);
  });
}

async function completeKeyExchange(session) {
  sessionId = session;
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true, ["deriveKey"]
    );
  }

  const res = await fetch(`${BACKEND_URL}/get-key/${sessionId}`);
  if (!res.ok) return alert("QR code expired or invalid");

  const { key } = await res.json();
  const raw = Uint8Array.from(atob(key), c => c.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  sharedKey = await crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    keyPair.privateKey,
    { name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]
  );

  alert("Key exchange complete. Click Start Sharing.");
  logDebug("Key exchange completed.");
}

function startSharing() {
  if (!sessionId || !sharedKey) return alert("Scan or create QR first");

  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  ws.onopen = () => {
    logDebug("WebSocket connection opened.");

    navigator.geolocation.watchPosition(pos => {
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      ws.send(JSON.stringify({ type: "location", coords, username }));
      updateUserMarker(coords, username);
      logDebug(`Location sent: ${coords.lat}, ${coords.lon}`);
    }, err => {
      alert("Location error: " + err.message);
      logDebug("Location error: " + err.message);
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    });
  };

  ws.onmessage = ev => {
    const d = JSON.parse(ev.data);
    if (d.type === "location") {
      if (d.username === username) return;
      peerCoords = d.coords;
      peerName = d.username;
      updatePeerMarker(peerCoords, peerName);
      drawRoute();
      logDebug(`Received peer location from: ${peerName}`);
    }
  };
}

function updateUserMarker(coords, name) {
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup(name || "You").openPopup();
  map.setView([coords.lat, coords.lon], 15);
}

function updatePeerMarker(coords, name) {
  if (peerMarker) map.removeLayer(peerMarker);
  peerMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup(name || "Peer").openPopup();
}

function drawRoute() {
  if (!peerCoords || !userMarker) return;
  const u = userMarker.getLatLng();
  const p = [peerCoords.lat, peerCoords.lon];
  fetch(`https://router.project-osrm.org/route/v1/driving/${u.lng},${u.lat};${p[1]},${p[0]}?overview=full&geometries=geojson`)
    .then(r => r.json())
    .then(d => {
      if (routeLine) map.removeLayer(routeLine);
      if (d.routes?.[0]?.geometry) {
        routeLine = L.geoJSON(d.routes[0].geometry, { style: { color: 'blue' } }).addTo(map);
        logDebug("Route drawn.");
      }
    });
}
