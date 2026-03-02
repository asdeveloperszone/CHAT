import { db } from './firebase-config.js';
import {
  ref, set, get, onValue, remove, push, update, off
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // FREE TURN relay servers — replace with your own credentials in production
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ],
  iceCandidatePoolSize: 10
};

let peerConnection = null;
let localStream = null;
let callType = null;
let callRole = null;
let callID = null;
let callTimerInterval = null;
let callSeconds = 0;
let missedCallTimer = null;
let isMuted = false;
let isSpeaker = false;
let isCamOff = false;
let myID = null;
let otherID = null;
let otherName = null;
let onCallEndedCallback = null;

// ─── LISTENER REFERENCES ──────────────────────────────────────────────────────
let listenerRefs = {};

function addListener(key, dbRef, callback) {
  removeListener(key);
  onValue(dbRef, callback);
  listenerRefs[key] = { ref: dbRef, callback };
}

function removeListener(key) {
  if (listenerRefs[key]) {
    off(listenerRefs[key].ref, listenerRefs[key].callback);
    delete listenerRefs[key];
  }
}

function cleanupListeners() {
  Object.keys(listenerRefs).forEach(key => {
    try { off(listenerRefs[key].ref, listenerRefs[key].callback); } catch (e) {}
  });
  listenerRefs = {};
}

export function initCall(myUserID, otherUserID, otherUserName, onEnded) {
  myID = myUserID;
  otherID = otherUserID;
  otherName = otherUserName;
  onCallEndedCallback = onEnded;
  listenForIncomingCall();
}

export function setOnline(userID) {
  set(ref(db, 'presence/' + userID), 'online');
  window.addEventListener('beforeunload', () => {
    set(ref(db, 'presence/' + userID), 'offline');
  });
}

// ─── CREATE PEER CONNECTION ────────────────────────────────────────────────────
// FIX: Centralized so ontrack is ALWAYS registered before any signaling begins.
// The original code registered ontrack AFTER addTrack/offer creation which could
// cause the remote stream event to be missed, especially on mobile Chrome.
function createPeerConnection(onRemoteStream) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  // FIX: e.streams[0] can be undefined on Android Chrome — build stream from track if needed
  pc.ontrack = (e) => {
    console.log('[WebRTC] ontrack:', e.track.kind, 'streams:', e.streams.length);
    let stream;
    if (e.streams && e.streams[0]) {
      stream = e.streams[0];
    } else {
      stream = new MediaStream();
      stream.addTrack(e.track);
    }
    onRemoteStream(stream);
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE state:', pc.iceConnectionState);
    // Force remote video play when ICE connects
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      const remoteVideo = document.getElementById('remoteVideo');
      if (remoteVideo && remoteVideo.srcObject && remoteVideo.paused) {
        remoteVideo.play().catch(() => {});
      }
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection:', pc.connectionState);
  };

  return pc;
}

// ─── SET REMOTE STREAM ────────────────────────────────────────────────────────
function setRemoteStream(stream) {
  const remoteVideo = document.getElementById('remoteVideo');
  if (!remoteVideo) return;
  console.log('[WebRTC] Setting remote stream, tracks:', stream.getTracks().length);
  remoteVideo.srcObject = stream;
  // FIX: Mobile browsers need explicit play() call — autoplay attribute alone is not enough
  remoteVideo.play().catch(err => console.warn('[WebRTC] Remote play():', err));
}

