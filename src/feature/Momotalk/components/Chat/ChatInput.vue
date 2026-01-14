<template>
  <div v-if="selected" class="chat_input f">
    <div class="buttons f">
      <button class="icon_container" @click="triggerFileSelect" title="发送文件">
        <span class="iconfont icon-wenjianjia" style="font-size: 22px"></span>
      </button>
      <input ref="fileInput" type="file" style="display:none" @change="onFileChange" />

      <button class="icon_container" style="margin-left: 5px" @click="startVideoCall" title="视频通话">
        <span class="iconfont icon-qunliao-shipinliaotian" style="font-size: 25px" ></span>
      </button>

      <!-- Whiteboard button -->
      <button class="icon_container" style="margin-left: 5px" @click="openWhiteboardForSelected" title="共享白板">
        <img :src="wbIcon" alt="白板" class="wb-icon" />
      </button>
    </div>

    <textarea ref="messageEl" v-model="draft" class="editor" @keydown="onKeydown"></textarea>
    <button class="send" @click="send">发送<span class="iconfont icon-fasong1" style="margin-left: 4px;font-size: 25px" ></span></button>

    <!-- 非阻塞来电 modal -->
    <div v-if="incomingCall" class="incoming-modal">
      <div class="incoming-card">
        <p>来自uid: {{ incomingCall.fromUserId }} 的视频邀请</p>
        <div class="controls">
          <button @click="acceptIncomingCall">接听</button>
          <button @click="rejectIncomingCall">拒绝</button>
        </div>
        <small>若长时间未响应将自动拒绝</small>
      </div>
    </div>

    <!-- Whiteboard overlay -->
    <div v-if="showWhiteboard" class="wb-overlay" @click.self="closeWhiteboard">
      <div class="wb-card">
        <div class="wb-toolbar">
          <div class="wb-left">
            <button class="btn-create" @click="createOrOpenWhiteboard" :disabled="wbCreating">
              打开白板
            </button>
            <button class="btn-ghost" @click="leaveWhiteboard" style="margin-left:10px">退出</button>
          </div>

          <div class="wb-center">
            <label class="toolbar-item">工具
              <select v-model="wbTool">
                <option value="pen">画笔</option>
                <option value="eraser">橡皮</option>
              </select>
            </label>

            <label class="toolbar-item">颜色
              <input type="color" v-model="wbColor" />
            </label>
          </div>

          <div class="wb-right">
            <button class="btn-ghost" @click="clearWhiteboard">清空</button>
            <button class="btn-ghost" @click="closeWhiteboard" style="margin-left:8px">关闭</button>
          </div>
        </div>

        <canvas ref="wbCanvas" class="wb-canvas" @pointerdown="wbPointerDown" @pointermove="wbPointerMove" @pointerup="wbPointerUp"></canvas>
      </div>
    </div>
  </div>
</template>

<script setup>
import {computed, ref, onMounted, onBeforeUnmount, nextTick} from "vue";
import {realTime} from "@/stores/RealTime.js";
import {userChat} from "@/stores/userChat.js";
import {userStore} from "@/stores/UserStore.js";
import axios from "axios";
import wbIcon from '@/assets/images/whiteboard.svg';

const uc = userChat();
const me = userStore();
const rt = realTime();

const selected = computed(() => uc.getSelectedConversation().value || null);

/*input中的内容*/
const draft=ref('');

// file upload refs
const fileInput = ref(null);

// send text
async function send() {
  const text = draft.value && draft.value.trim();
  if (!text) return;
  if (!selected.value) return;
  const targetId = String(selected.value.id);
  draft.value = '';
  try {
    rt.sendPrivateText(targetId, text);
  } catch (e) {
    console.error('发送消息出错', e);
  }
}
function onKeydown(e){
  if (e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    send();
  }
}

async function triggerFileSelect() {
  if (!selected.value) return;
  fileInput.value && fileInput.value.click();
}
async function onFileChange(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = null;
  const targetId = String(selected.value.id);

  const contentType = file.type || 'application/octet-stream';
  const presignReq = { originalFilename: file.name, mimeType: contentType };

  try {
    const res = await axios.post('/api/chat/messages/presign', presignReq, { withCredentials: true });
    const data = res.data || {};
    const attachmentId = data.attachmentId;
    const putUrl = data.putUrl;
    const putHeaders = data.putHeaders || {};
    const uploadHeaders = {};
    for (const k in putHeaders) {
      if (!Object.prototype.hasOwnProperty.call(putHeaders, k)) continue;
      uploadHeaders[k] = putHeaders[k];
    }
    uploadHeaders['Content-Type'] = contentType;

    const uploadRes = await fetch(putUrl, {
      method: 'PUT',
      headers: uploadHeaders,
      body: file,
    });
    if (!uploadRes.ok) {
      console.error('上传到 putUrl 失败', uploadRes.status, await uploadRes.text().catch(()=>null));
      return;
    }

    const payload = {
      conversationType: 'PRIVATE',
      targetUserId: Number(targetId),
      groupId: null,
      messageType: 'FILE',
      content: file.name,
      attachmentId: Number(attachmentId)
    };
    rt.sendWsEnvelope('SEND_MESSAGE', payload);

  } catch (err) {
    console.error('文件上传并发送失败', err);
  }
}

