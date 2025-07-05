let keyPair, sharedKey;
let map, userMarker, peerMarker;
let ws;
let myName = "";
let peerName = "";

const BACKEND_URL = "https://server-ku5d.onrender.com";
const WS_URL = BACKEND_URL.replace("https", "wss");

initMap();

function initMap() {
  map = L.map('map').setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
  }).addTo(map);
}

async function generateKeys() {
  try {
    // Check secure context
    if (!window.isSecureContext) {
      throw new Error("Web Crypto API requires a secure context (HTTPS or localhost)");
    }

    // Validate peer name
    myName = document.getElementById("peerName").value.trim();
    if (!myName) {
      alert("❌ Please enter your name.");
      return;
    }

    // Generate ECDH key pair
    if (!window.crypto.subtle) {
      throw new Error("Web Crypto API not supported in this browser");
    }
    keyPair = await window.crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey"]
    );

    // Export public key
    const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));

    // Send to backend
    const res = await fetch(`${BACKEND_URL}/create-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: b64, name: myName }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Backend request failed: ${res.status} ${errorText}`);
    }

    const data = await res.json();

    document.getElementById("qr").innerHTML = `
      <img src="https://api.qrserver.com/v1/create-qr-code/?data=${data.sessionId}&size=150x150" alt="QR Code" />
    `;
    document.getElementById("status").innerText = `QR code generated for ${myName}`;
  } catch (e) {
    console.error("Key generation failed:", e.message, e.stack);
    alert(`❌ Failed to generate keys: ${e.message}`);
  }
}

function startQRScanner() {
  if (!window.Html5Qrcode) {
    alert("❌ QR Scanner library not loaded.");
    return;
  }

  const reader = new Html5Qrcode("reader");
  let scanned = false;

  reader.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    async (sessionId) => {
      if (scanned) return;
      scanned = true;

      const success = await deriveSharedKey(sessionId);
      reader.stop();
      document.getElementById("reader").innerHTML = "";
      document.getElementById("status").innerText = success
        ? `✅ Connected to ${peerName}`
        : "❌ Invalid or expired QR key";
    },
    (error) => console.error("QR scan error:", error)
  ).catch((err) => {
    console.error("Failed to start QR scanner:", err);
    alert("❌ Failed to access camera.");
  });
}

function uploadQRImage() {
  if (!window.Html5Qrcode) {
    alert("❌ QR Scanner library not loaded.");
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new Html5Qrcode("reader");
    try {
      const sessionId = await reader.scanFileV2(file, false);
      const success = await deriveSharedKey(sessionId.qrCode);
      document.getElementById("status").innerText = success
        ? `✅ Connected to ${peerName}`
        : "❌ Invalid or expired QR key";
    } catch (e) {
      console.error("QR image scan failed:", e);
      alert("❌ Failed to scan QR code from image.");
    } finally {
      reader.clear();
    }
  };
  input.click();
}

async function deriveSharedKey(sessionId) {
  try {
    const res = await fetch(`${BACKEND_URL}/consume-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (!res.ok) return false;

    const { key, name } = await res.json();
    peerName = name || "Anonymous";

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
    console.error("Key derivation failed:", e);
    return false;
  }
}

function startSharing() {
  if (!sharedKey) return alert("❌ Key not established yet.");

  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("WebSocket connected");
    document.getElementById("status").innerText = `Sharing location with ${peerName}`;
  };
  ws.onerror = (error) => console.error("WebSocket error:", error);
  ws.onclose = () => {
    console.log("WebSocket disconnected");
    document.getElementById("status").innerText = "Location sharing stopped";
  };

  ws.onmessage = async (event) => {
    try {
      const { iv, ciphertext } = JSON.parse(event.data);
      if (!iv || !ciphertext) throw new Error("Invalid message format");

      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(iv) },
        sharedKey,
        new Uint8Array(ciphertext)
      );
      const decoded = JSON.parse(new TextDecoder().decode(decrypted));
      updatePeerMarker(decoded.lat, decoded.lon);
    } catch (e) {
      console.error("Message decryption failed:", e);
    }
  };

  navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      updateUserMarker(latitude, longitude);

      try {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(
          JSON.stringify({ lat: latitude, lon: longitude })
        );
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          sharedKey,
          encoded
        );

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            iv: Array.from(iv),
            ciphertext: Array.from(new Uint8Array(ciphertext))
          }));
        }
      } catch (e) {
        console.error("Encryption failed:", e);
      }
    },
    (error) => console.error("Geolocation error:", error),
    { enableHighAccuracy: true }
  );

  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
      alert("Location sharing expired.");
    }
  }, 5 * 60 * 1000); // 5 mins
}

function updateUserMarker(lat, lon) {
  if (userMarker) userMarker.setLatLng([lat, lon]);
  else userMarker = L.marker([lat, lon], { title: myName || "You" }).addTo(map);
  map.setView([lat, lon], 13);
}

function updatePeerMarker(lat, lon) {
  if (peerMarker) peerMarker.setLatLng([lat, lon]);
  else {
    peerMarker = L.marker([lat, lon], {
      title: peerName || "Peer",
      icon: L.icon({
        iconUrl: "https://leafletjs.com/examples/custom-icons/leaf-red.png",
        iconSize: [25, 41],
      }),
    }).addTo(map);
  }
}
