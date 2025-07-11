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

// --- New helper functions to encrypt/decrypt username ---
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
// --- End helper functions ---

function startSharing() {
  if (!sessionId) return alert("Please scan or generate QR first.");

  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  ws.onopen = () => {
    navigator.geolocation.watchPosition(
      async pos => {
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const encryptedName = await encryptUsername(username);

        // Send encrypted username inside the location message
        ws.send(JSON.stringify({ type: "location", coords, ...encryptedName }));

        updateUserMarker(coords, username);
      },
      err => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            alert("Location access denied. Please allow location.");
            break;
          case err.POSITION_UNAVAILABLE:
            alert("Location unavailable.");
            break;
          case err.TIMEOUT:
            alert("Location request timed out.");
            break;
          default:
            alert("Location error: " + err.message);
        }
        console.error("Geo error:", err);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5000
      }
    );
  };

  ws.onmessage = async ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === "location") {
        peerCoords = d.coords;
        peerName = await decryptUsername(d); // decrypt username from received message
        updatePeerMarker(peerCoords, peerName);
        drawRoute();
        alert(`Connected to ${peerName}`);
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

// --- Messaging UI and logic ---

// Add message box and distance box to the DOM
const controlsDiv = document.createElement("div");
controlsDiv.style.position = "absolute";
controlsDiv.style.top = "20px";
controlsDiv.style.right = "20px";
controlsDiv.style.width = "260px";
controlsDiv.style.background = "rgba(255,255,255,0.95)";
controlsDiv.style.borderRadius = "10px";
controlsDiv.style.boxShadow = "0 2px 8px rgba(0,0,0,0.1)";
controlsDiv.style.padding = "12px";
controlsDiv.style.zIndex = "1000";
controlsDiv.innerHTML = `
  <div id="distanceBox" style="font-size:16px;font-weight:500;margin-bottom:10px;text-align:center;background:#f3f6fa;padding:6px 0;border-radius:6px;">Distance: --</div>
  <div id="chatBox" style="height:120px;overflow-y:auto;border:1px solid #e0e0e0;background:#fafbfc;border-radius:6px;padding:6px 4px 6px 8px;margin-bottom:8px;font-size:14px;"></div>
  <form id="msgForm" style="display:flex;gap:4px;">
    <input id="msgInput" type="text" placeholder="Type a message..." style="flex:1;padding:6px 8px;border-radius:6px;border:1px solid #ccc;font-size:14px;" autocomplete="off" />
    <button type="submit" style="padding:6px 12px;border-radius:6px;background:#1976d2;color:#fff;border:none;font-size:14px;">Send</button>
  </form>
`;
document.body.appendChild(controlsDiv);

let wsRef = null; // keep reference to websocket for messaging

// --- Secure message encryption/decryption ---
async function encryptMessage(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sharedKey, encoded);
  return {
    iv: Array.from(iv),
    msg: Array.from(new Uint8Array(ciphertext))
  };
}

async function decryptMessage(encrypted) {
  const iv = new Uint8Array(encrypted.iv);
  const data = new Uint8Array(encrypted.msg);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sharedKey, data);
  return new TextDecoder().decode(decrypted);
}

// --- Chat UI logic ---
const chatBox = document.getElementById("chatBox");
const msgForm = document.getElementById("msgForm");
const msgInput = document.getElementById("msgInput");

msgForm.addEventListener("submit", async e => {
  e.preventDefault();
  if (!msgInput.value.trim() || !wsRef) return;
  const encrypted = await encryptMessage(msgInput.value.trim());
  wsRef.send(JSON.stringify({ type: "msg", ...encrypted }));
  appendChatMsg(username, msgInput.value.trim(), true);
  msgInput.value = "";
});

function appendChatMsg(sender, text, self = false) {
  const div = document.createElement("div");
  div.style.margin = "2px 0";
  div.style.textAlign = self ? "right" : "left";
  div.innerHTML = `<span style="color:${self ? "#1976d2" : "#333"};font-weight:500;">${sender}:</span> <span>${text}</span>`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// --- Distance calculation and UI ---
function updateDistanceBox() {
  if (!userMarker || !peerCoords) {
    document.getElementById("distanceBox").textContent = "Distance: --";
    return;
  }
  const u = userMarker.getLatLng();
  const p = L.latLng(peerCoords.lat, peerCoords.lon);
  const d = u.distanceTo(p); // meters
  let text = d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(2)} km`;
  document.getElementById("distanceBox").textContent = `Distance: ${text}`;
}

// --- Patch startSharing to support messaging and distance ---
const origStartSharing = startSharing;
startSharing = function() {
  if (!sessionId) return alert("Please scan or generate QR first.");

  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);
  wsRef = ws;

  ws.onopen = () => {
    navigator.geolocation.watchPosition(
      async pos => {
        const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const encryptedName = await encryptUsername(username);

        ws.send(JSON.stringify({ type: "location", coords, ...encryptedName }));
        updateUserMarker(coords, username);
        updateDistanceBox();
      },
      err => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            alert("Location access denied. Please allow location.");
            break;
          case err.POSITION_UNAVAILABLE:
            alert("Location unavailable.");
            break;
          case err.TIMEOUT:
            alert("Location request timed out.");
            break;
          default:
            alert("Location error: " + err.message);
        }
        console.error("Geo error:", err);
      },
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 5000
      }
    );
  };

  ws.onmessage = async ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === "location") {
        peerCoords = d.coords;
        peerName = await decryptUsername(d);
        updatePeerMarker(peerCoords, peerName);
        drawRoute();
        updateDistanceBox();
        alert(`Connected to ${peerName}`);
      } else if (d.type === "msg") {
        const msg = await decryptMessage(d);
        appendChatMsg(peerName || "Peer", msg, false);
      }
    } catch (e) {
      console.error("Decryption error:", e);
    }
  };
};

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
