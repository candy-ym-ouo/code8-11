import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { AppError, zodFields } from '../../lib/errors.js';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { paginationFromQuery } from '../../lib/http.js';
import type { SearchDocument } from '../../lib/search/document.js';
import { searchService } from '../../lib/search/index.js';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, '请输入搜索词').max(200, '搜索词过长'),
  type: z.enum(TRACE_TYPES as [TraceType, ...TraceType[]]).optional(),
  bookId: z.string().uuid('bookId 无效').optional()
});

function serializeHit(doc: SearchDocument, score: number) {
  const base = {
    id: doc.traceId,
    type: doc.traceType,
    bookId: doc.bookId,
    bookTitle: doc.bookTitle,
    text: doc.text,
    score: Math.round(score * 1000) / 1000,
    updatedAt: doc.updatedAt
  };
  if (doc.traceType === 'ANNOTATION') {
    return { ...base, startPage: doc.startPage, endPage: doc.endPage };
  }
  return { ...base, pageNumber: doc.pageNumber };
}

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  // 痕迹全文检索：只检索当前登录用户自己的索引，天然用户隔离。
  app.get('/search/traces', async (request) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      throw new AppError(422, 'VALIDATION_ERROR', '搜索参数无效', zodFields(parsed.error));
    }
    const userId = currentUser(request).id;
    const { page, pageSize } = paginationFromQuery(request);
    const { q, type, bookId } = parsed.data;
    const result = await searchService.search(userId, {
      query: q,
      ...(type ? { types: new Set<TraceType>([type]) } : {}),
      ...(bookId ? { bookId } : {}),
      page,
      pageSize
    });
    return {
      items: result.items.map(({ doc, score }) => serializeHit(doc, score)),
      pagination: { page, pageSize, total: result.total }
    };
  });

  // 手动触发当前用户索引的全量重建；重建期间读写照常。
  app.post('/search/reindex', async (request) => {
    const userId = currentUser(request).id;
    const documents = await searchService.rebuild(userId);
    return { documents };
  });
};
