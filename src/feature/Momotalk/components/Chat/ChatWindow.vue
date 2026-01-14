<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import axios from 'axios';
import { userChat } from '@/stores/userChat.js';
import { userStore } from '@/stores/UserStore.js';
import { realTime } from '@/stores/RealTime.js';
import { ElMessageBox, ElMessage } from 'element-plus';
import ChatHeader from './ChatHeader.vue';
import ChatInput from "@/feature/Momotalk/components/Chat/ChatInput.vue";

const uc = userChat();
const me = userStore();
const rt = realTime();

// Persisted Local Deletes
const localDeleteKey = computed(() => `momotalk_deleted_${me.getUserId()}`);
const localDeletedIds = ref(new Set());

// Load on mount or user change
watch(() => me.getUserId(), (uid) => {
    if(uid) {
        try {
            const raw = localStorage.getItem(`momotalk_deleted_${uid}`);
            localDeletedIds.value = new Set(raw ? JSON.parse(raw) : []);
        } catch { 
            localDeletedIds.value = new Set(); 
        }
    }
}, { immediate: true });

function persistLocalDelete(msgId) {
    if(!msgId) return;
    localDeletedIds.value.add(String(msgId));
    localStorage.setItem(localDeleteKey.value, JSON.stringify([...localDeletedIds.value]));
}

const selectedRef = uc.getSelectedConversation();
const selected = computed(() => selectedRef.value);

const messages = computed(() => uc.getMessagesForSelected());

