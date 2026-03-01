import { db } from './firebase-config.js';
import {
  ref, set, get, onValue, remove, push, update, off
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
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

// ─── LISTENER REFERENCES (store both ref + callback for proper cleanup) ───────
let listenerRefs = {}; // { key: { ref, callback } }

function addListener(key, dbRef, callback) {
  // Remove old listener if exists
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
    try {
      off(listenerRefs[key].ref, listenerRefs[key].callback);
    } catch (e) {}
  });
  listenerRefs = {};
}

export function initCall(myUserID, otherUserID, otherUserName, onEnded) {
  myID = myUserID;
  otherID = otherUserID;
  otherName = otherUserName;
  onCallEndedCallback = onEnded;
  listenForIncomingCall();
  // Note: presence/online status is handled by chat.js listenToPresence()
}

// Listen for online status
function listenForOnlineStatus() {
  addListener('onlineStatus', ref(db, 'presence/' + otherID), (snap) => {
    const statusEl = document.getElementById('chatStatus');
    if (!statusEl) return;
    if (snap.exists() && snap.val() === 'online') {
      statusEl.textContent = 'online';
      statusEl.style.color = '#22C55E';
    } else {
      statusEl.textContent = 'tap for info';
      statusEl.style.color = '';
    }
  });
}

// Set my online presence
export function setOnline(userID) {
  set(ref(db, 'presence/' + userID), 'online');
  window.addEventListener('beforeunload', () => {
    set(ref(db, 'presence/' + userID), 'offline');
  });
}

// ─── START CALL (CALLER) ───────────────────────────────────────────────────────
export async function startCall(type) {
  callType = type;
  callRole = 'caller';
  callID = myID + '_' + otherID + '_' + Date.now();

  try {
    localStream = await getMedia(type);
  } catch (err) {
    alert('Camera/Microphone access denied.');
    return;
  }

  showOutgoingScreen();
  playRingtone();

  // Write ringing signal to receiver's call node
  await set(ref(db, 'calls/' + otherID), {
    callID,
    callerID: myID,
    callerName: localStorage.getItem('aschat_name') || myID, // caller's OWN name
    callType: type,
    status: 'ringing',
    timestamp: Date.now()
  });

  // Setup peer connection
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await push(ref(db, 'calls/' + callID + '/callerCandidates'), e.candidate.toJSON());
    }
  };

  peerConnection.ontrack = (e) => {
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo) remoteVideo.srcObject = e.streams[0];
  };

  // Create and send offer
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await set(ref(db, 'calls/' + callID + '/offer'), { type: offer.type, sdp: offer.sdp });

  // Listen for answer from callee
  addListener('answer', ref(db, 'calls/' + callID + '/answer'), async (snap) => {
    if (!snap.exists() || !peerConnection) return;
    if (peerConnection.signalingState !== 'have-local-offer') return;
    const answer = snap.val();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    showActiveScreen();
  });

  // Listen for callee ICE candidates
  addListener('calleeCandidates', ref(db, 'calls/' + callID + '/calleeCandidates'), (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach(child => {
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(() => {});
    });
  });

  // ── KEY FIX: Caller watches the RECEIVER's call node for status changes ───
  // When receiver declines/ends, they update calls/otherID.status
  addListener('calleeStatus', ref(db, 'calls/' + otherID), (snap) => {
    if (!callRole) return; // already cleaned up

    if (!snap.exists()) {
      // Node deleted — treat as ended if we're still in a call
      return;
    }

    const data = snap.val();
    if (data.status === 'declined') {
      handleCallEnded('declined');
    } else if (data.status === 'ended') {
      handleCallEnded('ended');
    }
  });

  // Missed call after 30 seconds
  missedCallTimer = setTimeout(async () => {
    if (callRole === 'caller') {
      await saveMissedCallMessage();
      // Signal receiver that caller gave up
      await update(ref(db, 'calls/' + otherID), { status: 'missed' }).catch(() => {});
      handleCallEnded('missed');
    }
  }, 30000);
}

