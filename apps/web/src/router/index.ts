import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import AppShell from '../layouts/AppShell.vue';
import LoginPage from '../pages/LoginPage.vue';
import RegisterPage from '../pages/RegisterPage.vue';
import BooksPage from '../pages/BooksPage.vue';
import BookFormPage from '../pages/BookFormPage.vue';
import BookDetailPage from '../pages/BookDetailPage.vue';
import SearchPage from '../pages/SearchPage.vue';
import TimelinePage from '../pages/TimelinePage.vue';
import SettingsPage from '../pages/SettingsPage.vue';
import NotFoundPage from '../pages/NotFoundPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginPage, meta: { public: true, guestOnly: true } },
    { path: '/register', component: RegisterPage, meta: { public: true, guestOnly: true } },
    {
      path: '/',
      component: AppShell,
      children: [
        { path: '', name: 'books', component: BooksPage },
        { path: 'books/new', name: 'book-new', component: BookFormPage },
        { path: 'books/:bookId', name: 'book-detail', component: BookDetailPage },
        { path: 'books/:bookId/edit', name: 'book-edit', component: BookFormPage },
        { path: 'search', name: 'search', component: SearchPage },
        { path: 'timeline', name: 'timeline', component: TimelinePage },
        { path: 'settings', name: 'settings', component: SettingsPage }
      ]
    },
    { path: '/:pathMatch(.*)*', component: NotFoundPage }
  ]
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.initialize();
  if (!to.meta.public && !auth.isAuthenticated) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.meta.guestOnly && auth.isAuthenticated) return { name: 'books' };
  return true;
});
