import { db } from './firebase-config.js';
import {
  ref, set, get, onValue, remove, push, update, off
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

// ─── ICE / TURN CONFIG ────────────────────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // TURN relay — required for mobile-to-mobile through carrier NAT
    // Replace with your own credentials from metered.ca for production
    { urls: 'turn:openrelay.metered.ca:80',        username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',       username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
  ],
  iceCandidatePoolSize: 10
};

// ─── STATE ────────────────────────────────────────────────────────────────────
let peerConnection   = null;
let localStream      = null;
let remoteStream     = null;   // track remote stream separately
let callType         = null;
let callRole         = null;   // 'caller' | 'callee' | null
let callID           = null;
let callTimerInterval = null;
let callSeconds      = 0;
let missedCallTimer  = null;
let isMuted          = false;
let isCamOff         = false;
let myID             = null;
let otherID          = null;
let otherName        = null;
let isEndingCall     = false;  // guard against double-fire

// ─── FIREBASE LISTENER REGISTRY ───────────────────────────────────────────────
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
    try { off(listenerRefs[key].ref, listenerRefs[key].callback); } catch (_) {}
  });
  listenerRefs = {};
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initCall(myUserID, otherUserID, otherUserName, onEnded) {
  myID      = myUserID;
  otherID   = otherUserID;
  otherName = otherUserName;
  listenForIncomingCall();
}

export function setOnline(userID) {
  set(ref(db, 'presence/' + userID), 'online');
  window.addEventListener('beforeunload', () => {
    set(ref(db, 'presence/' + userID), 'offline');
  });
}

// ─── CREATE PEER CONNECTION ───────────────────────────────────────────────────
// ontrack registered FIRST — before addTrack/createOffer — so no event is missed
function createPeerConnection() {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  // BUG FIX: e.streams[0] is undefined on some Android Chrome builds.
  // Accumulate tracks into our own MediaStream manually.
  remoteStream = new MediaStream();

  pc.ontrack = (e) => {
    console.log('[RTC] ontrack:', e.track.kind);
    remoteStream.addTrack(e.track);
    attachRemoteStream();          // safe to call multiple times
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[RTC] ICE:', pc.iceConnectionState);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      attachRemoteStream();        // ensure video plays when ICE finishes
    }
    // BUG FIX: detect dropped connection (e.g. network loss) and end call cleanly
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      console.warn('[RTC] ICE failed/disconnected — ending call');
      endCall();
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[RTC] Connection:', pc.connectionState);
    if (pc.connectionState === 'failed') {
      console.warn('[RTC] Connection failed — ending call');
      endCall();
    }
  };

  return pc;
}

// ─── ATTACH REMOTE STREAM TO VIDEO ELEMENT ────────────────────────────────────
// BUG FIX: Called both from ontrack AND from showActiveScreen so we never miss
// the case where tracks arrive before or after the screen is displayed.
function attachRemoteStream() {
  const remoteVideo = document.getElementById('remoteVideo');
  if (!remoteVideo || !remoteStream) return;
  if (remoteStream.getTracks().length === 0) return;

  // Only reassign if different to avoid interrupting a playing stream
  if (remoteVideo.srcObject !== remoteStream) {
    remoteVideo.srcObject = remoteStream;
  }
  // BUG FIX: Explicit play() — autoplay attribute alone is not reliable on mobile
  if (remoteVideo.paused) {
    remoteVideo.play().catch(err => console.warn('[RTC] remoteVideo.play():', err));
  }
}

// ─── GET CAMERA/MIC ───────────────────────────────────────────────────────────
// BUG FIX: Use ideal (not exact) constraints — exact facingMode silently fails
// on many Android devices returning no video track at all.
async function getMedia(type) {
  if (type === 'video') {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } }
      });
    } catch (err) {
      console.warn('[Media] Falling back to basic video:', err);
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    }
  }
  return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