// ─── LISTEN FOR INCOMING CALL (CALLEE) ────────────────────────────────────────
function listenForIncomingCall() {
  addListener('incomingCall', ref(db, 'calls/' + myID), async (snap) => {
    if (!snap.exists()) {
      // ── KEY FIX: Node deleted = caller hung up / cancelled ────────────────
      // Only act if we're currently in a callee role (ringing or in call)
      if (callRole === 'callee') {
        handleCallEnded('ended');
      }
      return;
    }

    const data = snap.val();

    // If we already handled an end signal
    if (data.status === 'ended' || data.status === 'missed') {
      if (callRole === 'callee') {
        handleCallEnded('ended');
      }
      return;
    }

    // Ignore if not a ringing signal or not from expected caller
    if (data.status !== 'ringing') return;
    if (data.callerID !== otherID) return;

    // Prevent re-triggering if already in a call
    if (callRole === 'callee') return;

    callID = data.callID;
    callType = data.callType;
    callRole = 'callee';

    showIncomingScreen(data.callerID, data.callType);
    playRingtone();

    // Missed call cleanup after 30 seconds (caller side also fires at 30s)
    missedCallTimer = setTimeout(async () => {
      if (callRole === 'callee') {
        stopRingtone();
        hideAllCallScreens();
        cleanupListeners();
        cleanupCall();
        // Restart listening for new calls
        listenForIncomingCall();
      }
    }, 31000); // slightly longer than caller's 30s to let caller clean up first
  });
}

// ─── ACCEPT CALL (CALLEE) ─────────────────────────────────────────────────────
export async function acceptCall() {
  stopRingtone();
  clearTimeout(missedCallTimer);

  try {
    localStream = await getMedia(callType);
  } catch (err) {
    alert('Camera/Microphone access denied.');
    return;
  }

  // Update status so caller knows call is accepted
  await update(ref(db, 'calls/' + myID), { status: 'accepted' });

  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await push(ref(db, 'calls/' + callID + '/calleeCandidates'), e.candidate.toJSON());
    }
  };

  peerConnection.ontrack = (e) => {
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo) remoteVideo.srcObject = e.streams[0];
  };

  // Get offer
  const offerSnap = await get(ref(db, 'calls/' + callID + '/offer'));
  if (!offerSnap.exists()) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSnap.val()));

  // Create and send answer
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await set(ref(db, 'calls/' + callID + '/answer'), { type: answer.type, sdp: answer.sdp });

  // Get caller ICE candidates
  addListener('callerCandidates', ref(db, 'calls/' + callID + '/callerCandidates'), (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach(child => {
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(() => {});
    });
  });

  await saveCallMessage('started');
  showActiveScreen();
}

// ─── DECLINE CALL (CALLEE) ────────────────────────────────────────────────────
export async function declineCall() {
  stopRingtone();
  clearTimeout(missedCallTimer);

  // Update status so CALLER sees declined, then clean up
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

  // Resume listening for new incoming calls
  listenForIncomingCall();
}

// ─── END CALL (EITHER SIDE) ───────────────────────────────────────────────────
export async function endCall() {
  if (!callRole) return; // prevent double-call

  stopRingtone();
  clearTimeout(missedCallTimer);
  clearInterval(callTimerInterval);

  const duration = formatDuration(callSeconds);
  const currentRole = callRole; // snapshot before cleanup clears it
  const currentCallID = callID;

  try {
    if (currentRole === 'caller') {
      // ── KEY FIX: Update the receiver's call node so they see "ended" ──────
      await update(ref(db, 'calls/' + otherID), { status: 'ended' });
    } else {
      // ── KEY FIX: Update my call node so caller sees "ended" ───────────────
      await update(ref(db, 'calls/' + myID), { status: 'ended' });
    }

    await saveCallMessage('ended', duration);
  } catch (err) { console.error('End call error:', err); }

  // Clean up Firebase nodes after a short delay (gives other side time to read status)
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

  // Resume listening for new incoming calls
  listenForIncomingCall();
}

// ─── HANDLE CALL ENDED (remote side hung up / declined / missed) ──────────────
function handleCallEnded(reason) {
  if (!callRole) return; // prevent double-firing

  stopRingtone();
  clearTimeout(missedCallTimer);
  clearInterval(callTimerInterval);

  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();

  // Resume listening for new incoming calls
  listenForIncomingCall();
}

// ─── CLEANUP CALL STATE ───────────────────────────────────────────────────────
function cleanupCall() {
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
async function getMedia(type) {
  if (type === 'video') {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
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
    document.getElementById('remoteVideo').style.display = 'block';
    document.getElementById('localVideo').style.display = 'block';
    document.getElementById('camBtn').style.display = 'flex';
    if (localStream) document.getElementById('localVideo').srcObject = localStream;
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
  const screens = ['outgoingCallScreen', 'incomingCallScreen', 'activeCallScreen'];
  screens.forEach(id => {
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
  if (ringtone) {
    ringtone.loop = true;
    ringtone.play().catch(() => {});
  }
}

function stopRingtone() {
  const ringtone = document.getElementById('ringtone');
  if (ringtone) {
    ringtone.loop = false;
    ringtone.pause();
    ringtone.currentTime = 0;
  }
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
