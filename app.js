let keyPair, sharedKey, sessionId;
let map, userMarker, peerMarker, routeLine;
let peerCoords = null;
let username = prompt("Enter your username:");
let peerName = "";

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

function startSharing() {
  if (!sessionId) return alert("Please scan or generate QR first.");

  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  ws.onopen = () => {
    navigator.geolocation.watchPosition(
      async pos => {
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const payload = { coords, username };
        const encrypted = await encryptPayload(payload);
        ws.send(JSON.stringify({ type: "encrypted-location", data: encrypted }));
        updateUserMarker(coords, username);
      },
      err => {
        switch (err.code) {
          case err.PERMISSION_DENIED: alert("Location access denied."); break;
          case err.POSITION_UNAVAILABLE: alert("Location unavailable."); break;
          case err.TIMEOUT: alert("Location request timed out."); break;
          default: alert("Location error: " + err.message);
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  };

  ws.onmessage = async ev => {
    const d = JSON.parse(ev.data);
    if (d.type === "encrypted-location") {
      const decrypted = await decryptPayload(d.data);
      if (!decrypted) return;

      peerCoords = decrypted.coords;
      peerName = decrypted.username;
      updatePeerMarker(peerCoords, peerName);
      drawRoute();
      alert(`Connected to ${peerName}`);
    }
  };
}

// AES-GCM Encryption
async function encryptPayload(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, encoded);
  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext))
  };
}

// AES-GCM Decryption
async function decryptPayload(encrypted) {
  try {
    const iv = new Uint8Array(encrypted.iv);
    const data = new Uint8Array(encrypted.data);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, data);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch (err) {
    console.error("Decryption error:", err.message);
    return null;
  }
}

function updateUserMarker(coords, name) {
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup(name || "You").openPopup();
  map.setView([coords.lat, coords.lon], 14);
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
      }
    });
}
