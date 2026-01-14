import { defineStore } from 'pinia';
import { ref } from 'vue';
import axios from "axios";
import { userStore } from "@/stores/UserStore.js";

export const userChat = defineStore('userChat', () => {
    const friendList = ref([]);
    const agreeingList = ref([]);

    function getFriendList(){ return friendList; }
    function getAgreeingList(){ return agreeingList; }

    async function updateFriendList(){
        const res = await axios.post('/api/chat/sessions/list', {});
        friendList.value = res.data.data.sessions;
    }
    async function updateAgreeingList(){
        const res = await axios.post('/api/chat/friends/request/list', {});
        agreeingList.value = res.data.data.items;
    }
    function setFriendOnline(userId, online) {
        const f = friendList.value.find(x => Number(x.sessionTargetId) === Number(userId));
        if (f) f.online = !!online;
    }

    const me = userStore();
    const selectedConversation = ref(null);
    const messages = ref({});

    function getSelectedConversation(){ return selectedConversation; }
    function resetForLogout() { selectedConversation.value = null; messages.value = {}; }

    function getMessagesForSelected(){
        const conv = selectedConversation.value;
        if (!conv) return [];
        const key = `user_${String(conv.id)}`;
        messages.value[key] = messages.value[key] || [];
        return messages.value[key];
    }

    // 追加私聊消息：把消息放到 otherId 的会话数组里
    function appendPrivateMessage(fromUserId, toUserId, msg) {
        const myId = String(me.getUserId());
        const from = String(fromUserId);
        const to   = String(toUserId);
        const otherId = (from === myId) ? to : from;
        const key = `user_${otherId}`;
        messages.value[key] = messages.value[key] || [];

        // 确保保留 logicMessageId（用于撤回匹配）
        if (msg && msg.logicMessageId == null) {
            msg.logicMessageId = msg.id;
        }
        // 给我发出的消息加上已读标记（默认未读，等对方读到后置 true）
        if (String(msg?.fromUserId) === myId) {
            if (typeof msg._read === 'undefined') msg._read = false;
        }

        messages.value[key].push(msg);

        const sel = selectedConversation.value;
        if (sel && String(sel.id) === otherId) {
            // 当前会话：可在此发送已读回执（按需）
        } else {
            // 非当前会话：可增加未读计数（按需）
        }
    }

    function appendMessageByKey(key, msg) {
        messages.value[key] = messages.value[key] || [];
        messages.value[key].push(msg);
    }

    async function loadAllFriendHistories(page = 0) {
        if (!friendList.value || friendList.value.length === 0) return;

        const requests = friendList.value.map(f =>
            axios.post('/api/chat/messages/private/getMessage', {
                friendId: f.sessionTargetId,
                page
            }).catch(err => ({ __err: err }))
        );

        const results = await Promise.all(requests);

        results.forEach((res, idx) => {
            const friend = friendList.value[idx];
            if (!res || res.__err) {
                console.warn('[loadAllFriendHistories] 请求失败 friendId=', friend?.sessionTargetId, res && res.__err);
                return;
            }
            const msgs = res.data?.data?.messages || res.data?.messages || [];
            if (Array.isArray(msgs) && msgs.length > 1) {
                msgs.reverse();
            }

            msgs.forEach(p => {
                let created = p.createdAt || p.created_at || null;
                if (created && typeof created === 'string') {
                    created = created.replace(/(\.\d{3})\d+/, '$1');
                }
                const timestamp = created ? new Date(created).getTime() : (p.timestamp || Date.now());

                const logicMessageId =
                    p.logicMessageId ??
                    p.logic_message_id ??
                    p.logicId ??
                    p.logic_id ??
                    p.id;

                const msg = {
                    id: p.id,
                    logicMessageId,
                    conversationType: p.conversationType,
                    fromUserId: p.fromUserId,
                    toUserId: p.toUserId,
                    groupId: p.groupId || null,
                    messageType: p.messageType,
                    content: p.content,
                    imageUrl: p.imageUrl || p.fileUrl || null,
                    timestamp
                };

                appendPrivateMessage(p.fromUserId, p.toUserId, msg);
            });
        });
    }

    function getConversationBoardId(otherId) {
        const key = `user_${String(otherId)}`;
        const obj = messages.value[key] || {};
        return obj._boardId || null;
    }
    function setConversationBoardId(otherId, boardId) {
        const key = `user_${String(otherId)}`;
        messages.value[key] = messages.value[key] || [];
        messages.value[key]._boardId = boardId;
    }

    function selectConversation(user) {
        selectedConversation.value = user;
        if (user === null) return;
        const key = `user_${String(user.id)}`;
        messages.value[key] = messages.value[key] || [];
        // 清零未读并通知后端
        markConversationRead(user.id);
    }

    // 预览文案
    function buildPreview(messageType, content) {
        const t = String(messageType || '').toUpperCase();
        if (t === 'IMAGE') return '[图片]';
        if (t === 'FILE')  return '[文件]';
        if (t === 'VIDEO') return '[视频]';
        if (t === 'AUDIO') return '[音频]';
        if (!content) return '';
        const s = String(content);
        return s.length <= 10 ? s : s.slice(0, 10) + '...';
    }

    function ensureSessionItemForFriend(otherId) {
        const idNum = Number(otherId);
        let item = friendList.value.find(x => Number(x.sessionTargetId) === idNum);
        if (!item) {
            item = {
                sessionType: 'PRIVATE',
                sessionTargetId: idNum,
                title: String(idNum),
                lastMessagePreview: '',
                lastMessageTime: null,
                unreadCount: 0,
                signature: '',
                avatarUrl: null,
                online: false
            };
            friendList.value.push(item);
        }
        return item;
    }

    function updateSessionOnNewPrivateMessage(fromUserId, toUserId, msg) {
        const myId = String(me.getUserId());
        const from = String(fromUserId);
        const to   = String(toUserId);
        const otherId = (from === myId) ? to : from;
        const item = ensureSessionItemForFriend(otherId);

        item.lastMessageTime = msg.timestamp ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
        item.lastMessagePreview = buildPreview(msg.messageType, msg.content);

        const isIncoming = (to === myId);
        const isActive = (selectedConversation.value && String(selectedConversation.value.id) === String(otherId));
        if (isIncoming && !isActive) {
            item.unreadCount = (item.unreadCount || 0) + 1;
        }

        friendList.value.sort((a, b) => {
            const ta = a.lastMessageTime ? new Date(a.lastMessageTime).getTime() : 0;
            const tb = b.lastMessageTime ? new Date(b.lastMessageTime).getTime() : 0;
            return tb - ta;
        });
    }

    async function markConversationRead(otherId) {
        const idNum = Number(otherId);
        const item = friendList.value.find(x => Number(x.sessionTargetId) === idNum);
        if (item) item.unreadCount = 0;
        try {
            await axios.post('/api/chat/messages/private/markRead', { friendId: idNum });
        } catch (e) {
            console.warn('[markConversationRead] api failed', e?.message);
        }
    }

    function getPendingRequestsCount() {
        return (agreeingList.value || []).length;
    }

    // 撤回：按 logicMessageId 移除所有会话里的该条消息（A/B 两端皆适用）
    function recallMessageByLogicId(logicId) {
        if (logicId === undefined || logicId === null) return;
        const logicStr = String(logicId);
        Object.keys(messages.value).forEach(k => {
            const arr = messages.value[k];
            if (!Array.isArray(arr) || arr.length === 0) return;
            const filtered = arr.filter(m => {
                const mid = String(m.id);
                const lid = m.logicMessageId != null ? String(m.logicMessageId) : '';
                // 发送者侧：id 就是 logicId；接收者侧：需要对比 logicMessageId
                return mid !== logicStr && lid !== logicStr;
            });
            if (filtered.length !== arr.length) {
                messages.value[k].splice(0, arr.length, ...filtered);
            }
        });
    }

    // 已读：对方 readerId 打开后端确认已读 -> 本端把“我发给 readerId 的消息”全部标记为已读
    function markMyMessagesReadByReader(readerId) {
        const key = `user_${String(readerId)}`;
        const arr = messages.value[key] || [];
        const myId = String(me.getUserId());
        arr.forEach(m => {
            if (String(m.fromUserId) === myId) m._read = true;
        });
    }

    return {
        getAgreeingList,
        getFriendList,
        updateFriendList,
        updateAgreeingList,
        setFriendOnline,
        resetForLogout,
        getSelectedConversation,
        getMessagesForSelected,
        selectConversation,
        appendMessageByKey,
        loadAllFriendHistories,
        appendPrivateMessage,
        getConversationBoardId,
        setConversationBoardId,
        updateSessionOnNewPrivateMessage,
        markConversationRead,
        getPendingRequestsCount,
        recallMessageByLogicId,
        markMyMessagesReadByReader,
    };
});