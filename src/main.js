import './assets/styles/global.css'
import './assets/icons/iconfont.css'
import 'animate.css'
import { userStore } from '@/stores/UserStore.js';
import axios from 'axios';

import { createApp } from 'vue';
import {createPinia} from "pinia";
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue';
import router from './router'; // 你自己创建的 router 实例 (vue-router v4)

const app = createApp(App);
const pinia=createPinia();
app.use(pinia);
app.use(ElementPlus)
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}
app.use(router); // <--- 关键：全局注册 vue-router 的组件 (RouterLink / RouterView)
app.mount('#app');

// 添加请求拦截器
axios.interceptors.request.use(config => {
    const store = userStore();
    const token = store.getToken();

    if (token) {
        // 将 Token 注入到 Authorization 头中
        config.headers['Authorization'] = `Bearer ${token}`;
    }
    return config;
}, error => {
    return Promise.reject(error);
});