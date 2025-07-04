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
  try {
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

    if (!res.ok) {
      alert("❌ Failed to create session. Please check your backend.");
      return;
    }

    const data = await res.json();
    sessionId = data.session;

    document.getElementById("qr").innerHTML = `
      <img src="https://api.qrserver.com/v1/create-qr-code/?data=${sessionId}&size=150x150" />
      <p>Scan this QR (one-time use)</p>
    `;
  } catch (err) {
    alert("Error generating QR: " + err.message);
    console.error(err);
  }
}

function startQRScanner() {
  const reader = new Html5Qrcode("reader");
  let scanned = false;

  reader.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 250 },
    async (session) => {
      if (scanned) return;
      scanned = true;
      sessionId = session;
      reader.stop();

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
      sharedKey = await crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, keyPair.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      alert("Key exchange complete. Click Start Sharing.");
    },
    (err) => {
      console.error("QR scan error:", err);
      alert("Error scanning QR: " + err);
    }
  );
}

function startSharing() {
  if (!sessionId) return alert("Create or scan QR first");
  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  ws.onopen = () => {
    navigator.geolocation.watchPosition(pos => {
      const coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      ws.send(JSON.stringify({ type: "location", coords, username }));
      updateUserMarker(coords, username);
      updateMapView();
    }, err => {
      alert("Location access denied or error: " + err.message);
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    });
  };

  ws.onmessage = ev => {
    try {
      const d = JSON.parse(ev.data);
      if (d.type === "location") {
        peerCoords = d.coords;
        peerName = d.username;
        updatePeerMarker(peerCoords, peerName);
        updateMapView();
        drawRoute();
        if (!peerMarker) {
          alert(`Connected to ${peerName}`);
        }
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
    }
  };

  ws.onerror = err => {
    console.error("WebSocket error:", err);
    alert("WebSocket connection error. Please try again.");
  };

  ws.onclose = () => {
    console.log("WebSocket closed");
    alert("Connection to peer lost.");
    if (peerMarker) {
      map.removeLayer(peerMarker);
      peerMarker = null;
      peerCoords = null;
    }
    if (routeLine) {
      map.removeLayer(routeLine);
      routeLine = null;
    }
  };
}

function updateUserMarker(coords, name) {
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([coords.lat, coords.lon])
    .addTo(map)
    .bindPopup(name || "You")
    .openPopup();
}

function updatePeerMarker(coords, name) {
  if (peerMarker) map.removeLayer(peerMarker);
  peerMarker = L.marker([coords.lat, coords.lon])
    .addTo(map)
    .bindPopup(name || "Peer")
    .openPopup();
}

function updateMapView() {
  if (userMarker && peerMarker) {
    const userLatLng = userMarker.getLatLng();
    const peerLatLng = peerMarker.getLatLng();
    const bounds = L.latLngBounds([userLatLng, peerLatLng]);
    map.fitBounds(bounds, { padding: [50, 50] });
  } else if (userMarker) {
    map.setView(userMarker.getLatLng(), 15);
  }
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
    })
    .catch(err => {
      console.error("Route fetch error:", err);
    });
}