// ===== Grouping Logic =====
function formatSmartTime(ts) {
  if(!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  
  if (isToday) {
      return `${hh}:${mm}`;
  }
  
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if(isYesterday) {
      return `昨天 ${hh}:${mm}`;
  }
  
  const isSameYear = date.getFullYear() === now.getFullYear();
  const M = date.getMonth() + 1;
  const d = date.getDate();
  
  if(isSameYear) {
      return `${M}月${d}日 ${hh}:${mm}`;
  }
  
  return `${date.getFullYear()}年${M}月${d}日 ${hh}:${mm}`;
}

const groupedMessages = computed(() => {
  const raw = messages.value;
  if (!raw || raw.length === 0) return [];

  const groups = [];
  let current = null;
  let lastTimestampTime = 0; // Track last time we showed a timestamp

  for (const m of raw) {
    // Filter locally deleted
    if (localDeletedIds.value.has(String(m.id))) continue;

    const mTime = getMsgTimestamp(m) || 0;
    const isMe = String(m.fromUserId) === String(me.getUserId());
    
    // Check if we can merge into current group
    if (current && 
        current.isMine === isMe && 
        String(current.userId) === String(m.fromUserId) &&
        (mTime - current.lastTime <= 5 * 60 * 1000)) {
       
       current.messages.push(m);
       current.lastTime = mTime; // Extend window
    } else {
       // New Group
       let showTime = false;
       // 5 minute threshold for showing timestamp
       if (lastTimestampTime === 0 || (mTime - lastTimestampTime > 5 * 60 * 1000)) {
          showTime = true;
          lastTimestampTime = mTime;
       }

       current = {
         id: 'g_' + (m.id || Date.now() + Math.random()),
         userId: m.fromUserId,
         isMine: isMe,
         messages: [m],
         startTime: mTime,
         lastTime: mTime,
         showTime,
         displayTime: formatSmartTime(mTime)
       };
       groups.push(current);
    }
  }
  return groups;
});

const bodyRef = ref(null);

function isMine(m) {
  return String(m.fromUserId) === String(me.getUserId());
}

// Normalize/format content, keep newlines etc.
function formatContent(text) {
  if (!text && text !== 0) return '';
  let s = String(text);
  s = s.replace(/\r\n/g, '\n');
  s = s.replace(/\\r\\n/g, '\n');
  s = s.replace(/\\n/g, '\n');
  s = s.replace(/\/n/g, '\n');
  return s;
}

/* ===== Image helpers ===== */
const MAX_THUMB_WIDTH = 200;
const MAX_THUMB_HEIGHT = 200;
const DEFAULT_THUMB_WIDTH = 100;
const DEFAULT_THUMB_HEIGHT = 100;
const MIN_THUMB_SIDE = 40;

function isImageUrl(url, messageType) {
  if (!url) return false;
  if (messageType === 'IMAGE') return true;
  const path = String(url).split('?')[0].toLowerCase();
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

function getFileExt(nameOrUrl) {
  const s = String(nameOrUrl || '').split('?')[0];
  const m = s.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : '';
}

function onImageLoad(ev, m) {
  // Simple check for now, CSS handles most sizing
}

/* ===== Recall/Delete helpers ===== */
const RECALL_WINDOW_MS = 3 * 60 * 1000;

function getMsgTimestamp(m) {
  if (m.timestamp) return Number(m.timestamp);
  if (m.createdAt) {
      if(Array.isArray(m.createdAt)){
          const [y, M, d, h, min, s] = m.createdAt;
          return new Date(y, M-1, d, h, min, s || 0).getTime();
      }
    try { return new Date(m.createdAt).getTime(); } catch { /* ignore */ }
  }
  return null;
}
function canRecall(m) {
  if (!isMine(m)) return false;
  const t = getMsgTimestamp(m);
  if (!t || Number.isNaN(t)) return false;
  return (Date.now() - t) <= RECALL_WINDOW_MS;
}
function removeMessageLocally(messageId) {
  const arr = uc.getMessagesForSelected();
  const idx = arr.findIndex(x => String(x.id) === String(messageId));
  if (idx >= 0) arr.splice(idx, 1);
}
async function onDeleteMessage(m) {
  try {
    await ElMessageBox.confirm('确定要删除这条消息吗？此操作仅在本地生效。', '删除提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
    
    // Use Persistent Local Delete instead of API
    // await axios.post('/api/chat/messages/delete', { messageId: m.id });
    persistLocalDelete(m.id);
    removeMessageLocally(m.id);
    
    ElMessage.success('删除成功');
  } catch (e) {
    if (e === 'cancel') return;
    const msg = e?.response?.data?.message || e?.response?.data || e?.message || '删除失败';
    // If it was an API error, we show it. If it's just logic, we're fine.
    // Here we don't call API so errors are unlikely.
     ElMessage.error(msg);
  }
}
async function onRecallMessage(m) {
  try {
    await ElMessageBox.confirm('确定要撤回这条消息吗？', '撤回提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });

    const res = await axios.post('/api/chat/messages/recall', { messageId: m.id });
     if (res?.data?.data?.allowed) {
         removeMessageLocally(m.id);
         ElMessage.success('撤回成功');
     }
     else {
         ElMessage.error('撤回失败: ' + (res?.data?.data?.reason || 'Unknown'));
     }
  } catch (e) { 
      if (e === 'cancel') return;
      ElMessage.error('撤回失败'); 
  }
}

/* ===== Whiteboard invite helpers ===== */
function onJoinWhiteboard(m) {
  let boardId = null;
  if(m.content && String(m.content).startsWith('whiteboard_invite:')) {
      boardId = String(m.content).split(':')[1];
  }
  if (boardId) {
       window.dispatchEvent(new CustomEvent('openWhiteboard', { detail: { boardId } }));
  }
}

/* autoscroll when messages change */
watch(
    messages,
    async () => {
      await nextTick();
      const el = bodyRef.value;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    },
    { flush: 'post', deep: true }
);
</script>

<template>
  <div class="chat_window f">
    <ChatHeader />

    <div v-if="!selected" class="empty_state" style="padding:20px;color:#999; text-align: center; margin-top: 20%;">
      请选择联系人开始聊天
    </div>

    <div v-else class="messages" ref="bodyRef">
       <!-- Iterate Groups -->
       <template v-for="group in groupedMessages" :key="group.id">
       <div v-if="group.showTime" class="group-time-header">
           <span class="time-badge">{{ group.displayTime }}</span>
       </div>
       <div 
          :class="['group-container', group.isMine ? 'group-me' : 'group-them']"
       >
          <!-- Left Avatar (only for THEM) -->
          <div v-if="!group.isMine" class="group-avatar">
              <el-avatar 
                :src="selected.avatarUrl || me.getDefaultProfile()" 
                :size="40"
                shape="circle"
              />
          </div>

          <!-- Message Stacks -->
          <div class="group-stack">
              <div 
                  v-for="(m, idx) in group.messages" 
                  :key="m.id || idx"
                  class="msg-row"
              > 
                <!-- Bubble -->
                <div class="bubble" :class="isMine(m) ? 'bubble-me' : 'bubble-them'">
                    <!-- Content Logic -->
                    <template v-if="m.imageUrl">
                        <a
                            v-if="isImageUrl(m.imageUrl, m.messageType)"
                            :href="m.imageUrl"
                            target="_blank"
                            class="media-wrap"
                        >
                            <img :src="m.imageUrl" class="bubble-img" />
                        </a>
                        <div v-else class="file-msg-box">
                            <div class="file-msg-body">
                                <div class="file-msg-icon">
                                    <span>{{ getFileExt(m.content || m.imageUrl) || 'FILE' }}</span>
                                </div>
                                <div class="file-msg-text">
                                    <div class="file-msg-name" :title="m.content || m.imageUrl">
                                        {{ m.content || '未命名文件' }}
                                    </div>
                                </div>
                            </div>
                            <div class="file-msg-footer">
                                <a :href="m.imageUrl" target="_blank" class="file-open-btn">
                                    打开
                                </a>
                            </div>
                        </div>
                    </template>
                    <template v-else>
                         <!-- Whiteboard or Text -->
                         <div v-if="m.messageType === 'WHITEBOARD_INVITE' || (m.content && String(m.content).startsWith('whiteboard_invite:'))" class="whiteboard-invite">
                              <strong>白板邀请</strong>
                              <el-button size="small" type="primary" style="margin-top:5px;" @click="onJoinWhiteboard(m)">加入</el-button>
                         </div>
                         <div v-else>{{ formatContent(m.content) }}</div>
                    </template>
                </div>

                <!-- Status (Always visible) -->
                 <div v-if="isMine(m)" class="msg-status">
                    <el-text type="info" size="small" style="font-size: 11px;">{{ m._read ? '已读' : '未读' }}</el-text>
                </div>

                <!-- Actions (Hover only) -->
                <div class="msg-actions" :class="isMine(m) ? 'actions-me' : 'actions-them'">
                    <el-link type="danger" :underline="false" style="font-size: 11px;" @click="onDeleteMessage(m)">删除</el-link>
                    <el-link v-if="canRecall(m)" type="warning" :underline="false" style="font-size: 11px;" @click="onRecallMessage(m)">撤回</el-link>
                </div>
              </div>
          </div>
       </div>
       </template>
    </div>

    <ChatInput></ChatInput>
  </div>
</template>

<style scoped>
.chat_window {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background-color: #f2f3f5;
}

.messages {
  flex: 1 1 auto;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px;
}

.group-container {
    display: flex;
    margin-bottom: 12px;
    gap: 10px;
}

.group-me {
    justify-content: flex-end;
}
.group-them {
    justify-content: flex-start;
}

.group-avatar {
    flex-shrink: 0;
    width: 40px;
    display: flex;
    flex-direction: column;
    justify-content: flex-start; /* Avatar at top */
}

.group-stack {
    display: flex;
    flex-direction: column;
    gap: 4px; /* Space between continuous messages */
    max-width: 80%;
}

.msg-row {
    display: flex;
    align-items: center; /* Vertically center actions with bubble */
    gap: 8px;
}

/* Alignments inside the stack */
.group-me .msg-row {
    flex-direction: row-reverse; /* Actions on the left of bubble */
}
.group-them .msg-row {
    flex-direction: row; /* Actions on the right of bubble */
}

.bubble {
    padding: 8px 12px;
    border-radius: 8px;
    color: #000;
    white-space: pre-wrap;
    word-break: break-word;
    position: relative;
    max-width: 100%;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

.bubble-me {
    background: #f7d6e0;
    border-top-right-radius: 4px; 
    border-bottom-right-radius: 4px;
    border-top-left-radius: 8px;
    border-bottom-left-radius: 8px;
}
/* If stacked, reduce radius between them */
.group-me .msg-row:not(:first-child) .bubble-me {
    border-top-right-radius: 2px;
}
.group-me .msg-row:not(:last-child) .bubble-me {
    border-bottom-right-radius: 2px;
}

.bubble-them {
    background: #fff;
    border-top-left-radius: 4px;
    border-bottom-left-radius: 4px;
    border-top-right-radius: 8px;
    border-bottom-right-radius: 8px;
}
/* If stacked, reduce radius */
.group-them .msg-row:not(:first-child) .bubble-them {
     border-top-left-radius: 2px;
}
.group-them .msg-row:not(:last-child) .bubble-them {
     border-bottom-left-radius: 2px;
}

.bubble-img {
    max-width: 200px;
    border-radius: 4px;
    display: block;
}

.media-wrap {
    display: inline-block;
}

.file-card {
    display: flex;
    align-items: center;
    gap: 8px;
}
.file-icon {
    background: #eee;
    padding: 5px;
    border-radius: 4px;
    font-size: 10px;
}

.msg-actions {
    opacity: 0; /* Hidden by default */
    transition: opacity 0.2s;
    display: flex;
    gap: 6px;
    white-space: nowrap;
}
.msg-row:hover .msg-actions {
    opacity: 1; /* Show on hover */
}

.whiteboard-invite {
    padding: 5px;
    text-align: center;
}

.group-time-header {
    display: flex;
    justify-content: center;
    margin: 10px 0;
}
.time-badge {
    background-color: rgba(0,0,0,0.05);
    color: #888;
    font-size: 12px;
    padding: 3px 6px;
    border-radius: 2px;
}

/* File Message Formatting */
.file-msg-box {
    background-color: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 6px;
    width: 240px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.file-msg-body {
    padding: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
    background-color: #fff; /* "Middle white" */
}

.file-msg-icon {
    width: 48px;
    height: 48px;
    background: #ffb060; /* Orange-ish for files */
    color: white;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: bold;
    text-transform: uppercase;
    flex-shrink: 0;
}

.file-msg-text {
    flex: 1;
    min-width: 0; /* truncate fix */
    display: flex;
    flex-direction: column;
    justify-content: center;
}

.file-msg-name {
    font-size: 14px;
    font-weight: 500;
    color: #333;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-bottom: 2px;
}

.file-msg-footer {
    border-top: 1px solid #f0f0f0;
    padding: 0;
    background-color: #fafafa;
}

.file-open-btn {
    display: block;
    width: 100%;
    text-align: center;
    padding: 8px 0;
    color: #409EFF; /* Element Blue */
    font-size: 13px;
    text-decoration: none;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
}
.file-open-btn:hover {
    background-color: #f2f8fe;
}
</style>