<script setup>
import { ref } from 'vue';
import MessageSideBar from "@/feature/Momotalk/components/Chat/MessageSideBar.vue";
import ChatWindow from "@/feature/Momotalk/components/Chat/ChatWindow.vue";

const sidebarWidth = ref(255);
const isResizing = ref(false);
const startX = ref(0);
const startWidth = ref(0);

function startResize(e) {
  isResizing.value = true;
  startX.value = e.clientX;
  startWidth.value = sidebarWidth.value;
  
  document.addEventListener('mousemove', handleResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function handleResize(e) {
  if (!isResizing.value) return;
  const dx = e.clientX - startX.value;
  const newWidth = startWidth.value + dx;
  
  // Min 150px, Max 500px boundaries
  if (newWidth >= 150 && newWidth <= 500) {
    sidebarWidth.value = newWidth;
  }
}

function stopResize() {
  isResizing.value = false;
  document.removeEventListener('mousemove', handleResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}
</script>

<template>
  <div class="message_container">
    <div class="resizable-sidebar" :style="{ width: sidebarWidth + 'px' }">
      <MessageSideBar />
    </div>
    
    <!-- Drag Handle -->
    <div class="resize-handle" @mousedown="startResize"></div>

    <div class="chat_container">
      <ChatWindow></ChatWindow>
    </div>
  </div>
</template>

<style scoped>
.message_container{
  display: flex;
  width: 100%;
  height: calc(100vh - 64px);
}
.resizable-sidebar {
  height: 100%;
  flex-shrink: 0;
}
.resize-handle {
  width: 4px;
  height: 100%;
  cursor: col-resize;
  background-color: transparent;
  transition: background-color 0.2s;
  z-index: 10;
}
.resize-handle:hover,
.resize-handle:active {
  background-color: #ffb3d9; /* The pink theme color */
}

.chat_container{
  display: flex;
  flex-direction: column;
  flex: 1;        /* 占据剩余空间 */
  width: auto;    /* 可选：移除 calc(100% - 1px) 的硬宽度 */
  height: 100%;
  overflow: hidden; /* Ensure content doesn't break layout */
}
</style>