// ─── START CALL (CALLER) ──────────────────────────────────────────────────────
export async function startCall(type) {
  callType = type;
  callRole = 'caller';
  callID = myID + '_' + otherID + '_' + Date.now();

  try {
    localStream = await getMedia(type);
  } catch (err) {
    alert('Camera/Microphone access denied. Please allow permissions and try again.');
    return;
  }

  showOutgoingScreen();
  playRingtone();

  await set(ref(db, 'calls/' + otherID), {
    callID,
    callerID: myID,
    callerName: localStorage.getItem('aschat_name') || myID,
    callType: type,
    status: 'ringing',
    timestamp: Date.now()
  });

  // FIX: Create peer connection (with ontrack) BEFORE addTrack and createOffer
  peerConnection = createPeerConnection(setRemoteStream);

  localStream.getTracks().forEach(track => {
    console.log('[WebRTC] Caller addTrack:', track.kind);
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await push(ref(db, 'calls/' + callID + '/callerCandidates'), e.candidate.toJSON());
    }
  };

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await set(ref(db, 'calls/' + callID + '/offer'), { type: offer.type, sdp: offer.sdp });
  console.log('[WebRTC] Caller: offer sent');

  addListener('answer', ref(db, 'calls/' + callID + '/answer'), async (snap) => {
    if (!snap.exists() || !peerConnection) return;
    if (peerConnection.signalingState !== 'have-local-offer') return;
    console.log('[WebRTC] Caller: got answer');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(snap.val()));
    showActiveScreen();
  });

  const addedCalleeCandidates = new Set();
  addListener('calleeCandidates', ref(db, 'calls/' + callID + '/calleeCandidates'), (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach(child => {
      if (addedCalleeCandidates.has(child.key)) return;
      addedCalleeCandidates.add(child.key);
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(e =>
        console.warn('[WebRTC] addIceCandidate:', e)
      );
    });
  });

  addListener('calleeStatus', ref(db, 'calls/' + otherID), (snap) => {
    if (!callRole) return;
    if (!snap.exists()) return;
    const data = snap.val();
    if (data.status === 'declined') handleCallEnded('declined');
    else if (data.status === 'ended') handleCallEnded('ended');
  });

  missedCallTimer = setTimeout(async () => {
    if (callRole === 'caller') {
      await saveMissedCallMessage();
      await update(ref(db, 'calls/' + otherID), { status: 'missed' }).catch(() => {});
      handleCallEnded('missed');
    }
  }, 30000);
}

// ─── LISTEN FOR INCOMING CALL (CALLEE) ────────────────────────────────────────
function listenForIncomingCall() {
  addListener('incomingCall', ref(db, 'calls/' + myID), async (snap) => {
    if (!snap.exists()) {
      if (callRole === 'callee') handleCallEnded('ended');
      return;
    }

    const data = snap.val();
    if (data.status === 'ended' || data.status === 'missed') {
      if (callRole === 'callee') handleCallEnded('ended');
      return;
    }
    if (data.status !== 'ringing') return;
    if (data.callerID !== otherID) return;
    if (callRole === 'callee') return;

    callID = data.callID;
    callType = data.callType;
    callRole = 'callee';

    showIncomingScreen(data.callerID, data.callType);
    playRingtone();

    missedCallTimer = setTimeout(async () => {
      if (callRole === 'callee') {
        stopRingtone();
        hideAllCallScreens();
        cleanupListeners();
        cleanupCall();
        listenForIncomingCall();
      }
    }, 31000);
  });
}

// ─── ACCEPT CALL (CALLEE) ─────────────────────────────────────────────────────
export async function acceptCall() {
  stopRingtone();
  clearTimeout(missedCallTimer);

  try {
    localStream = await getMedia(callType);
  } catch (err) {
    alert('Camera/Microphone access denied. Please allow permissions and try again.');
    return;
  }

  await update(ref(db, 'calls/' + myID), { status: 'accepted' });

  // FIX: Create peer connection (with ontrack) BEFORE addTrack and setRemoteDescription
  peerConnection = createPeerConnection(setRemoteStream);

  localStream.getTracks().forEach(track => {
    console.log('[WebRTC] Callee addTrack:', track.kind);
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await push(ref(db, 'calls/' + callID + '/calleeCandidates'), e.candidate.toJSON());
    }
  };

  const offerSnap = await get(ref(db, 'calls/' + callID + '/offer'));
  if (!offerSnap.exists()) {
    console.error('[WebRTC] No offer found!');
    return;
  }

  console.log('[WebRTC] Callee: setting remote description (offer)');
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSnap.val()));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await set(ref(db, 'calls/' + callID + '/answer'), { type: answer.type, sdp: answer.sdp });
  console.log('[WebRTC] Callee: answer sent');

  const addedCallerCandidates = new Set();
  addListener('callerCandidates', ref(db, 'calls/' + callID + '/callerCandidates'), (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach(child => {
      if (addedCallerCandidates.has(child.key)) return;
      addedCallerCandidates.add(child.key);
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(e =>
        console.warn('[WebRTC] addIceCandidate:', e)
      );
    });
  });

  await saveCallMessage('started');
  showActiveScreen();
}