/* ---------------- 视频通话（飞书/微信式：对方全屏 + 本地PIP） ---------------- */
let pc = null;
let localStream = null;
let callId = null;

// DOM refs for video UI
let videoContainer = null;
let remoteWrap = null;
let remoteVideoEl = null;
let pipWrap = null;
let localVideoEl = null;
let controlsBar = null;

// layout constants
const ASPECT = 0.75;          // 4:3
const PIP_RATIO = 0.28;       // pip宽度 = 容器宽度 * 比例
const MIN_PIP_W = 120;        // pip 最小宽度
const MIN_CONTAINER_W = 320;
const MIN_CONTAINER_H = 220;

// container state + drag/resize states
let vcState = {
  left: 0,
  top: 0,
  width: 420,
  height: 280
};
let isDragging = false;
let dragStart = null;
let isResizing = false;
let resizeStart = null;
let lastContainerSize = null;

function layoutContainerAndPip() {
  if (!videoContainer || !pipWrap || !localVideoEl || !remoteVideoEl) return;

  // pip大小 = 宽度 * 比例，但不小于最小宽度
  const pipW = Math.max(MIN_PIP_W, Math.round(vcState.width * PIP_RATIO));
  const pipH = Math.round(pipW * ASPECT);

  // 容器尺寸
  videoContainer.style.width = `${vcState.width}px`;
  videoContainer.style.height = `${vcState.height}px`;

  // 远端全屏占位（remoteVideoEl 宽高 100%，cover）
  remoteWrap.style.left = '0';
  remoteWrap.style.top = '0';
  remoteWrap.style.right = '0';
  remoteWrap.style.bottom = '0';
  remoteVideoEl.style.width = '100%';
  remoteVideoEl.style.height = '100%';
  remoteVideoEl.style.objectFit = 'cover';

  // pip 右下角
  pipWrap.style.width = `${pipW}px`;
  pipWrap.style.height = `${pipH}px`;
  pipWrap.style.right = '8px';
  pipWrap.style.bottom = '8px';
  localVideoEl.style.width = '100%';
  localVideoEl.style.height = '100%';
  localVideoEl.style.objectFit = 'cover';
}

function onDocMouseMove(ev) {
  if (!videoContainer) return;
  if (isDragging && dragStart) {
    const dx = ev.clientX - dragStart.x;
    const dy = ev.clientY - dragStart.y;
    vcState.left += dx;
    vcState.top  += dy;
    dragStart = { x: ev.clientX, y: ev.clientY };
    videoContainer.style.left = `${vcState.left}px`;
    videoContainer.style.top  = `${vcState.top}px`;
  } else if (isResizing && resizeStart) {
    const dx = ev.clientX - resizeStart.x;
    const dy = ev.clientY - resizeStart.y;
    vcState.width  = Math.max(MIN_CONTAINER_W, (lastContainerSize?.w || vcState.width) + dx);
    vcState.height = Math.max(MIN_CONTAINER_H, (lastContainerSize?.h || vcState.height) + dy);
    layoutContainerAndPip();
  }
}
function onDocMouseUp() {
  isDragging = false;
  dragStart = null;
  isResizing = false;
  resizeStart = null;
  lastContainerSize = null;
}
function attachDocEvents() {
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
}
function detachDocEvents() {
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);
}

