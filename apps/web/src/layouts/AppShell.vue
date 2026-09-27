<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const router = useRouter();

async function logout(): Promise<void> {
  await auth.logout();
  await router.push('/login');
}
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <RouterLink class="brand" to="/" aria-label="返回我的书">
        <span class="brand-mark">页</span>
        <span>
          <strong>纸质书阅读痕迹</strong>
          <small>只记住书与你</small>
        </span>
      </RouterLink>
      <nav class="main-nav" aria-label="主导航">
        <RouterLink to="/">我的书</RouterLink>
        <RouterLink to="/search">搜索</RouterLink>
        <RouterLink to="/timeline">时间线</RouterLink>
        <RouterLink to="/settings">设置</RouterLink>
      </nav>
      <div class="account">
        <span class="account-email" :title="auth.user?.email">{{ auth.user?.email }}</span>
        <button class="button button-quiet" type="button" @click="logout">退出</button>
      </div>
    </header>
    <main class="page-container">
      <RouterView />
    </main>
  </div>
</template>
