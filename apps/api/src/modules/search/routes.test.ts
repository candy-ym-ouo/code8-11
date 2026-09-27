import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, sendError } from '../../lib/errors.js';
import type { SearchDocument } from '../../lib/search/document.js';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  rebuild: vi.fn()
}));

vi.mock('../../lib/search/index.js', () => ({
  searchService: {
    search: mocks.search,
    rebuild: mocks.rebuild
  },
  indexTraceSafely: vi.fn(),
  indexBookSafely: vi.fn()
}));

vi.mock('../../lib/auth.js', async () => {
  const errors = await import('../../lib/errors.js');
  return {
    requireAuth: async (request: { headers: Record<string, unknown>; authUser?: unknown }) => {
      const userId = request.headers['x-test-user-id'];
      if (typeof userId !== 'string' || !userId) {
        throw new errors.AppError(401, 'UNAUTHENTICATED', '请先登录');
      }
      request.authUser = { id: userId, email: 't@example.com', createdAt: new Date() };
    },
    currentUser: (request: { authUser?: { id: string } }) => {
      if (!request.authUser) throw new errors.AppError(401, 'UNAUTHENTICATED', '请先登录');
      return request.authUser;
    }
  };
});

const { searchRoutes } = await import('./routes.js');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

function annotationDoc(overrides?: Partial<SearchDocument>): SearchDocument {
  return {
    key: 'ANNOTATION:t1',
    userId: USER_A,
    traceType: 'ANNOTATION',
    traceId: 't1',
    bookId: 'b1',
    bookTitle: '活着',
    bookAuthor: '余华',
    text: '这里的论证非常精彩',
    pageNumber: null,
    startPage: 10,
    endPage: 12,
    version: 3,
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...overrides
  };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return sendError(reply, error.statusCode, error.code, error.message, error.fields, request.id);
    }
    return sendError(reply, 500, 'INTERNAL_ERROR', '服务器暂时无法处理请求', undefined, request.id);
  });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  return app;
}

describe('searchRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it('未登录返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search/traces?q=笔记' });
    expect(response.statusCode).toBe(401);
  });

  it('缺少搜索词返回 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/search/traces',
      headers: { 'x-test-user-id': USER_A }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('非法痕迹类型返回 422', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/search/traces?q=笔记&type=NOPE',
      headers: { 'x-test-user-id': USER_A }
    });
    expect(response.statusCode).toBe(422);
  });

  it('检索只使用会话中的 userId，且解析类型过滤', async () => {
    mocks.search.mockResolvedValue({ items: [], total: 0 });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/search/traces?q=%E7%AC%94%E8%AE%B0&type=ANNOTATION&page=2&pageSize=10',
      headers: { 'x-test-user-id': USER_A }
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    const [userId, query] = mocks.search.mock.calls[0]!;
    expect(userId).toBe(USER_A);
    expect(query.query).toBe('笔记');
    expect([...query.types]).toEqual(['ANNOTATION']);
    expect(query.page).toBe(2);
    expect(query.pageSize).toBe(10);
  });

  it('不同用户各自检索，结果互不串扰', async () => {
    mocks.search.mockImplementation(async (userId: string) => ({
      items: userId === USER_A ? [{ doc: annotationDoc(), score: 1.23456 }] : [],
      total: userId === USER_A ? 1 : 0
    }));
    const url = '/api/v1/search/traces?q=%E8%AE%BA%E8%AF%81';
    const responseA = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': USER_A } });
    const responseB = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': USER_B } });
    expect(responseA.json().pagination.total).toBe(1);
    expect(responseB.json().pagination.total).toBe(0);
    expect(mocks.search.mock.calls.map((call) => call[0])).toEqual([USER_A, USER_B]);
  });

  it('命中结果按痕迹类型序列化并保留分数', async () => {
    mocks.search.mockResolvedValue({ items: [{ doc: annotationDoc(), score: 1.23456 }], total: 1 });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/search/traces?q=%E8%AE%BA%E8%AF%81',
      headers: { 'x-test-user-id': USER_A }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pagination).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(body.items[0]).toMatchObject({
      id: 't1',
      type: 'ANNOTATION',
      bookId: 'b1',
      bookTitle: '活着',
      score: 1.235,
      startPage: 10,
      endPage: 12
    });
  });

  it('手动重建只作用于当前用户', async () => {
    mocks.rebuild.mockResolvedValue(42);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/search/reindex',
      headers: { 'x-test-user-id': USER_A }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ documents: 42 });
    expect(mocks.rebuild).toHaveBeenCalledWith(USER_A);
  });
});
