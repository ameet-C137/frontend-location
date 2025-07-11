let keyPair, sharedKey, sessionId;
let map, userMarker, peerMarker, routeLine;
let peerCoords = null;
let username = prompt("Enter your username:");
let peerName = "";
let wsGlobal = null;

const BACKEND_URL = "https://backend-location-bnpl.onrender.com";
const WS_URL = BACKEND_URL.replace("https", "wss");

initMap();

function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
}

async function generateKeys() {
  keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));

  const res = await fetch(`${BACKEND_URL}/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: b64 }),
  });

  const data = await res.json();
  sessionId = data.session;

  document.getElementById("qr").innerHTML = `
    <img src="https://api.qrserver.com/v1/create-qr-code/?data=${sessionId}&size=150x150" />
    <p>Scan this QR to connect</p>
  `;
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
  });
}

function scanUploadedFile(input) {
  if (!input.files.length) return;
  const file = input.files[0];
  const reader = new Html5Qrcode("reader");

  reader.scanFile(file, true)
    .then(session => {
      reader.clear();
      completeKeyExchange(session);
    })
    .catch(err => {
      alert("Failed to scan QR from image: " + err.message);
    });
}

async function completeKeyExchange(session) {
  sessionId = session;
  if (!keyPair) {
    keyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );
  }

  const res = await fetch(`${BACKEND_URL}/get-key/${sessionId}`);
  if (!res.ok) return alert("QR code is expired or invalid");

  const { key } = await res.json();
  const raw = Uint8Array.from(atob(key), c => c.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  sharedKey = await crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, keyPair.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  alert("Key exchange complete. Click Share Location.");
}

// -------- Secure Username Encryption ----------
async function encryptUsername(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, encoded);
  return {
    iv: Array.from(iv),
    username: Array.from(new Uint8Array(ciphertext))
  };
}

async function decryptUsername(encrypted) {
  const iv = new Uint8Array(encrypted.iv);
  const data = new Uint8Array(encrypted.username);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, data);
  return new TextDecoder().decode(decrypted);
}

// -------- Secure Messaging ----------
async function encryptMessage(msg) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(msg);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, encoded);
  return {
    iv: Array.from(iv),
    message: Array.from(new Uint8Array(ciphertext))
  };
}

async function decryptMessage(payload) {
  const iv = new Uint8Array(payload.iv);
  const data = new Uint8Array(payload.message);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, data);
  return new TextDecoder().decode(decrypted);
}

function appendMessage(text, from = "peer") {
  const msgBox = document.getElementById("messages");
  const div = document.createElement("div");
  div.textContent = (from === "me" ? "🧑‍💻 You: " : `👤 ${peerName || 'Peer'}: `) + text;
  div.style.marginBottom = "4px";
  msgBox.appendChild(div);
  msgBox.scrollTop = msgBox.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById("messageInput");
  const plainText = input.value.trim();
  if (!plainText) return;
  const encrypted = await encryptMessage(plainText);
  wsGlobal.send(JSON.stringify({ type: "message", ...encrypted }));
  appendMessage(plainText, "me");
  input.value = "";
}

// -------- Sharing and Handling WS --------
function startSharing() {
  if (!sessionId) return alert("Please scan or generate QR first.");
  wsGlobal = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  wsGlobal.onopen = () => {
    navigator.geolocation.watchPosition(
      async pos => {
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const encryptedName = await encryptUsername(username);
        wsGlobal.send(JSON.stringify({ type: "location", coords, ...encryptedName }));
        updateUserMarker(coords, username);
      },
      err => alert("Location error: " + err.message),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  };

  wsGlobal.onmessage = async ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === "location") {
        peerCoords = d.coords;
        peerName = await decryptUsername(d);
        updatePeerMarker(peerCoords, peerName);
        drawRoute();
        updateDistance();
      } else if (d.type === "message") {
        const text = await decryptMessage(d);
        appendMessage(text, "peer");
      }
    } catch (e) {
      console.error("Decryption error:", e);
    }
  };
}

function updateUserMarker(coords, name) {
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([coords.lat, coords.lon])
    .addTo(map)
    .bindPopup(name || "You")
    .openPopup();
  map.setView([coords.lat, coords.lon], 14);
}

function updatePeerMarker(coords, name) {
  if (peerMarker) map.removeLayer(peerMarker);
  peerMarker = L.marker([coords.lat, coords.lon])
    .addTo(map)
    .bindPopup(name || "Peer")
    .openPopup();
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
      }
    });
}

function updateDistance() {
  if (!peerCoords || !userMarker) return;
  const u = userMarker.getLatLng();
  const p = peerCoords;

  const R = 6371e3;
  const φ1 = u.lat * Math.PI / 180;
  const φ2 = p.lat * Math.PI / 180;
  const Δφ = (p.lat - u.lat) * Math.PI / 180;
  const Δλ = (p.lon - u.lng) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const d = R * c;

  const distText = d >= 1000 ? `${(d / 1000).toFixed(2)} km` : `${Math.round(d)} m`;
  document.getElementById("distanceValue").textContent = distText;
}