function createVideoContainer() {
  if (videoContainer) return;

  // 初始定位到右下角（20px 边距）
  const W = window.innerWidth || document.documentElement.clientWidth || 1280;
  const H = window.innerHeight || document.documentElement.clientHeight || 720;
  vcState.left = Math.max(20, W - vcState.width - 20);
  vcState.top  = Math.max(20, H - vcState.height - 20);

  videoContainer = document.createElement('div');
  videoContainer.style.position   = 'fixed';
  videoContainer.style.left       = `${vcState.left}px`;
  videoContainer.style.top        = `${vcState.top}px`;
  videoContainer.style.zIndex     = 9999;
  videoContainer.style.background = 'rgba(255,255,255,0.95)';
  videoContainer.style.border     = '1px solid #eee';
  videoContainer.style.borderRadius = '8px';
  videoContainer.style.padding    = '0'; // 内部用绝对定位，容器不用额外 padding
  videoContainer.style.display    = 'block';
  videoContainer.style.boxShadow  = '0 4px 16px rgba(0,0,0,0.12)';
  videoContainer.style.userSelect = 'none';
  videoContainer.style.cursor     = 'default';
  videoContainer.style.overflow   = 'hidden'; // 所有内容保持在框内
  videoContainer.style.width      = `${vcState.width}px`;
  videoContainer.style.height     = `${vcState.height}px`;

  // 拖拽条（左上角）
  const dragBar = document.createElement('div');
  dragBar.textContent = '视频通话';
  dragBar.style.position   = 'absolute';
  dragBar.style.left       = '8px';
  dragBar.style.top        = '6px';
  dragBar.style.fontSize   = '12px';
  dragBar.style.color      = '#666';
  dragBar.style.cursor     = 'move';
  dragBar.style.padding    = '2px 6px';
  dragBar.style.borderRadius = '4px';
  dragBar.style.background = 'rgba(240,240,240,0.7)';
  dragBar.addEventListener('mousedown', (ev) => {
    isDragging = true;
    dragStart = { x: ev.clientX, y: ev.clientY };
    ev.preventDefault();
  });

  // 远端全屏容器
  remoteWrap = document.createElement('div');
  remoteWrap.style.position = 'absolute';
  remoteWrap.style.inset = '0'; // fill
  remoteVideoEl = document.createElement('video');
  remoteVideoEl.autoplay = true;
  remoteVideoEl.style.borderRadius = '8px';
  remoteWrap.appendChild(remoteVideoEl);

  // 本地 pip 容器
  pipWrap = document.createElement('div');
  pipWrap.style.position = 'absolute';
  pipWrap.style.borderRadius = '8px';
  pipWrap.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
  pipWrap.style.overflow = 'hidden';
  localVideoEl = document.createElement('video');
  localVideoEl.autoplay = true;
  localVideoEl.muted = true;
  pipWrap.appendChild(localVideoEl);

  // 控件条（右上角）
  controlsBar = document.createElement('div');
  controlsBar.style.position = 'absolute';
  controlsBar.style.top = '6px';
  controlsBar.style.right = '8px';
  controlsBar.style.display = 'flex';
  controlsBar.style.gap = '6px';

  const hangupBtn = document.createElement('button');
  hangupBtn.textContent = '挂断';
  hangupBtn.style.height = '28px';
  hangupBtn.style.padding = '0 10px';
  hangupBtn.style.cursor = 'pointer';
  hangupBtn.style.borderRadius = '6px';
  hangupBtn.onclick = () => { hangupVideoCall('user_hangup'); };
  controlsBar.appendChild(hangupBtn);

  // 缩放把手（右下角）
  const resizeHandle = document.createElement('div');
  resizeHandle.style.position = 'absolute';
  resizeHandle.style.right = '6px';
  resizeHandle.style.bottom = '6px';
  resizeHandle.style.width = '14px';
  resizeHandle.style.height = '14px';
  resizeHandle.style.borderRadius = '3px';
  resizeHandle.style.background = '#ddd';
  resizeHandle.style.cursor = 'nwse-resize';
  resizeHandle.title = '拖拽缩放';
  resizeHandle.addEventListener('mousedown', (ev) => {
    isResizing = true;
    resizeStart = { x: ev.clientX, y: ev.clientY };
    lastContainerSize = { w: vcState.width, h: vcState.height };
    ev.preventDefault();
  });

  // 组装
  videoContainer.appendChild(remoteWrap);
  videoContainer.appendChild(pipWrap);
  videoContainer.appendChild(controlsBar);
  videoContainer.appendChild(dragBar);
  videoContainer.appendChild(resizeHandle);

  document.body.appendChild(videoContainer);
  attachDocEvents();
  layoutContainerAndPip();
}

function cleanupVideoCall() {
  try {
    if (pc && pc._onSignalHandlers) {
      const h = pc._onSignalHandlers;
      if (h.onAnswer) rt.offSignal && rt.offSignal('CALL_ANSWER', h.onAnswer);
      if (h.onIce) rt.offSignal && rt.offSignal('CALL_ICE', h.onIce);
      if (h.onHangup) rt.offSignal && rt.offSignal('CALL_HANGUP', h.onHangup);
      if (h.onReject) rt.offSignal && rt.offSignal('CALL_REJECT', h.onReject);
      if (h.calleeIce) rt.offSignal && rt.offSignal('CALL_ICE', h.calleeIce);
      if (h.calleeHangup) rt.offSignal && rt.offSignal('CALL_HANGUP', h.calleeHangup);
      pc._onSignalHandlers = null;
    }

    if (pc) { pc.close(); pc = null; }
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (videoContainer) {
      videoContainer.remove();
      videoContainer = null;
      remoteWrap = null;
      pipWrap = null;
      localVideoEl = null;
      remoteVideoEl = null;
      controlsBar = null;
    }
    detachDocEvents();
    isDragging = false;
    isResizing = false;
    dragStart = null;
    resizeStart = null;
    lastContainerSize = null;

    pendingIce.delete(callId);
    pendingAnswers.delete(callId);
    callId = null;
    incomingCall.value = null;
    clearIncomingTimeout();
  } catch (e) {
    console.error('cleanupVideoCall error', e);
  }
}

function hangupVideoCall(reason = 'user_hangup') {
  if (!callId || !selected.value) {
    cleanupVideoCall();
    return;
  }
  const payload = { callId, reason };
  rt.sendWsEnvelope('CALL_HANGUP', payload);
  cleanupVideoCall();
}

