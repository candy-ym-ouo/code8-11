import type { FastifyPluginAsync } from 'fastify';
import { TRACE_TYPES, type TraceType } from '@paper-book-traces/shared';
import { currentUser, requireAuth } from '../../lib/auth.js';
import { AppError } from '../../lib/errors.js';
import { paginationFromQuery, parseId } from '../../lib/http.js';
import { searchTraces } from '../../search/query.js';
import { getIndexStatus, requestRebuild } from '../../search/rebuild.js';

export const searchRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get(
    '/search/traces',
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: '1 minute'
        }
      }
    },
    async (request) => {
      const userId = currentUser(request).id;
      const query = request.query as Record<string, unknown>;

      const rawQuery = typeof query.q === 'string' ? query.q.trim() : '';
      if (!rawQuery) {
        throw new AppError(422, 'VALIDATION_ERROR', '请输入搜索关键词', { q: '请输入搜索关键词' });
      }
      if (rawQuery.length > 200) {
        throw new AppError(422, 'VALIDATION_ERROR', '搜索关键词最长 200 字', { q: '搜索关键词最长 200 字' });
      }

      const type = typeof query.type === 'string' && query.type !== 'ALL' ? query.type : undefined;
      if (type && !TRACE_TYPES.includes(type as TraceType)) {
        throw new AppError(422, 'VALIDATION_ERROR', '痕迹类型无效');
      }

      const bookId =
        typeof query.bookId === 'string' && query.bookId ? parseId(query.bookId, 'bookId') : undefined;

      let pageNumber: number | undefined;
      if (query.pageNumber !== undefined) {
        pageNumber = Number(query.pageNumber);
        if (!Number.isInteger(pageNumber) || pageNumber < 1) {
          throw new AppError(422, 'VALIDATION_ERROR', '页码无效');
        }
      }

      const { page, pageSize } = paginationFromQuery(request);
      const result = await searchTraces(userId, {
        query: rawQuery,
        type: type as TraceType | undefined,
        bookId,
        pageNumber,
        page,
        pageSize
      });

      return {
        items: result.items,
        pagination: { page, pageSize, total: result.total },
        index: { ready: result.ready, building: result.building }
      };
    }
  );

  app.get('/search/status', async () => {
    const status = await getIndexStatus();
    return {
      active: status.active,
      building: status.building,
      lastRebuildAt: status.lastRebuildAt,
      lastRebuildFailedAt: status.lastRebuildFailedAt
    };
  });

  app.post(
    '/search/rebuild',
    {
      config: {
        rateLimit: {
          max: 6,
          timeWindow: '1 hour'
        }
      }
    },
    async (request, reply) => {
      // 仅校验会话；重建是用户个人档案维护操作，重建范围为全库所有用户的痕迹。
      currentUser(request);
      const result = await requestRebuild();
      if (!result.started) {
        throw new AppError(409, 'REBUILD_RUNNING', '索引重建正在进行中，请稍后查看状态');
      }
      return reply.status(202).send({
        rebuild: {
          generationId: result.generationId,
          status: 'BUILDING',
          message: '重建已在后台开始，期间写入与搜索均不受影响'
        }
      });
    }
  );
};