// ─── DECLINE CALL ─────────────────────────────────────────────────────────────
export async function declineCall() {
  stopRingtone();
  clearTimeout(missedCallTimer);

  try {
    await update(ref(db, 'calls/' + myID), { status: 'declined' });
    await saveCallMessage('declined');
  } catch (e) {}

  setTimeout(async () => {
    await remove(ref(db, 'calls/' + myID)).catch(() => {});
    if (callID) await remove(ref(db, 'calls/' + callID)).catch(() => {});
  }, 1500);

  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();
  listenForIncomingCall();
}

// ─── END CALL ─────────────────────────────────────────────────────────────────
export async function endCall() {
  if (!callRole) return;

  stopRingtone();
  clearTimeout(missedCallTimer);
  clearInterval(callTimerInterval);

  const duration = formatDuration(callSeconds);
  const currentRole = callRole;
  const currentCallID = callID;

  try {
    if (currentRole === 'caller') {
      await update(ref(db, 'calls/' + otherID), { status: 'ended' });
    } else {
      await update(ref(db, 'calls/' + myID), { status: 'ended' });
    }
    await saveCallMessage('ended', duration);
  } catch (err) { console.error('End call error:', err); }

  setTimeout(async () => {
    try {
      if (currentRole === 'caller') {
        await remove(ref(db, 'calls/' + otherID));
      } else {
        await remove(ref(db, 'calls/' + myID));
      }
      if (currentCallID) await remove(ref(db, 'calls/' + currentCallID));
    } catch (e) {}
  }, 2000);

  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();
  listenForIncomingCall();
}

// ─── HANDLE CALL ENDED (remote side) ─────────────────────────────────────────
function handleCallEnded(reason) {
  if (!callRole) return;
  stopRingtone();
  clearTimeout(missedCallTimer);
  clearInterval(callTimerInterval);
  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();
  listenForIncomingCall();
}

// ─── CLEANUP ──────────────────────────────────────────────────────────────────
function cleanupCall() {
  // FIX: Clear srcObject to release camera and avoid frozen frames
  const remoteVideo = document.getElementById('remoteVideo');
  const localVideo = document.getElementById('localVideo');
  const localVideoOut = document.getElementById('localVideoOut');
  if (remoteVideo) remoteVideo.srcObject = null;
  if (localVideo) localVideo.srcObject = null;
  if (localVideoOut) localVideoOut.srcObject = null;

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  callID = null;
  callRole = null;
  callSeconds = 0;
  isMuted = false;
  isSpeaker = false;
  isCamOff = false;
}

// ─── GET MEDIA ────────────────────────────────────────────────────────────────
// FIX: Use ideal constraints not exact — exact can silently fail on Android
async function getMedia(type) {
  if (type === 'video') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });
      console.log('[Media] Got video stream, tracks:', stream.getTracks().map(t => t.kind));
      return stream;
    } catch (err) {
      console.warn('[Media] Fallback to basic video...', err);
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    }
  }
  return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

// ─── SHOW SCREENS ─────────────────────────────────────────────────────────────
function showOutgoingScreen() {
  hideAllCallScreens();
  document.getElementById('outgoingCallScreen').style.display = 'flex';

  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[otherID];
  const avatar = document.getElementById('outCallAvatar');
  if (contact && contact.photo) {
    avatar.innerHTML = `<img src="${contact.photo}" />`;
  } else {
    avatar.textContent = otherName.charAt(0).toUpperCase();
  }

  document.getElementById('outCallName').textContent = otherName;
  document.getElementById('outCallStatus').textContent =
    callType === 'video' ? '📹 Video Calling...' : '📞 Voice Calling...';

  if (callType === 'video' && localStream) {
    const localOut = document.getElementById('localVideoOut');
    if (localOut) {
      localOut.srcObject = localStream;
      localOut.style.display = 'block';
      localOut.play().catch(() => {});
    }
  }
}

function showIncomingScreen(callerID, type) {
  hideAllCallScreens();
  document.getElementById('incomingCallScreen').style.display = 'flex';

  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[callerID];
  const name = contact ? contact.name : otherName;

  const avatar = document.getElementById('inCallAvatar');
  if (contact && contact.photo) {
    avatar.innerHTML = `<img src="${contact.photo}" />`;
  } else {
    avatar.textContent = name.charAt(0).toUpperCase();
  }

  document.getElementById('inCallName').textContent = name;
  document.getElementById('inCallTypeLabel').textContent =
    type === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Voice Call';
}