// 主动呼叫（caller）
async function startVideoCall() {
  if (!selected.value) return;
  if (pc) {
    console.warn('already in call');
    return;
  }

  // Generate Call ID
  const targetUserId = Number(selected.value.id);
  callId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2);

  try {
     // 1. Get User Media
    if (typeof navigator === 'undefined') {
      throw new Error('Navigator is undefined in this environment.');
    }
    const md = navigator.mediaDevices ?? null;
    if (md && typeof md.getUserMedia === 'function') {
      localStream = await md.getUserMedia({ video: true, audio: true });
    } else {
      const legacyGetUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
      if (typeof legacyGetUserMedia === 'function') {
        localStream = await new Promise((resolve, reject) =>
            legacyGetUserMedia.call(navigator, { video: true, audio: true }, resolve, reject)
        );
      } else {
        throw new Error('getUserMedia is not available.');
      }
    }

    // 2. Show UI
    createVideoContainer();
    if (localVideoEl) localVideoEl.srcObject = localStream;

    // 3. Define Handlers FIRST (Fix TDZ issue)
    const onAnswer = async (payload) => {
      if (payload.callId !== callId) return;
      try {
        if (!pc) {
          pendingAnswers.set(payload.callId, payload);
          return;
        }
        // If we are stable, or have local offer, we can accept answer
        if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'have-local-pranswer') {
           await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
           // flush any pending ICE
           const iceQueue = pendingIce.get(callId) || [];
           for (const ice of iceQueue) {
               await pc.addIceCandidate(new RTCIceCandidate({
                   candidate: ice.candidate,
                   sdpMid: ice.sdpMid,
                   sdpMLineIndex: ice.sdpMLineIndex
               })).catch(e => console.error('flush ice error', e));
           }
           pendingIce.delete(callId);
        } else {
          // If state is not right, maybe buffer or ignore? 
          // Usually 'stable' means we are already done.
          console.warn('Received Answer but state is', pc.signalingState);
        }
      } catch (e) {
        console.error('setRemoteDescription failed', e);
      }
    };

    const onIce = async (payload) => {
      if (payload.callId !== callId) return;
      try {
        if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate({
              candidate: payload.candidate,
              sdpMid: payload.sdpMid,
              sdpMLineIndex: payload.sdpMLineIndex
            }));
        } else {
            handleSignalIce(payload);
        }
      } catch (e) { console.error('addIceCandidate failed', e); }
    };

    const onReject = (payload) => {
      if (payload.callId !== callId) return;
      ElMessage.info('对方已拒绝');
      cleanupVideoCall();
    };

    const onHangup = (payload) => {
      if (payload.callId !== callId) return;
      ElMessage.info('通话已结束');
      cleanupVideoCall();
    };

    // 4. Create PeerConnection
    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        rt.sendWsEnvelope('CALL_ICE', {
          callId,
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex
        });
      }
    };
    pc.ontrack = (ev) => {
      if (remoteVideoEl) {
        remoteVideoEl.srcObject = ev.streams[0];
      }
    };

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    // 5. Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 6. Check Pending Answer (rare but possible)
    const pending = pendingAnswers.get(callId);
    if (pending) {
      await onAnswer(pending);
      pendingAnswers.delete(callId);
    }

    // 7. Send Invite
    rt.sendWsEnvelope('CALL_INVITE', {
      targetUserId,
      callId,
      sdp: offer,
      metadata: 'video,audio'
    });

    // 8. Register Signal Listeners
    rt.onSignal && rt.onSignal('CALL_ANSWER', onAnswer);
    rt.onSignal && rt.onSignal('CALL_ICE', onIce);
    rt.onSignal && rt.onSignal('CALL_REJECT', onReject);
    rt.onSignal && rt.onSignal('CALL_HANGUP', onHangup);

    pc._onSignalHandlers = { onAnswer, onIce, onReject, onHangup };

  } catch (e) {
    console.error('startVideoCall failed', e);
    ElMessage.error('无法启动视频通话: ' + e.message);
    cleanupVideoCall();
  }
}

// pending buffers for video
const pendingIce = new Map();
const pendingAnswers = new Map();

function handleSignalIce(payload) {
  if (!payload || !payload.callId) return;
  if (pc && callId === payload.callId) {
    try {
      pc.addIceCandidate(new RTCIceCandidate({
        candidate: payload.candidate,
        sdpMid: payload.sdpMid,
        sdpMLineIndex: payload.sdpMLineIndex
      })).catch(e => console.error('addIceCandidate error', e));
    } catch (e) {
      console.error('addIceCandidate sync error', e);
    }
    return;
  }
  const arr = pendingIce.get(payload.callId) || [];
  arr.push(payload);
  pendingIce.set(payload.callId, arr);
}

/* 非阻塞来电处理 */
const incomingCall = ref(null);
let incomingTimeoutId = null;
function clearIncomingTimeout() {
  if (incomingTimeoutId) { clearTimeout(incomingTimeoutId); incomingTimeoutId = null; }
}

