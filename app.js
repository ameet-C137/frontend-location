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
  username = username || prompt("Enter your username:");
  keyPair = await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const pubRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
  const res = await fetch(`${BACKEND_URL}/create-session`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ key: b64 })
  });
  const { session } = await res.json();
  sessionId = session;
  document.getElementById("qr").innerHTML = `
    <img src="https://api.qrserver.com/v1/create-qr-code/?data=${sessionId}" />
    <p>Scan this QR (one-time use)</p>`;
}

function startQRScanner() {
  username = username || prompt("Enter your username:");
  const scanner = new Html5QrcodeScanner("reader", { fps: 10, qrbox: 250 });
  scanner.render(async decodedText => {
    scanner.clear();
    sessionId = decodedText;
    if (!keyPair) {
      keyPair = await window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true, ["deriveKey"]
      );
    }
    try {
      const res = await fetch(`${BACKEND_URL}/get-key/${sessionId}`);
      if (!res.ok) throw new Error((await res.json()).error);
      const { key } = await res.json();
      const raw = Uint8Array.from(atob(key), c=>c.charCodeAt(0));
      const publicKey = await crypto.subtle.importKey("raw", raw, { name:"ECDH",namedCurve:"P-256" },true,[]);
      sharedKey = await crypto.subtle.deriveKey({ name:"ECDH", public:publicKey }, keyPair.privateKey, { name:"AES-GCM", length:256 }, false, ["encrypt","decrypt"]);
      peerName = prompt("Enter peer's username:");
      alert(`Connected to ${peerName}`);
    } catch(e) {
      alert("Failed to connect: " + e.message);
    }
  });
}

function startSharing() {
  if (!sessionId) return alert("Create or scan QR first");
  const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`);

  ws.onopen = () => {
    navigator.geolocation.watchPosition(pos => {
      const coords = { lat: pos.coords.latitude, lon:pos.coords.longitude };
      ws.send(JSON.stringify({ type:"location", coords, username }));
      updateUserMarker(coords, username);
    }, err => alert("Error getting location: "+err.message));
  };

  ws.onmessage = ev => {
    const d = JSON.parse(ev.data);
    if (d.type === "location") {
      peerCoords = d.coords;
      peerName = d.username;
      updatePeerMarker(peerCoords, peerName);
      drawRoute();
    }
  };
}

function updateUserMarker(coords, name) {
  userMarker && map.removeLayer(userMarker);
  userMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup(name || "You").openPopup();
  map.setView([coords.lat, coords.lon], 13);
}

function updatePeerMarker(coords, name) {
  peerMarker && map.removeLayer(peerMarker);
  peerMarker = L.marker([coords.lat, coords.lon]).addTo(map).bindPopup(name).openPopup();
}

function drawRoute() {
  if (!peerCoords || !userMarker) return;
  const u = userMarker.getLatLng(), p=[peerCoords.lat,peerCoords.lon];
  fetch(`https://router.project-osrm.org/route/v1/driving/${u.lng},${u.lat};${p[1]},${p[0]}?overview=full&geometries=geojson`)
    .then(r=>r.json()).then(d=>{
      d.routes?.[0]?.geometry && (routeLine && map.removeLayer(routeLine),
      routeLine = L.geoJSON(d.routes[0].geometry,{style:{color:'blue'}}).addTo(map));
    });
}
