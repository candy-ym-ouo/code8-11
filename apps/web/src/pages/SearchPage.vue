<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { booksApi, searchApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import {
  TRACE_LABELS,
  type Book,
  type SearchHit,
  type SearchSnippet,
  type TraceType
} from '../types/domain';

const query = ref('');
const type = ref<'ALL' | TraceType>('ALL');
const bookId = ref('');
const books = ref<Book[]>([]);
const hits = ref<SearchHit[]>([]);
const indexBuilding = ref(false);
const loading = ref(false);
const searched = ref(false);
const error = ref('');
const page = ref(1);
const pageSize = 20;
const total = ref(0);

interface SnippetSegment {
  text: string;
  marked: boolean;
}

/** 按区间把摘要切成普通/高亮片段，全程纯文本渲染，不使用 v-html。 */
function segments(snippet: SearchSnippet): SnippetSegment[] {
  const ranges = [...snippet.highlights].sort((a, b) => a.start - b.start);
  const result: SnippetSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    const start = Math.max(range.start, cursor);
    if (start > cursor) result.push({ text: snippet.text.slice(cursor, start), marked: false });
    result.push({ text: snippet.text.slice(start, range.end), marked: true });
    cursor = range.end;
  }
  if (cursor < snippet.text.length) {
    result.push({ text: snippet.text.slice(cursor), marked: false });
  }
  return result.length > 0 ? result : [{ text: snippet.text, marked: false }];
}

function params(): URLSearchParams {
  const value = new URLSearchParams({ q: query.value.trim(), page: String(page.value), pageSize: String(pageSize) });
  if (type.value !== 'ALL') value.set('type', type.value);
  if (bookId.value) value.set('bookId', bookId.value);
  return value;
}

async function load(): Promise<void> {
  const keyword = query.value.trim();
  if (!keyword) {
    hits.value = [];
    total.value = 0;
    searched.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const result = await searchApi.traces(params());
    hits.value = result.items;
    total.value = result.pagination.total;
    indexBuilding.value = result.index.building;
    searched.value = true;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '搜索失败';
  } finally {
    loading.value = false;
  }
}

function submit(): void {
  page.value = 1;
  void load();
}

async function loadBooks(): Promise<void> {
  try {
    const result = await booksApi.list(new URLSearchParams({ page: '1', pageSize: '100' }));
    books.value = result.items;
  } catch {
    books.value = [];
  }
}

function pageLabel(hit: SearchHit): string {
  return hit.pageStart === hit.pageEnd ? `第 ${hit.pageStart} 页` : `第 ${hit.pageStart}–${hit.pageEnd} 页`;
}

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

onMounted(loadBooks);
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">SEARCH MY TRACES</p>
        <h1>搜索痕迹</h1>
        <p>在你自己的折角、批注与重读记录里全文查找，范围始终只限你本人。</p>
      </div>
    </header>

    <form class="toolbar card" @submit.prevent="submit">
      <label class="grow">
        关键词
        <input v-model="query" type="search" placeholder="中文、英文或数字，例如：存在主义、Kafka、2024" />
      </label>
      <label>
        类型
        <select v-model="type" @change="submit">
          <option value="ALL">全部痕迹</option>
          <option value="DOG_EAR">{{ TRACE_LABELS.DOG_EAR }}</option>
          <option value="ANNOTATION">{{ TRACE_LABELS.ANNOTATION }}</option>
          <option value="REREAD_MARK">{{ TRACE_LABELS.REREAD_MARK }}</option>
        </select>
      </label>
      <label>
        书目
        <select v-model="bookId" @change="submit">
          <option value="">全部书目</option>
          <option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option>
        </select>
      </label>
      <button class="button button-primary" type="submit">搜索</button>
    </form>

    <ErrorNotice :message="error" />
    <p v-if="indexBuilding" class="index-note" role="status">索引正在后台重建，期间写入与搜索都不会中断，稍后结果会自动更新。</p>
    <div v-if="loading" class="state-panel">正在索引中查找…</div>
    <div v-else-if="searched && hits.length === 0" class="empty-state card">
      <h2>没有找到匹配的痕迹</h2>
      <p>换一个词试试，或者确认当时写的是不是另外的说法。</p>
    </div>
    <div v-else-if="hits.length > 0">
      <p class="result-count">共 {{ total }} 条匹配</p>
      <article v-for="hit in hits" :key="`${hit.entityType}-${hit.entityId}`" class="search-hit card">
        <div class="search-hit-heading">
          <span class="status-badge">{{ TRACE_LABELS[hit.entityType] }}</span>
          <strong><RouterLink :to="`/books/${hit.bookId}`">{{ hit.bookTitle }}</RouterLink></strong>
          <span class="muted">{{ pageLabel(hit) }}</span>
          <time class="search-hit-time" :datetime="hit.createdAt">{{ formatDateTime(hit.createdAt) }}</time>
        </div>
        <p class="search-snippet">
          <template v-for="(segment, index) in segments(hit.snippet)" :key="index">
            <mark v-if="segment.marked">{{ segment.text }}</mark>
            <span v-else>{{ segment.text }}</span>
          </template>
        </p>
      </article>
    </div>

    <nav v-if="totalPages > 1" class="pagination" aria-label="搜索结果分页">
      <button class="button button-quiet" :disabled="page <= 1" @click="page--; load()">上一页</button>
      <span>第 {{ page }} 页，共 {{ totalPages }} 页</span>
      <button class="button button-quiet" :disabled="page >= totalPages" @click="page++; load()">下一页</button>
    </nav>
  </section>
</template>