function handleIncomingInvite(payload) {
  if (!payload || !payload.callId) return;
  if (incomingCall.value || pc) {
    rt.sendWsEnvelope('CALL_REJECT', { callId: payload.callId, reason: 'busy' });
    return;
  }
  incomingCall.value = { payload, fromUserId: payload.fromUserId, callId: payload.callId };
  incomingTimeoutId = setTimeout(() => {
    if (incomingCall.value && incomingCall.value.callId === payload.callId) {
      rt.sendWsEnvelope('CALL_REJECT', { callId: payload.callId, reason: 'timeout' });
      incomingCall.value = null;
      incomingTimeoutId = null;
    }
  }, 30000);
}

async function acceptIncomingCall() {
  const info = incomingCall.value;
  if (!info || !info.payload) return;
  clearIncomingTimeout();

  if (pc) {
    incomingCall.value = null;
    return;
  }

  callId = info.payload.callId;

  try {
    const md = navigator.mediaDevices ?? null;
    if (md && typeof md.getUserMedia === 'function') {
      localStream = await md.getUserMedia({ video: true, audio: true });
    } else {
      const legacyGetUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
      if (typeof legacyGetUserMedia === 'function') {
        localStream = await new Promise((resolve, reject) =>
            legacyGetUserMedia.call(navigator, { video: true, audio: true }, resolve, reject)
        );
      } else {
        alert('无法获取摄像头/麦克风');
        rt.sendWsEnvelope('CALL_REJECT', { callId, reason: 'no_media' });
        incomingCall.value = null;
        return;
      }
    }

    createVideoContainer();
    if (localVideoEl) localVideoEl.srcObject = localStream;

    pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        rt.sendWsEnvelope('CALL_ICE', {
          callId,
          candidate: ev.candidate.candidate,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex
        });
      }
    };

    pc.ontrack = (ev) => {
      if (remoteVideoEl) remoteVideoEl.srcObject = ev.streams[0];
    };

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(info.payload.sdp));

    const cached = pendingIce.get(callId) || [];
    for (const item of cached) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate({
          candidate: item.candidate,
          sdpMid: item.sdpMid,
          sdpMLineIndex: item.sdpMLineIndex
        }));
      } catch (e) { /* ignore */ }
    }
    pendingIce.delete(callId);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    rt.sendWsEnvelope('CALL_ANSWER', {
      callId,
      sdp: answer
    });

    const onIceForThis = async (p) => {
      try {
        if (!p || p.callId !== callId) return;
        if (!pc) {
          const arr = pendingIce.get(p.callId) || [];
          arr.push(p);
          pendingIce.set(p.callId, arr);
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate({
          candidate: p.candidate,
          sdpMid: p.sdpMid,
          sdpMLineIndex: p.sdpMLineIndex
        }));
      } catch (err) {
        console.error('callee addIceCandidate error', err, p);
      }
    };
    const onHangupForThis = (p) => {
      if (p.callId !== callId) return;
      cleanupVideoCall();
    };

    rt.onSignal && rt.onSignal('CALL_ICE', onIceForThis);
    rt.onSignal && rt.onSignal('CALL_HANGUP', onHangupForThis);

    pc._onSignalHandlers = pc._onSignalHandlers || {};
    pc._onSignalHandlers.calleeIce = onIceForThis;
    pc._onSignalHandlers.calleeHangup = onHangupForThis;

    incomingCall.value = null;
  } catch (e) {
    console.error('error handling incoming call (accept)', e);
    rt.sendWsEnvelope('CALL_REJECT', { callId: info.payload.callId, reason: 'accept_failed' });
    incomingCall.value = null;
    cleanupVideoCall();
  }
}

function rejectIncomingCall(reason = 'user_reject') {
  const info = incomingCall.value;
  if (!info || !info.payload) return;
  clearIncomingTimeout();
  rt.sendWsEnvelope('CALL_REJECT', { callId: info.payload.callId, reason });
  rt.sendWsEnvelope('CALL_HANGUP', { callId: info.payload.callId, reason });
  incomingCall.value = null;
}

/* ---------------- 白板逻辑（集成版，保持不变） ---------------- */
const showWhiteboard = ref(false);
const wbCreating = ref(false);

// canvas refs/state
const wbCanvas = ref(null);
let wbCtx = null;

// whiteboard drawing state
let wbDrawing = false;
let wbCurrentStrokeId = null;
let wbSendBuffer = [];
let wbCarryPoint = null;
let wbSendTimer = null;
let wbLocalLastPoint = null; // local continuity
const WB_BATCH_MAX_POINTS = 12;
const WB_BATCH_INTERVAL_MS = 60;

const wbTool = ref('pen');
const wbColor = ref('#ff3366');
const wbWidth = ref(3);

// maintain last received point per stroke on receiver side
const wbLastPointMap = {}; // strokeId -> [x,y]

// ensure canvas context scaled correctly
function wbResize() {
  const c = wbCanvas.value;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (c.width !== w || c.height !== h) {
    const tmp = document.createElement('canvas');
    tmp.width = c.width || 1;
    tmp.height = c.height || 1;
    tmp.getContext('2d').drawImage(c, 0, 0);
    c.width = w; c.height = h;
    wbCtx = c.getContext('2d');
    wbCtx.setTransform(1,0,0,1,0,0);
    wbCtx.scale(dpr, dpr);
    wbCtx.clearRect(0,0,c.width, c.height);
    wbCtx.drawImage(tmp, 0, 0, tmp.width / dpr, tmp.height / dpr);
  } else {
    wbCtx = c.getContext('2d');
    wbCtx.setTransform(1,0,0,1,0,0);
    wbCtx.scale(dpr, dpr);
  }
}

