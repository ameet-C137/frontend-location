let keyPair, sharedKey;
let map, userMarker, peerMarker;
let ws;

const BACKEND_URL = "https://server-ku5d.onrender.com"; // Your deployed server
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
  document.getElementById("qr").innerHTML = `
    <img src="https://api.qrserver.com/v1/create-qr-code/?data=${data.sessionId}&size=150x150" />
  `;
}

function startQRScanner() {
  const reader = new Html5Qrcode("reader");
  let scanned = false;

  reader.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 250 },
    async (sessionId) => {
      if (scanned) return;
      scanned = true;

      const success = await deriveSharedKey(sessionId);
      reader.stop();
      document.getElementById("reader").innerHTML = success
        ? "✅ Key Exchange Complete"
        : "❌ Invalid or expired QR key";
    }
  );
}

async function deriveSharedKey(sessionId) {
  try {
    const res = await fetch(`${BACKEND_URL}/consume-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) return false;

    const { key } = await res.json();

    const peerRaw = Uint8Array.from(atob(key), c => c.charCodeAt(0));
    const peerKey = await crypto.subtle.importKey(
      "raw",
      peerRaw,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );

    sharedKey = await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerKey },
      keyPair.privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function startSharing() {
  if (!sharedKey) return alert("❌ Key not established yet.");

  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    navigator.geolocation.watchPosition(async (pos) => {
      const { latitude, longitude } = pos.coords;
      updateUserMarker(latitude, longitude);

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(
        JSON.stringify({ lat: latitude, lon: longitude })
      );
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        sharedKey,
        encoded
      );

      ws.send(JSON.stringify({
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(ciphertext))
      }));
    }, err => {
      alert("Failed to get location: " + err.message);
    }, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10000
    });
  };

  ws.onmessage = async (event) => {
    try {
      const { iv, ciphertext } = JSON.parse(event.data);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        sharedKey,
        new Uint8Array(ciphertext)
      );
      const decoded = JSON.parse(new TextDecoder().decode(decrypted));
      updatePeerMarker(decoded.lat, decoded.lon);
    } catch (e) {
      console.error("Decryption failed", e);
    }
  };

  setTimeout(() => {
    ws.close();
    alert("Location sharing ended after 5 minutes.");
  }, 5 * 60 * 1000);
}

function updateUserMarker(lat, lon) {
  if (userMarker) userMarker.setLatLng([lat, lon]);
  else userMarker = L.marker([lat, lon], { title: "You" }).addTo(map);
  map.setView([lat, lon], 13);
}

function updatePeerMarker(lat, lon) {
  if (peerMarker) peerMarker.setLatLng([lat, lon]);
  else {
    peerMarker = L.marker([lat, lon], {
      title: "Peer",
      icon: L.icon({
        iconUrl: "https://leafletjs.com/examples/custom-icons/leaf-red.png",
        iconSize: [25, 41],
      }),
    }).addTo(map);
  }
}