// ─── START CALL (CALLER) ──────────────────────────────────────────────────────
export async function startCall(type) {
  if (callRole) return;  // already in a call

  callType = type;
  callRole = 'caller';
  callID   = myID + '_' + otherID + '_' + Date.now();
  isEndingCall = false;

  try {
    localStream = await getMedia(type);
  } catch (err) {
    alert('Camera/Microphone access denied. Please allow permissions and try again.');
    callRole = null;
    return;
  }

  showOutgoingScreen();
  playRingtone();

  // Write ringing signal to callee's node
  await set(ref(db, 'calls/' + otherID), {
    callID, callerID: myID,
    callerName: localStorage.getItem('aschat_name') || myID,
    callType: type, status: 'ringing', timestamp: Date.now()
  });

  // BUG FIX: Create PC and register ontrack BEFORE addTrack / createOffer
  peerConnection = createPeerConnection();

  localStream.getTracks().forEach(track => {
    console.log('[RTC] Caller addTrack:', track.kind);
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
  console.log('[RTC] Offer sent');

  // Listen for callee's answer
  addListener('answer', ref(db, 'calls/' + callID + '/answer'), async (snap) => {
    if (!snap.exists() || !peerConnection) return;
    if (peerConnection.signalingState !== 'have-local-offer') return;
    console.log('[RTC] Got answer');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(snap.val()));
    showActiveScreen();
  });

  // BUG FIX: Deduplicate ICE candidates — onValue re-fires all children on any change
  const seenCallee = new Set();
  addListener('calleeCandidates', ref(db, 'calls/' + callID + '/calleeCandidates'), (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach(child => {
      if (seenCallee.has(child.key)) return;
      seenCallee.add(child.key);
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(e =>
        console.warn('[RTC] addIceCandidate:', e));
    });
  });

  // BUG FIX: Watch callee's node for status changes (declined / ended)
  // Also handles the case where callee node is DELETED (caller cancelled)
  addListener('calleeStatus', ref(db, 'calls/' + otherID), (snap) => {
    if (isEndingCall || !callRole) return;
    if (!snap.exists()) return;  // deletion handled separately if needed
    const status = snap.val().status;
    if (status === 'declined') handleRemoteEnded('declined');
    else if (status === 'ended') handleRemoteEnded('ended');
  });

  // Missed call timeout
  missedCallTimer = setTimeout(async () => {
    if (callRole === 'caller') {
      await saveMissedCallMessage();
      await update(ref(db, 'calls/' + otherID), { status: 'missed' }).catch(() => {});
      handleRemoteEnded('missed');
    }
  }, 30000);
}

// ─── LISTEN FOR INCOMING CALL (CALLEE) ────────────────────────────────────────
function listenForIncomingCall() {
  addListener('incomingCall', ref(db, 'calls/' + myID), async (snap) => {
    // BUG FIX: Node deleted = caller hung up before answer
    if (!snap.exists()) {
      if (callRole === 'callee') handleRemoteEnded('ended');
      return;
    }

    const data = snap.val();

    // Handle remote end signals arriving on our node
    if (data.status === 'ended' || data.status === 'missed') {
      if (callRole === 'callee') handleRemoteEnded('ended');
      return;
    }

    // Only handle fresh ringing signals
    if (data.status !== 'ringing') return;
    if (data.callerID !== otherID) return;  // call from someone else — ignore
    if (callRole) return;                   // already in a call

    callID   = data.callID;
    callType = data.callType;
    callRole = 'callee';
    isEndingCall = false;

    showIncomingScreen(data.callerID, data.callType);
    playRingtone();

    // Auto-dismiss if caller gives up at 30s
    missedCallTimer = setTimeout(() => {
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

  // Signal caller that we picked up
  await update(ref(db, 'calls/' + myID), { status: 'accepted' });

  // BUG FIX: Create PC and register ontrack BEFORE addTrack / setRemoteDescription
  peerConnection = createPeerConnection();

  localStream.getTracks().forEach(track => {
    console.log('[RTC] Callee addTrack:', track.kind);
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.onicecandidate = async (e) => {
    if (e.candidate) {
      await push(ref(db, 'calls/' + callID + '/calleeCandidates'), e.candidate.toJSON());
    }
  };

  // Fetch and apply the caller's offer
  const offerSnap = await get(ref(db, 'calls/' + callID + '/offer'));
  if (!offerSnap.exists()) {
    console.error('[RTC] Offer not found — caller may have hung up');
    cleanupCall();
    listenForIncomingCall();
    return;
  }

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSnap.val()));
  console.log('[RTC] Remote description set');

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await set(ref(db, 'calls/' + callID + '/answer'), { type: answer.type, sdp: answer.sdp });
  console.log('[RTC] Answer sent');

  // BUG FIX: Deduplicate ICE candidates
  const seenCaller = new Set();
  addListener('callerCandidates', ref(db, 'calls/' + callID + '/callerCandidates'), (snap) => {
    if (!snap.exists() || !peerConnection) return;
    snap.forEach(child => {
      if (seenCaller.has(child.key)) return;
      seenCaller.add(child.key);
      peerConnection.addIceCandidate(new RTCIceCandidate(child.val())).catch(e =>
        console.warn('[RTC] addIceCandidate:', e));
    });
  });

  await saveCallMessage('started');
  showActiveScreen();
}

// ─── DECLINE CALL (CALLEE) ────────────────────────────────────────────────────
export async function declineCall() {
  stopRingtone();
  clearTimeout(missedCallTimer);

  const currentMyID  = myID;
  const currentCallID = callID;

  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();

  try {
    await update(ref(db, 'calls/' + currentMyID), { status: 'declined' });
    await saveCallMessage('declined');
  } catch (_) {}

  // BUG FIX: Clean up BOTH Firebase nodes
  setTimeout(async () => {
    await remove(ref(db, 'calls/' + currentMyID)).catch(() => {});
    if (currentCallID) await remove(ref(db, 'calls/' + currentCallID)).catch(() => {});
  }, 1500);

  listenForIncomingCall();
}

// ─── END CALL (LOCAL HANGUP — EITHER SIDE) ────────────────────────────────────
export async function endCall() {
  if (!callRole || isEndingCall) return;
  isEndingCall = true;

  stopRingtone();
  clearTimeout(missedCallTimer);
  clearInterval(callTimerInterval);

  const duration      = formatDuration(callSeconds);
  const currentRole   = callRole;
  const currentCallID = callID;
  const currentMyID   = myID;
  const currentOtherID = otherID;

  // BUG FIX: Cleanup UI and local state FIRST so when the 'ended' write bounces
  // back through our own listeners it finds callRole=null and does nothing.
  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();

  // Signal the other side
  try {
    if (currentRole === 'caller') {
      // Caller writes to callee's node (what callee's incomingCall listener watches)
      await update(ref(db, 'calls/' + currentOtherID), { status: 'ended' });
    } else {
      // Callee writes to own node (what caller's calleeStatus listener watches)
      await update(ref(db, 'calls/' + currentMyID), { status: 'ended' });
    }
    await saveCallMessage('ended', duration);
  } catch (err) {
    console.error('[Call] endCall signal error:', err);
  }

  // BUG FIX: Clean up ALL Firebase nodes after delay so the other side can read 'ended'
  setTimeout(async () => {
    await remove(ref(db, 'calls/' + currentOtherID)).catch(() => {});
    await remove(ref(db, 'calls/' + currentMyID)).catch(() => {});
    if (currentCallID) await remove(ref(db, 'calls/' + currentCallID)).catch(() => {});
  }, 2500);

  listenForIncomingCall();
}

// ─── HANDLE REMOTE HANGUP / MISSED / DECLINED ────────────────────────────────
function handleRemoteEnded(reason) {
  if (!callRole || isEndingCall) return;
  isEndingCall = true;

  console.log('[Call] Remote ended:', reason);

  stopRingtone();
  clearTimeout(missedCallTimer);
  clearInterval(callTimerInterval);

  const currentMyID   = myID;
  const currentCallID = callID;

  hideAllCallScreens();
  cleanupListeners();
  cleanupCall();

  // BUG FIX: Clean up our own orphaned Firebase nodes so the next call attempt
  // doesn't find stale 'ended' data and fail immediately.
  setTimeout(async () => {
    await remove(ref(db, 'calls/' + currentMyID)).catch(() => {});
    if (currentCallID) await remove(ref(db, 'calls/' + currentCallID)).catch(() => {});
  }, 1000);

  listenForIncomingCall();
}

// ─── CLEANUP LOCAL STATE ──────────────────────────────────────────────────────
function cleanupCall() {
  // BUG FIX: Always null out srcObject before stopping tracks — avoids frozen
  // camera indicator on iOS and ghost streams on the next call
  const rv  = document.getElementById('remoteVideo');
  const lv  = document.getElementById('localVideo');
  const lvo = document.getElementById('localVideoOut');
  if (rv)  { rv.pause();  rv.srcObject  = null; }
  if (lv)  { lv.pause();  lv.srcObject  = null; }
  if (lvo) { lvo.pause(); lvo.srcObject = null; }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.ontrack           = null;
    peerConnection.onicecandidate    = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.onconnectionstatechange    = null;
    peerConnection.close();
    peerConnection = null;
  }

  remoteStream  = null;
  callID        = null;
  callRole      = null;
  callSeconds   = 0;
  isMuted       = false;
  isCamOff      = false;
  isEndingCall  = false;

  // Reset control buttons to default state
  const muteBtn = document.getElementById('muteBtn');
  const camBtn  = document.getElementById('camBtn');
  if (muteBtn) muteBtn.innerHTML = '<i class="fa-solid fa-microphone"></i><span>Mute</span>';
  if (camBtn)  camBtn.innerHTML  = '<i class="fa-solid fa-video"></i><span>Camera</span>';
}

// ─── SHOW OUTGOING SCREEN ─────────────────────────────────────────────────────
function showOutgoingScreen() {
  hideAllCallScreens();
  document.getElementById('outgoingCallScreen').style.display = 'flex';

  const contact = (JSON.parse(localStorage.getItem('aschat_contacts') || '{}'))[otherID];
  const avatar  = document.getElementById('outCallAvatar');
  if (contact?.photo) avatar.innerHTML = `<img src="${contact.photo}" />`;
  else avatar.textContent = otherName.charAt(0).toUpperCase();

  document.getElementById('outCallName').textContent   = otherName;
  document.getElementById('outCallStatus').textContent =
    callType === 'video' ? '📹 Video Calling...' : '📞 Voice Calling...';

  // BUG FIX: Show local camera preview during outgoing ring + explicit play()
  if (callType === 'video' && localStream) {
    const lvo = document.getElementById('localVideoOut');
    if (lvo) {
      lvo.srcObject = localStream;
      lvo.style.display = 'block';
      lvo.play().catch(() => {});
    }
  }
}

// ─── SHOW INCOMING SCREEN ─────────────────────────────────────────────────────
function showIncomingScreen(callerID, type) {
  hideAllCallScreens();
  document.getElementById('incomingCallScreen').style.display = 'flex';

  const contact = (JSON.parse(localStorage.getItem('aschat_contacts') || '{}'))[callerID];
  const name    = contact?.name || otherName;
  const avatar  = document.getElementById('inCallAvatar');
  if (contact?.photo) avatar.innerHTML = `<img src="${contact.photo}" />`;
  else avatar.textContent = name.charAt(0).toUpperCase();

  document.getElementById('inCallName').textContent      = name;
  document.getElementById('inCallTypeLabel').textContent =
    type === 'video' ? '📹 Incoming Video Call' : '📞 Incoming Voice Call';
}

// ─── SHOW ACTIVE CALL SCREEN ──────────────────────────────────────────────────
function showActiveScreen() {
  hideAllCallScreens();
  document.getElementById('activeCallScreen').style.display = 'flex';

  const contact = (JSON.parse(localStorage.getItem('aschat_contacts') || '{}'))[otherID];
  const avatar  = document.getElementById('activeCallAvatar');
  if (contact?.photo) avatar.innerHTML = `<img src="${contact.photo}" />`;
  else avatar.textContent = otherName.charAt(0).toUpperCase();

  document.getElementById('activeCallName').textContent = otherName;

  if (callType === 'video') {
    const remoteVideo = document.getElementById('remoteVideo');
    const localVideo  = document.getElementById('localVideo');
    const camBtn      = document.getElementById('camBtn');

    remoteVideo.style.display = 'block';
    localVideo.style.display  = 'block';
    if (camBtn) camBtn.style.display = 'flex';

    // BUG FIX: Set local video and force play — autoplay attribute alone fails on mobile
    if (localStream) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(err => console.warn('[Media] localVideo.play():', err));
    }

    // BUG FIX: Remote stream may have already arrived before screen shown.
    // attachRemoteStream() checks and plays if ready.
    attachRemoteStream();

  } else {
    document.getElementById('remoteVideo').style.display = 'none';
    document.getElementById('localVideo').style.display  = 'none';
  }

  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const el = document.getElementById('callTimer');
    if (el) el.textContent = formatDuration(callSeconds);
  }, 1000);
}

function hideAllCallScreens() {
  ['outgoingCallScreen', 'incomingCallScreen', 'activeCallScreen'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// ─── CALL CONTROLS ────────────────────────────────────────────────────────────
export function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  if (btn) {
    btn.innerHTML = isMuted
      ? '<i class="fa-solid fa-microphone-slash"></i><span>Unmute</span>'
      : '<i class="fa-solid fa-microphone"></i><span>Mute</span>';
    btn.classList.toggle('active', isMuted);
  }
}

export function toggleSpeaker() {
  // Visual toggle only — actual audio routing on mobile is OS-level
  const btn = document.getElementById('speakerBtn');
  if (btn) {
    const active = btn.classList.toggle('active');
    btn.innerHTML = active
      ? '<i class="fa-solid fa-volume-xmark"></i><span>Speaker</span>'
      : '<i class="fa-solid fa-volume-high"></i><span>Speaker</span>';
  }
}

export function toggleCamera() {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  if (btn) {
    btn.innerHTML = isCamOff
      ? '<i class="fa-solid fa-video-slash"></i><span>Camera</span>'
      : '<i class="fa-solid fa-video"></i><span>Camera</span>';
    btn.classList.toggle('active', isCamOff);
  }
}

// ─── RINGTONE ─────────────────────────────────────────────────────────────────
function playRingtone() {
  const r = document.getElementById('ringtone');
  if (r) { r.loop = true; r.play().catch(() => {}); }
}

function stopRingtone() {
  const r = document.getElementById('ringtone');
  if (r) { r.loop = false; r.pause(); r.currentTime = 0; }
}

// ─── CALL LOG MESSAGES ────────────────────────────────────────────────────────
async function saveCallMessage(status, duration) {
  if (!myID || !otherID || !callType) return;
  const chatKey = [myID, otherID].sort().join('_');
  const icon    = callType === 'video' ? '📹' : '📞';
  const label   = callType === 'video' ? 'Video' : 'Voice';
  let text = '';

  if (status === 'started')  text = `${icon} ${label} call started`;
  else if (status === 'ended')  text = `${icon} ${label} call ended${duration ? ' • ' + duration : ''}`;
  else if (status === 'declined') text = `${icon} Call declined`;

  if (!text) return;
  try {
    await push(ref(db, 'messages/' + chatKey), {
      text, msgType: 'call', callType,
      callStatus: status, senderID: myID,
      receiverID: otherID, status: 'sent',
      timestamp: Date.now()
    });
  } catch (err) { console.error('[Call] saveCallMessage:', err); }
}

async function saveMissedCallMessage() {
  if (!myID || !otherID || !callType) return;
  const chatKey = [myID, otherID].sort().join('_');
  const icon    = callType === 'video' ? '📹' : '📞';
  const text    = `${icon} Missed ${callType === 'video' ? 'video' : 'voice'} call`;
  try {
    await push(ref(db, 'messages/' + chatKey), {
      text, msgType: 'call', callType,
      callStatus: 'missed', senderID: myID,
      receiverID: otherID, status: 'sent',
      timestamp: Date.now()
    });
  } catch (err) { console.error('[Call] saveMissedCallMessage:', err); }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