// convert pointer client coords to normalized [0..1]
function wbNormalizePoint(clientX, clientY) {
  const rect = wbCanvas.value.getBoundingClientRect();
  return [Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))];
}
function wbDenormalizePoint(xNorm, yNorm) {
  const rect = wbCanvas.value.getBoundingClientRect();
  return [xNorm * rect.width, yNorm * rect.height];
}

function wbDrawPoints(points, color, width, composite = 'source-over') {
  if (!points || points.length === 0) return;
  wbCtx.save();
  wbCtx.lineCap = 'round';
  wbCtx.lineJoin = 'round';
  wbCtx.strokeStyle = color || '#000';
  wbCtx.lineWidth = width || 2;
  wbCtx.globalCompositeOperation = composite;
  if (points.length === 1) {
    const [x,y] = wbDenormalizePoint(points[0][0], points[0][1]);
    wbCtx.beginPath();
    wbCtx.arc(x, y, Math.max(1, (width || 2) / 2), 0, Math.PI * 2);
    wbCtx.fillStyle = color || '#000';
    wbCtx.fill();
  } else {
    wbCtx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [xn, yn] = points[i];
      const [x, y] = wbDenormalizePoint(xn, yn);
      if (i === 0) wbCtx.moveTo(x, y);
      else wbCtx.lineTo(x, y);
    }
    wbCtx.stroke();
  }
  wbCtx.restore();
}

// apply incoming whiteboard event (replay and live)
function wbApplyEvent(ev) {
  if (!ev || !ev.type) return;

  const tool = ev.tool || ev.toolType || 'pen';
  const color = ev.color || '#000';
  const width = Number(ev.width || 2);
  const isEnd = String(ev.isEnd || 'false') === 'true';

  let pts = ev.points;
  if (typeof pts === 'string') {
    try { pts = JSON.parse(pts); } catch { pts = []; }
  }
  if (!Array.isArray(pts)) pts = [];

  if (ev.type === 'WHITEBOARD_STROKE_PART') {
    const sid = ev.strokeId;
    if (pts.length === 0) {
      if (isEnd && sid) delete wbLastPointMap[sid];
      return;
    }
    const last = wbLastPointMap[sid];
    if (last && (last[0] !== pts[0][0] || last[1] !== pts[0][1])) {
      pts.unshift(last);
    }
    const composite = (tool === 'eraser') ? 'destination-out' : 'source-over';
    wbDrawPoints(pts, color || '#000', width || 2, composite);
    wbLastPointMap[sid] = pts[pts.length - 1];
    if (isEnd && sid) delete wbLastPointMap[sid];
  } else if (ev.type === 'WHITEBOARD_CLEAR') {
    const c = wbCanvas.value;
    if (c) wbCtx.clearRect(0, 0, c.width, c.height);
    for (const k in wbLastPointMap) delete wbLastPointMap[k];
  }
}

// sending batching with carry-over
function wbFlushBuffer(isEnd = false) {
  if (!selected.value) return;
  if (wbSendBuffer.length === 0 && !isEnd) return;

  let pointsToSend = wbSendBuffer.slice();
  if (wbCarryPoint && pointsToSend.length > 0) {
    const first = pointsToSend[0];
    if (first[0] !== wbCarryPoint[0] || first[1] !== wbCarryPoint[1]) {
      pointsToSend.unshift(wbCarryPoint);
    }
  }

  const payload = {
    targetUserId: Number(selected.value.id),
    strokeId: wbCurrentStrokeId,
    tool: wbTool.value,
    color: wbColor.value,
    width: wbWidth.value || 2,
    points: pointsToSend,
    isEnd: !!isEnd,
    ts: Date.now()
  };
  rt.sendWsEnvelope('WHITEBOARD_STROKE_PART', payload);

  if (pointsToSend.length > 0) {
    wbCarryPoint = pointsToSend[pointsToSend.length - 1];
    wbSendBuffer = wbCarryPoint ? [wbCarryPoint] : [];
  } else {
    wbSendBuffer = [];
    wbCarryPoint = null;
  }
  if (isEnd) {
    wbCarryPoint = null;
    wbSendBuffer = [];
    wbLocalLastPoint = null;
  }
}

function wbStartTimer() {
  if (wbSendTimer) return;
  wbSendTimer = setInterval(() => { wbFlushBuffer(false); }, WB_BATCH_INTERVAL_MS);
}
function wbStopTimer() {
  if (wbSendTimer) { clearInterval(wbSendTimer); wbSendTimer = null; }
}