function showActiveScreen() {
  hideAllCallScreens();
  document.getElementById('activeCallScreen').style.display = 'flex';

  const contacts = JSON.parse(localStorage.getItem('aschat_contacts') || '{}');
  const contact = contacts[otherID];
  const avatar = document.getElementById('activeCallAvatar');
  if (contact && contact.photo) {
    avatar.innerHTML = `<img src="${contact.photo}" />`;
  } else {
    avatar.textContent = otherName.charAt(0).toUpperCase();
  }

  document.getElementById('activeCallName').textContent = otherName;

  if (callType === 'video') {
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideo = document.getElementById('localVideo');

    remoteVideo.style.display = 'block';
    localVideo.style.display = 'block';
    document.getElementById('camBtn').style.display = 'flex';

    // FIX: Explicitly set srcObject and call play() — autoplay alone unreliable on mobile
    if (localStream) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(err => console.warn('[Media] localVideo play():', err));
    }

    // If remote stream already arrived before showActiveScreen, force play
    if (remoteVideo.srcObject) {
      remoteVideo.play().catch(err => console.warn('[Media] remoteVideo play():', err));
    }
  } else {
    document.getElementById('remoteVideo').style.display = 'none';
    document.getElementById('localVideo').style.display = 'none';
  }

  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    document.getElementById('callTimer').textContent = formatDuration(callSeconds);
  }, 1000);
}

function hideAllCallScreens() {
  ['outgoingCallScreen', 'incomingCallScreen', 'activeCallScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// ─── CONTROLS ─────────────────────────────────────────────────────────────────
export function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  btn.innerHTML = isMuted
    ? '<i class="fa-solid fa-microphone-slash"></i><span>Unmute</span>'
    : '<i class="fa-solid fa-microphone"></i><span>Mute</span>';
  btn.classList.toggle('active', isMuted);
}

export function toggleSpeaker() {
  isSpeaker = !isSpeaker;
  const btn = document.getElementById('speakerBtn');
  btn.innerHTML = isSpeaker
    ? '<i class="fa-solid fa-volume-xmark"></i><span>Speaker</span>'
    : '<i class="fa-solid fa-volume-high"></i><span>Speaker</span>';
  btn.classList.toggle('active', isSpeaker);
}

export function toggleCamera() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  btn.innerHTML = isCamOff
    ? '<i class="fa-solid fa-video-slash"></i><span>Camera</span>'
    : '<i class="fa-solid fa-video"></i><span>Camera</span>';
  btn.classList.toggle('active', isCamOff);
}

// ─── RINGTONE ─────────────────────────────────────────────────────────────────
function playRingtone() {
  const ringtone = document.getElementById('ringtone');
  if (ringtone) { ringtone.loop = true; ringtone.play().catch(() => {}); }
}

function stopRingtone() {
  const ringtone = document.getElementById('ringtone');
  if (ringtone) { ringtone.loop = false; ringtone.pause(); ringtone.currentTime = 0; }
}

// ─── CALL MESSAGES ────────────────────────────────────────────────────────────
async function saveCallMessage(status, duration) {
  if (!myID || !otherID) return;
  const chatKey = [myID, otherID].sort().join('_');
  const icon = callType === 'video' ? '📹' : '📞';
  let text = '';

  if (status === 'started') {
    text = `${icon} ${callType === 'video' ? 'Video' : 'Voice'} call started`;
  } else if (status === 'ended') {
    text = `${icon} ${callType === 'video' ? 'Video' : 'Voice'} call ended${duration ? ' • ' + duration : ''}`;
  } else if (status === 'declined') {
    text = `${icon} Call declined`;
  }

  if (!text) return;

  try {
    await push(ref(db, 'messages/' + chatKey), {
      text, msgType: 'call', callType,
      callStatus: status, senderID: myID,
      receiverID: otherID, status: 'sent',
      timestamp: Date.now()
    });
  } catch (err) { console.error('Call message error:', err); }
}

async function saveMissedCallMessage() {
  if (!myID || !otherID) return;
  const chatKey = [myID, otherID].sort().join('_');
  const icon = callType === 'video' ? '📹' : '📞';
  const text = `${icon} Missed ${callType === 'video' ? 'video' : 'voice'} call`;

  try {
    await push(ref(db, 'messages/' + chatKey), {
      text, msgType: 'call', callType,
      callStatus: 'missed', senderID: myID,
      receiverID: otherID, status: 'sent',
      timestamp: Date.now()
    });
  } catch (err) { console.error('Missed call message error:', err); }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
