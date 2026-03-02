import { db } from './firebase-config.js';
import {
  ref, set, get, onValue, remove, push, update, off
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};

let peerConnection = null;
let localStream = null;
let callType = null;
let callRole = null;
let myID = null;
let otherID = null;
let callTimerInterval = null;
let callSeconds = 0;
let onCallEndedCallback = null;
let isMuted = false;
let isCamOff = false;

let activeListeners = [];

export function initCall(uid, oid, name, onEnd) {
  myID = uid;
  otherID = oid;
  onCallEndedCallback = onEnd;
  cleanupCallState();
}

export async function startCall(type) {
  callType = type;
  callRole = 'caller';
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: type === 'video',
      audio: true
    });
    
    displayLocalStream(localStream);
    createPeerConnection();

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    await set(ref(db, `calls/${otherID}`), {
      callerID: myID,
      callerName: localStorage.getItem('aschat_name') || 'User',
      type: type,
      offer: { type: offer.type, sdp: offer.sdp },
      timestamp: Date.now()
    });

    const answerRef = ref(db, `calls/${otherID}/answer`);
    const answerSub = onValue(answerRef, async (snap) => {
      if (snap.exists() && !peerConnection.currentRemoteDescription) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(snap.val()));
        startCallTimer();
      }
    });
    activeListeners.push({ ref: answerRef, cb: answerSub });

    listenForRemoteIce(otherID);
    saveCallMessage('started');
  } catch (err) {
    console.error("Call Start Error:", err);
    endCall();
  }
}

export async function acceptCall(incomingData) {
  callType = incomingData.type;
  callRole = 'receiver';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: callType === 'video',
      audio: true
    });
    
    displayLocalStream(localStream);
    createPeerConnection();

    await peerConnection.setRemoteDescription(new RTCSessionDescription(incomingData.offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    await update(ref(db, `calls/${myID}`), {
      answer: { type: answer.type, sdp: answer.sdp }
    });

    listenForRemoteIce(myID);
    startCallTimer();
  } catch (err) {
    console.error("Call Accept Error:", err);
    endCall();
  }
}

function listenForRemoteIce(listenID) {
  const iceRef = ref(db, `calls/${listenID}/iceCandidates`);
  const iceSub = onValue(iceRef, (snap) => {
    if (snap.exists()) {
      snap.forEach((child) => {
        if (child.key !== myID) { // Don't add our own candidates
          child.forEach((cand) => {
            peerConnection.addIceCandidate(new RTCIceCandidate(cand.val())).catch(() => {});
          });
        }
      });
    }
  });
  activeListeners.push({ ref: iceRef, cb: iceSub });
}

function createPeerConnection() {
  if (peerConnection) peerConnection.close();
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    const remoteVideo = document.getElementById('remoteVideo');
    if (remoteVideo && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      const targetID = callRole === 'caller' ? otherID : myID;
      push(ref(db, `calls/${targetID}/iceCandidates/${myID}`), event.candidate.toJSON());
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(peerConnection.connectionState)) {
      endCall();
    }
  };
}

export function endCall() {
  saveCallMessage(callSeconds > 0 ? 'ended' : 'declined', formatDuration(callSeconds));
  cleanupCallState();
  if (onCallEndedCallback) onCallEndedCallback();
}

function cleanupCallState() {
  activeListeners.forEach(l => off(l.ref, 'value', l.cb));
  activeListeners = [];

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  clearInterval(callTimerInterval);
  if (myID) remove(ref(db, `calls/${myID}`));
  
  const rv = document.getElementById('remoteVideo');
  const lv = document.getElementById('localVideo');
  if (rv) rv.srcObject = null;
  if (lv) lv.srcObject = null;
}

function startCallTimer() {
  if (callTimerInterval) return;
  const display = document.getElementById('callDuration');
  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    if (display) display.textContent = formatDuration(callSeconds);
  }, 1000);
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' + s : s}`;
}

function displayLocalStream(stream) {
  const lv = document.getElementById('localVideo');
  if (lv) {
    lv.srcObject = stream;
    lv.muted = true;
  }
}

export function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  const btn = document.getElementById('muteBtn');
  if (btn) btn.innerHTML = isMuted ? '<i class="fa-solid fa-microphone-slash"></i>' : '<i class="fa-solid fa-microphone"></i>';
}

export function toggleCamera() {
  if (!localStream || callType !== 'video') return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  const btn = document.getElementById('camBtn');
  if (btn) btn.innerHTML = isCamOff ? '<i class="fa-solid fa-video-slash"></i>' : '<i class="fa-solid fa-video"></i>';
}

async function saveCallMessage(status, duration = null) {
  if (!myID || !otherID) return;
  const chatKey = [myID, otherID].sort().join('_');
  const icon = callType === 'video' ? '📹' : '📞';
  let text = `${icon} ${callType} call ${status}${duration ? ' (' + duration + ')' : ''}`;
  try {
    await push(ref(db, 'messages/' + chatKey), {
      text, msgType: 'call', senderID: myID, timestamp: Date.now(), status: 'sent'
    });
  } catch (e) {}
}