// pointer handlers bound to canvas element
function wbPointerDown(e) {
  e.preventDefault();
  wbResize();
  wbDrawing = true;
  wbCurrentStrokeId = crypto.randomUUID ? crypto.randomUUID() : ('s-' + Date.now() + '-' + Math.floor(Math.random()*10000));
  wbSendBuffer = [];
  wbCarryPoint = null;
  wbLocalLastPoint = null;
  wbStartTimer();
  const [nx, ny] = wbNormalizePoint(e.clientX, e.clientY);
  wbSendBuffer.push([nx, ny]);
  wbLocalLastPoint = [nx, ny];
  wbDrawPoints([[nx, ny]], wbColor.value, wbWidth.value, wbTool.value === 'eraser' ? 'destination-out' : 'source-over');
}
function wbPointerMove(e) {
  if (!wbDrawing) return;
  const [nx, ny] = wbNormalizePoint(e.clientX, e.clientY);
  if (wbLocalLastPoint) {
    wbDrawPoints([wbLocalLastPoint, [nx, ny]], wbColor.value, wbWidth.value, wbTool.value === 'eraser' ? 'destination-out' : 'source-over');
  } else {
    wbDrawPoints([[nx, ny]], wbColor.value, wbWidth.value, wbTool.value === 'eraser' ? 'destination-out' : 'source-over');
  }
  wbLocalLastPoint = [nx, ny];

  wbSendBuffer.push([nx, ny]);
  if (wbSendBuffer.length >= WB_BATCH_MAX_POINTS) wbFlushBuffer(false);
}
function wbPointerUp(e) {
  if (!wbDrawing) return;
  wbDrawing = false;
  const [nx, ny] = wbNormalizePoint(e.clientX, e.clientY);
  if (wbLocalLastPoint) {
    wbDrawPoints([wbLocalLastPoint, [nx, ny]], wbColor.value, wbWidth.value, wbTool.value === 'eraser' ? 'destination-out' : 'source-over');
  } else {
    wbDrawPoints([[nx, ny]], wbColor.value, wbWidth.value, wbTool.value === 'eraser' ? 'destination-out' : 'source-over');
  }
  wbLocalLastPoint = null;

  wbSendBuffer.push([nx, ny]);
  wbFlushBuffer(true);
  wbStopTimer();
  wbCurrentStrokeId = null;
}

// open/join/leave/clear
function openWhiteboardForSelected() {
  if (!selected.value) { alert('请先选择好友对话'); return; }
  showWhiteboard.value = true;
  rt.sendWsEnvelope('WHITEBOARD_OPEN', { targetUserId: Number(selected.value.id) });
  rt.sendWsEnvelope('WHITEBOARD_JOIN', { targetUserId: Number(selected.value.id) });
}

function createOrOpenWhiteboard() {
  if (!selected.value) return;
  wbCreating.value = true;
  rt.sendWsEnvelope('WHITEBOARD_OPEN', { targetUserId: Number(selected.value.id) });
  rt.sendWsEnvelope('WHITEBOARD_JOIN', { targetUserId: Number(selected.value.id) });
  setTimeout(() => { wbCreating.value = false; }, 800);
}

function leaveWhiteboard() {
  if (selected.value) {
    rt.sendWsEnvelope('WHITEBOARD_LEAVE', { targetUserId: Number(selected.value.id) });
  }
  closeWhiteboard();
}

function onWbOpened(payload) {
  // noop
}

function onWbInit(payload) {
  nextTick(() => {
    wbResize();
    if (wbCanvas.value) wbCtx.clearRect(0,0,wbCanvas.value.width,wbCanvas.value.height);
    for (const k in wbLastPointMap) delete wbLastPointMap[k];
    const evs = payload?.events || [];
    evs.forEach(e => wbApplyEvent(e));
    if (wbSendBuffer.length > 0) wbFlushBuffer(false);
  });
}
function onWbEvent(payload) {
  wbApplyEvent(payload);
}
function onWbClear(payload) {
  if (wbCanvas.value) wbCtx.clearRect(0,0,wbCanvas.value.width,wbCanvas.value.height);
  for (const k in wbLastPointMap) delete wbLastPointMap[k];
}

function onWbError(payload) {
  try {
    const reason = payload && (payload.reason || payload.message || JSON.stringify(payload));
    alert('白板错误：' + (reason || 'unknown'));
    showWhiteboard.value = false;
  } catch (e) {
    console.error('onWbError handling failed', e);
  }
}
function clearWhiteboard() {
  if (!selected.value) { alert('无选中会话'); return; }
  rt.sendWsEnvelope('WHITEBOARD_CLEAR', { targetUserId: Number(selected.value.id), ts: Date.now() });
  if (wbCanvas.value) wbCtx.clearRect(0,0,wbCanvas.value.width,wbCanvas.value.height);
  for (const k in wbLastPointMap) delete wbLastPointMap[k];
}

function closeWhiteboard() {
  showWhiteboard.value = false;
  wbSendBuffer = [];
  wbCarryPoint = null;
  wbStopTimer();
  for (const k in wbLastPointMap) delete wbLastPointMap[k];
  if (wbCanvas.value) wbCtx.clearRect(0, 0, wbCanvas.value.width, wbCanvas.value.height);
}

