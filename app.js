let keyPair, sharedKey, sessionId;
let map, userMarker, peerMarker, routeLine;
let peerCoords = null;

const BACKEND_URL = "https://backend-location-bnpl.onrender.com";
const WS_URL = BACKEND_URL.replace("https", "wss");

initMap();

function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
}

async function generateKeys() {
  keyPair = await window.crypto.subtle.generateKey(
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
    <img src="https://api.qrserver.com/v1/create-qr-code/?data=${data.session}" />
  `;
}

function startQRScanner() {
  const scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
  scanner.render(async function(decodedText) {
    try {
      sessionId = decodedText;
      scanner.clear();

      const res = await fetch(`${BACKEND_URL}/get-key/${sessionId}`);
      if (!res.ok) throw new Error("Session not found or already used.");

      const { key } = await res.json();

      const publicKeyRaw = Uint8Array.from(atob(key), c => c.charCodeAt(0));
      const publicKey = await crypto.subtle.importKey(
        "raw",
        publicKeyRaw,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
      );

      sharedKey = await crypto.subtle.deriveKey(
        { name: "ECDH", public: publicKey },
        keyPair.privateKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );

      alert("Connected to peer!");
    } catch (err) {
      alert("Failed to connect: " + err.message);
    }
  });
}

function startSharing() {
  if (!sessionId) return alert("No session established!");
  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  ws.onopen = () => {
    navigator.geolocation.watchPosition(pos => {
      const coords = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude
      };
      ws.send(JSON.stringify({ type: "location", coords }));
      updateUserMarker(coords);
    });
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "location") {
      peerCoords = data.coords;
      updatePeerMarker(peerCoords);
      drawRoute();
    }
  };
}

function updateUserMarker(coords) {
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup("You");
  map.setView([coords.lat, coords.lon], 13);
}

function updatePeerMarker(coords) {
  if (peerMarker) map.removeLayer(peerMarker);
  peerMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup("Peer");
}

function drawRoute() {
  if (!peerCoords || !userMarker) return;
  const u = userMarker.getLatLng();
  const p = [peerCoords.lat, peerCoords.lon];

  fetch(`https://router.project-osrm.org/route/v1/driving/${u.lng},${u.lat};${p[1]},${p[0]}?overview=full&geometries=geojson`)
    .then(res => res.json())
    .then(data => {
      const route = data.routes[0].geometry;
      if (routeLine) map.removeLayer(routeLine);
      routeLine = L.geoJSON(route, { style: { color: 'blue' } }).addTo(map);
    });
}