/* 通过聊天消息点击触发 */
function onGlobalOpenWhiteboard() {
  if (!selected.value) { alert('请先选择好友对话'); return; }
  showWhiteboard.value = true;
  rt.sendWsEnvelope('WHITEBOARD_OPEN', { targetUserId: Number(selected.value.id) });
  rt.sendWsEnvelope('WHITEBOARD_JOIN', { targetUserId: Number(selected.value.id) });
}

onMounted(() => {
  rt.onSignal && rt.onSignal('WHITEBOARD_OPENED', onWbOpened);
  rt.onSignal && rt.onSignal('WHITEBOARD_INIT', onWbInit);
  rt.onSignal && rt.onSignal('WHITEBOARD_EVENT', onWbEvent);
  rt.onSignal && rt.onSignal('WHITEBOARD_CLEAR', onWbClear);
  rt.onSignal && rt.onSignal('WHITEBOARD_ERROR', onWbError);

  rt.onSignal && rt.onSignal('CALL_INVITE', handleIncomingInvite);
  rt.onSignal && rt.onSignal('CALL_ICE', handleSignalIce);
  rt.onSignal && rt.onSignal('CALL_HANGUP', (p) => {
    if (p && p.callId && p.callId === callId) cleanupVideoCall();
  });
  window.addEventListener('openWhiteboard', onGlobalOpenWhiteboard);
});

onBeforeUnmount(() => {
  rt.offSignal && rt.offSignal('WHITEBOARD_OPENED', onWbOpened);
  rt.offSignal && rt.offSignal('WHITEBOARD_INIT', onWbInit);
  rt.offSignal && rt.offSignal('WHITEBOARD_EVENT', onWbEvent);
  rt.offSignal && rt.offSignal('WHITEBOARD_CLEAR', onWbClear);
  rt.offSignal && rt.offSignal('WHITEBOARD_ERROR', onWbError);

  rt.offSignal && rt.offSignal('CALL_INVITE', handleIncomingInvite);
  rt.offSignal && rt.offSignal('CALL_ICE', handleSignalIce);

  clearIncomingTimeout();
  cleanupVideoCall();

  window.removeEventListener('openWhiteboard', onGlobalOpenWhiteboard);
});
</script>

<style scoped>
.chat_input{
  display: flex;
  flex-direction: column;
  padding: 10px 15px;
  flex: 0 0 170px;
  width: 100%;
  height: 184px;
  border-top: 1px solid rgba(255, 179, 217, 0.3);
  overflow-y: auto;
}
.buttons{
  display: flex;
  gap:8px;
}
.icon_container{
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
}
.icon_container:hover{
  background-color: rgba(255,240,245,1);
}
.wb-icon{
  width:24px;
  height:24px;
  display:block;
}
.editor{
  flex: 1;
  width: 100%;
  resize: none;
  overflow-y: auto;
  padding: 8px 5px;
  border: none;
  outline: none;
}
.editor:focus{
  outline: none;
}
.send{
  width: 80px;
  height: 32px;
  background-color: rgb(241 157 170);
  color: white;
  border-radius: 20px;
  transition: all 0.5s ease;
  font-size: 16px;
  align-self: flex-end;
  margin-top: 8px;
}
.send:hover{
  cursor: pointer;
  transform: scale(1.02);
  background-color: rgba(241,157,170,0.7);
}

/* incoming modal */
.incoming-modal {
  position: fixed;
  left: 50%;
  top: 30%;
  transform: translateX(-50%);
  z-index: 10000;
}
.incoming-card {
  background: white;
  border: 1px solid #ddd;
  padding: 30px;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.12);
  text-align: center;
}
.incoming-card .controls {
  display:flex;
  gap:10px;
  justify-content:center;
  margin-top:8px;
}
.incoming-card button {
  padding:6px 10px;
  border-radius:6px;
  border:none;
  cursor:pointer;
}
.incoming-card button:first-child { background:pink; color:white; }
.incoming-card button:last-child { background: #c1c1c1; color:white; }

/* whiteboard overlay */
.wb-overlay{
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display:flex;
  align-items: center;
  justify-content: center;
  z-index: 20000;
}
.wb-card{
  width: 90%;
  max-width: 1200px;
  height: 82%;
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  display:flex;
  flex-direction: column;
  gap:8px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.18);
}
.wb-toolbar{
  display:flex;
  align-items:center;
  gap:12px;
  padding-bottom:8px;
  border-bottom: 1px solid #eee;
}
.wb-left { display:flex; align-items:center; gap:8px; }
.wb-center { display:flex; align-items:center; gap:12px; margin-left: 16px; }
.wb-right { display:flex; align-items:center; gap:8px; margin-left:auto; }

.wb-canvas{
  flex: 1;
  border: 1px solid #eee;
  width: 100%;
  height: calc(100% - 120px);
  touch-action: none;
  background: #fff;
}
.toolbar-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #333;
}
.btn-create {
  background: #ff6f91;
  color: #fff;
  border: none;
  padding: 8px 12px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(255,111,145,0.12);
}
.btn-create:disabled { opacity: .6; cursor: not-allowed; }
.btn-ghost {
  background: #fff;
  border: 1px solid #e6e6e6;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
</style>