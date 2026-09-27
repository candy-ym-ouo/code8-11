import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildTraceDocument, type TraceSnapshot } from './document.js';

/**
 * 检索引擎集成测试：在真实 PostgreSQL（embedded-postgres，PG16）上验证
 * - 增量索引随业务写入同事务生效；
 * - 用户隔离；
 * - 增量索引与全量重建结果一致（词项级）；
 * - 重建期间写入不阻塞、不丢失。
 */

const PG_PORT = 55444;

let pg: EmbeddedPostgres;
let pgDir: string;
let app: FastifyInstance;
let prisma: PrismaClient;
let requestRebuild: typeof import('./rebuild.js').requestRebuild;
let getIndexStatus: typeof import('./rebuild.js').getIndexStatus;
let hashPassword: typeof import('../lib/auth.js').hashPassword;

interface VisibleDoc {
  entityType: string;
  entityId: string;
  content: string;
  sourceVersion: number;
  pageStart: number;
  pageEnd: number;
  termCount: number;
}

interface VisiblePosting {
  entityType: string;
  entityId: string;
  term: string;
  tf: number;
}

async function activeGenerationId(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT id FROM search_generations WHERE status = 'ACTIVE'`;
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** 当前 ACTIVE 代际的可见索引投影（墓碑不可见，不参与比较）。 */
async function dumpVisibleIndex(): Promise<{ docs: VisibleDoc[]; postings: VisiblePosting[] }> {
  const generationId = await activeGenerationId();
  const docs = await prisma.$queryRaw<VisibleDoc[]>`
    SELECT entity_type::text AS "entityType", entity_id::text AS "entityId",
           content, source_version AS "sourceVersion",
           page_start AS "pageStart", page_end AS "pageEnd",
           term_count AS "termCount"
    FROM search_documents
    WHERE generation_id = ${generationId} AND deleted_at IS NULL
    ORDER BY entity_type::text COLLATE "C", entity_id`;
  const postings = await prisma.$queryRaw<VisiblePosting[]>`
    SELECT d.entity_type::text AS "entityType", d.entity_id::text AS "entityId",
           p.term, p.tf
    FROM search_postings p
    JOIN search_documents d ON d.id = p.document_id
    WHERE p.generation_id = ${generationId} AND d.deleted_at IS NULL
    ORDER BY d.entity_type::text COLLATE "C", d.entity_id, p.term COLLATE "C"`;
  return { docs, postings };
}

/** 从业务表独立计算「索引应该是什么样」，作为一致性的第三方基准。 */
async function expectedFromSource(): Promise<{ docs: VisibleDoc[]; postings: VisiblePosting[] }> {
  const [dogEars, annotations, rereadMarks] = await Promise.all([
    prisma.dogEar.findMany({ where: { deletedAt: null, user: { status: 'ACTIVE', deletedAt: null } } }),
    prisma.annotation.findMany({ where: { deletedAt: null, user: { status: 'ACTIVE', deletedAt: null } } }),
    prisma.rereadMark.findMany({ where: { deletedAt: null, user: { status: 'ACTIVE', deletedAt: null } } })
  ]);
  const snapshots: TraceSnapshot[] = [
    ...dogEars.map((row) => ({
      userId: row.userId,
      bookId: row.bookId,
      entityType: 'DOG_EAR' as const,
      entityId: row.id,
      sourceVersion: row.version,
      pageStart: row.pageNumber,
      pageEnd: row.pageNumber,
      text: row.reason,
      sourceCreatedAt: row.createdAt,
      deleted: false
    })),
    ...annotations.map((row) => ({
      userId: row.userId,
      bookId: row.bookId,
      entityType: 'ANNOTATION' as const,
      entityId: row.id,
      sourceVersion: row.version,
      pageStart: row.startPage,
      pageEnd: row.endPage,
      text: row.content,
      sourceCreatedAt: row.createdAt,
      deleted: false
    })),
    ...rereadMarks.map((row) => ({
      userId: row.userId,
      bookId: row.bookId,
      entityType: 'REREAD_MARK' as const,
      entityId: row.id,
      sourceVersion: row.version,
      pageStart: row.pageNumber,
      pageEnd: row.pageNumber,
      text: row.reason,
      sourceCreatedAt: row.createdAt,
      deleted: false
    }))
  ];

  const docs: VisibleDoc[] = [];
  const postings: VisiblePosting[] = [];
  for (const snapshot of snapshots) {
    const plan = buildTraceDocument(snapshot);
    if (!plan) continue;
    docs.push({
      entityType: plan.entityType,
      entityId: plan.entityId,
      content: plan.content,
      sourceVersion: plan.sourceVersion,
      pageStart: plan.pageStart,
      pageEnd: plan.pageEnd,
      termCount: plan.termCount
    });
    for (const posting of plan.postings) {
      postings.push({
        entityType: plan.entityType,
        entityId: plan.entityId,
        term: posting.term,
        tf: posting.tf
      });
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byDoc = (a: VisibleDoc, b: VisibleDoc) =>
    cmp(a.entityType, b.entityType) || cmp(a.entityId, b.entityId);
  const byPosting = (a: VisiblePosting, b: VisiblePosting) =>
    cmp(a.entityType, b.entityType) || cmp(a.entityId, b.entityId) || cmp(a.term, b.term);
  docs.sort(byDoc);
  postings.sort(byPosting);
  return { docs, postings };
}

async function rebuildAndWait(): Promise<void> {
  const started = await requestRebuild(prisma as never);
  expect(started.started).toBe(true);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = await getIndexStatus(prisma as never);
    if (status.lastRebuildFailedAt) throw new Error('rebuild failed');
    if (!status.building && status.active?.builtAt) return;
    if (Date.now() > deadline) throw new Error('rebuild timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 直接在库中创建用户与有效会话（注册接口有频率限制，且不属于本测试目标）。 */
async function directUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword('password-123456') }
  });
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await prisma.session.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
  });
  return `pbt_session=${token}`;
}

async function createBook(cookie: string, title: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/books',
    headers: { cookie },
    payload: { title, author: '作者', pageCount: 500 }
  });
  expect(response.statusCode).toBe(201);
  return response.json().book.id as string;
}

async function search(cookie: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/search/traces?${qs}`,
    headers: { cookie }
  });
  return response;
}

beforeAll(async () => {
  pgDir = mkdtempSync(join(tmpdir(), 'pbt-search-test-'));
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'app',
    password: 'app',
    port: PG_PORT,
    persistent: false
  });
  await pg.initialise();
  await pg.start();
  const pgClient = pg.getPgClient();
  await pgClient.connect();
  await pgClient.query('CREATE DATABASE pbt_test OWNER app');
  await pgClient.end();

  const databaseUrl = `postgresql://app:app@localhost:${PG_PORT}/pbt_test?schema=public`;
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    cwd: join(import.meta.dirname, '..', '..'),
    stdio: 'pipe'
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-32';

  const appModule = await import('../app.js');
  const prismaModule = await import('../lib/prisma.js');
  const rebuildModule = await import('./rebuild.js');
  const authModule = await import('../lib/auth.js');
  app = await appModule.buildApp();
  prisma = prismaModule.prisma;
  requestRebuild = rebuildModule.requestRebuild;
  getIndexStatus = rebuildModule.getIndexStatus;
  hashPassword = authModule.hashPassword;
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await pg?.stop();
  if (pgDir) rmSync(pgDir, { recursive: true, force: true });
}, 60_000);

describe('trace search (integration)', () => {
  it('indexes creates/updates/deletes/restores in the same transaction and isolates users', async () => {
    const cookieA = await directUser('a@example.com');
    const cookieB = await directUser('b@example.com');
    const bookA = await createBook(cookieA, '存在主义心理治疗');
    const bookB = await createBook(cookieB, '另一种人生');

    // A：批注（含中英文）、折角（有原因）、重读（无原因 → 不入索引）
    const annotation = await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookA}/annotations`,
      headers: { cookie: cookieA },
      payload: { startPage: 12, endPage: 14, content: '存在主义强调自我选择，Kafka 式的困境' }
    });
    expect(annotation.statusCode).toBe(201);
    const annotationId = annotation.json().annotation.id as string;

    const dogEar = await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookA}/dog-ears`,
      headers: { cookie: cookieA },
      payload: { pageNumber: 88, reason: '这段关于自由的论述值得重读' }
    });
    expect(dogEar.statusCode).toBe(201);

    const rereadNoReason = await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookA}/reread-marks`,
      headers: { cookie: cookieA },
      payload: { pageNumber: 99, reason: null }
    });
    expect(rereadNoReason.statusCode).toBe(201);

    // B：相同词语，验证隔离
    await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookB}/annotations`,
      headers: { cookie: cookieB },
      payload: { startPage: 1, endPage: 2, content: '存在主义是别人的注脚' }
    });

    // 中文短语命中
    const hit = await search(cookieA, { q: '存在主义' });
    expect(hit.statusCode).toBe(200);
    const hitBody = hit.json();
    expect(hitBody.index.ready).toBe(true);
    expect(hitBody.items.some((item: { entityId: string }) => item.entityId === annotationId)).toBe(true);
    const annotationHit = hitBody.items.find((item: { entityId: string }) => item.entityId === annotationId);
    expect(annotationHit.bookTitle).toBe('存在主义心理治疗');
    expect(annotationHit.pageStart).toBe(12);
    expect(annotationHit.snippet.text).toContain('存在主义');
    expect(annotationHit.snippet.highlights.length).toBeGreaterThan(0);

    // 英文词命中
    const kafka = await search(cookieA, { q: 'kafka' });
    expect(kafka.json().items).toHaveLength(1);

    // 用户隔离：A 搜不到 B 的内容，B 也搜不到 A 的
    const forA = await search(cookieA, { q: '别人的注脚' });
    expect(forA.json().items).toHaveLength(0);
    const forB = await search(cookieB, { q: '存在主义' });
    const bItems = forB.json().items;
    expect(bItems).toHaveLength(1);
    expect(bItems[0].bookTitle).toBe('另一种人生');

    // 无文本重读不产生索引文档
    const dump1 = await dumpVisibleIndex();
    expect(dump1.docs.filter((doc) => doc.entityType === 'REREAD_MARK')).toHaveLength(0);

    // 更新：旧词消失、新词出现
    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/annotations/${annotationId}`,
      headers: { cookie: cookieA },
      payload: { content: '现象学与日常生活的缝隙' }
    });
    expect(updated.statusCode).toBe(200);
    expect((await search(cookieA, { q: '存在主义' })).json().items).toHaveLength(0);
    expect((await search(cookieA, { q: '现象学' })).json().items).toHaveLength(1);

    // 删除：立即不可检索
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${annotationId}`,
      headers: { cookie: cookieA },
      payload: {}
    });
    expect(removed.statusCode).toBe(204);
    expect((await search(cookieA, { q: '现象学' })).json().items).toHaveLength(0);

    // 恢复：重新可检索
    const restored = await app.inject({
      method: 'POST',
      url: `/api/v1/annotations/${annotationId}/restore`,
      headers: { cookie: cookieA }
    });
    expect(restored.statusCode).toBe(200);
    expect((await search(cookieA, { q: '现象学' })).json().items).toHaveLength(1);

    // 折角按类型过滤
    const dogEarOnly = await search(cookieA, { q: '重读', type: 'DOG_EAR' });
    expect(dogEarOnly.json().items).toHaveLength(1);
    const wrongType = await search(cookieA, { q: '重读', type: 'ANNOTATION' });
    expect(wrongType.json().items).toHaveLength(0);
  }, 60_000);

  it('rejects invalid search requests and requires auth', async () => {
    const cookie = await directUser('c@example.com');
    expect((await search(cookie, { q: '' })).statusCode).toBe(422);
    expect((await search(cookie, { q: 'test', type: 'NOPE' })).statusCode).toBe(422);
    expect((await search(cookie, { q: 'test', pageNumber: '0' })).statusCode).toBe(422);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/search/traces?q=test' });
    expect(anonymous.statusCode).toBe(401);
  }, 30_000);

  it('matches incremental index, full rebuild and source-of-truth exactly', async () => {
    const cookie = await directUser('d@example.com');
    const book1 = await createBook(cookie, '第一本书');
    const book2 = await createBook(cookie, '第二本书');

    // 通过 API 制造多样化的真实写入（增量索引）
    const texts = [
      '存在主义是一种人道主义',
      'Kafka wrote about the metamorphosis',
      '重读这一页让我想到２０２４年的夏天',
      '自由的重量，不能承受的生命之轻',
      '标点——与 emoji🌙 的混合，文本！',
      '存在先于本质，选择造就自己'
    ];
    const annotationIds: string[] = [];
    for (const [index, text] of texts.entries()) {
      const bookId = index % 2 === 0 ? book1 : book2;
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/books/${bookId}/annotations`,
        headers: { cookie },
        payload: { startPage: index + 1, endPage: index + 2, content: text }
      });
      expect(created.statusCode).toBe(201);
      annotationIds.push(created.json().annotation.id as string);
    }
    for (const [index, reason] of ['精彩', null, '值得重读', ''].entries()) {
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/books/${book1}/dog-ears`,
        headers: { cookie },
        payload: { pageNumber: 10 + index, reason: reason === '' ? null : reason }
      });
      expect(created.statusCode).toBe(201);
    }
    // 更新一条、删除一条、恢复一条
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/annotations/${annotationIds[0]}`,
      headers: { cookie },
      payload: { content: '改写后的批注：荒诞与反抗' }
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${annotationIds[1]}`,
      headers: { cookie },
      payload: {}
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${annotationIds[2]}`,
      headers: { cookie },
      payload: {}
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/annotations/${annotationIds[2]}/restore`,
      headers: { cookie }
    });

    // 1) 增量索引 == 源表真值
    const incremental = await dumpVisibleIndex();
    const expected1 = await expectedFromSource();
    expect(incremental.docs).toEqual(expected1.docs);
    expect(incremental.postings).toEqual(expected1.postings);

    // 2) 全量重建 == 增量索引
    await rebuildAndWait();
    const rebuilt = await dumpVisibleIndex();
    expect(rebuilt.docs).toEqual(incremental.docs);
    expect(rebuilt.postings).toEqual(incremental.postings);

    // 3) 重建后继续写入，再重建，三者仍然一致
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/annotations/${annotationIds[3]}`,
      headers: { cookie },
      payload: { content: '重建之后的再次改写，夜航西飞' }
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${annotationIds[4]}`,
      headers: { cookie },
      payload: {}
    });
    const incremental2 = await dumpVisibleIndex();
    const expected2 = await expectedFromSource();
    expect(incremental2.docs).toEqual(expected2.docs);
    expect(incremental2.postings).toEqual(expected2.postings);

    await rebuildAndWait();
    const rebuilt2 = await dumpVisibleIndex();
    expect(rebuilt2.docs).toEqual(expected2.docs);
    expect(rebuilt2.postings).toEqual(expected2.postings);
  }, 120_000);

  it('keeps writes non-blocking during rebuild and captures every one of them', async () => {
    const cookie = await directUser('e@example.com');
    const bookId = await createBook(cookie, '重建压力测试');

    // 直接用 Prisma 批量铺底（绕过 API，模拟部署前已存在的历史数据）
    const user = await prisma.user.findFirstOrThrow({ where: { email: 'e@example.com' } });
    const now = new Date();
    await prisma.annotation.createMany({
      data: Array.from({ length: 1500 }, (_, index) => ({
        userId: user.id,
        bookId,
        startPage: (index % 400) + 1,
        endPage: (index % 400) + 2,
        content: `历史批注 ${index} 共同的词语 存在与时间的片段`,
        createdAt: now,
        updatedAt: now
      }))
    });
    await prisma.rereadMark.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        userId: user.id,
        bookId,
        pageNumber: index + 1,
        reason: index % 3 === 0 ? `第 ${index} 页值得重读` : null,
        createdAt: now,
        updatedAt: now
      }))
    });

    // 启动重建，确认进行中后并发写入
    const rebuildStart = await requestRebuild(prisma as never);
    expect(rebuildStart.started).toBe(true);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = await getIndexStatus(prisma as never);
      if (status.building) break;
      if (Date.now() > deadline) throw new Error('rebuild did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const writeResults = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/books/${bookId}/annotations`,
          headers: { cookie },
          payload: { startPage: 450 + index, endPage: 451 + index, content: `重建期间写入的批注 ${index} 独特的标记词` }
        })
      )
    );
    // 重建期间所有写入都成功（不阻塞、不报错）
    for (const response of writeResults) {
      expect(response.statusCode).toBe(201);
    }
    const concurrentIds = writeResults.map((response) => response.json().annotation.id as string);

    // 删除其中一条，验证重建期间的删除同样生效
    const deletedDuringRebuild = await app.inject({
      method: 'DELETE',
      url: `/api/v1/annotations/${concurrentIds[0]}`,
      headers: { cookie },
      payload: {}
    });
    expect(deletedDuringRebuild.statusCode).toBe(204);

    // 等重建结束
    const waitDeadline = Date.now() + 120_000;
    for (;;) {
      const status = await getIndexStatus(prisma as never);
      if (status.lastRebuildFailedAt) throw new Error('rebuild failed');
      if (!status.building && status.active?.builtAt) break;
      if (Date.now() > waitDeadline) throw new Error('rebuild timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // 重建期间写入的每一条都能在新代际中检索到
    const found = await search(cookie, { q: '独特的标记词', pageSize: '50' });
    const foundIds = new Set(found.json().items.map((item: { entityId: string }) => item.entityId));
    for (const id of concurrentIds.slice(1)) {
      expect(foundIds.has(id)).toBe(true);
    }
    expect(foundIds.has(concurrentIds[0]!)).toBe(false);

    // 铺底数据也全部进入索引
    const history = await search(cookie, { q: '共同的词语', pageSize: '1' });
    expect(history.json().pagination.total).toBe(1500);

    // 最终一致性：新 ACTIVE 代际 == 源表真值
    const finalDump = await dumpVisibleIndex();
    const expected = await expectedFromSource();
    expect(finalDump.docs).toEqual(expected.docs);
    expect(finalDump.postings).toEqual(expected.postings);
  }, 180_000);

  it('removes traces from the index when a book is deleted', async () => {
    const cookie = await directUser('f@example.com');
    const bookId = await createBook(cookie, '将被删除的书');
    await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookId}/annotations`,
      headers: { cookie },
      payload: { startPage: 1, endPage: 3, content: '删书级联的批注内容' }
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookId}/dog-ears`,
      headers: { cookie },
      payload: { pageNumber: 5, reason: '删书级联的折角' }
    });
    expect((await search(cookie, { q: '删书级联' })).json().items.length).toBe(2);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/books/${bookId}`,
      headers: { cookie },
      payload: {}
    });
    expect(deleted.statusCode).toBe(204);
    expect((await search(cookie, { q: '删书级联' })).json().items).toHaveLength(0);

    const dump = await dumpVisibleIndex();
    expect(dump.docs.filter((doc) => doc.content.includes('删书级联'))).toHaveLength(0);
  }, 60_000);

  it('purges the index when an account is deleted', async () => {
    const cookie = await directUser('gone@example.com');
    const bookId = await createBook(cookie, '注销用户的书');
    await app.inject({
      method: 'POST',
      url: `/api/v1/books/${bookId}/annotations`,
      headers: { cookie },
      payload: { startPage: 1, endPage: 1, content: '注销后不应再被检索到' }
    });
    expect((await search(cookie, { q: '注销后' })).json().items).toHaveLength(1);

    const user = await prisma.user.findFirstOrThrow({ where: { email: 'gone@example.com' } });
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      headers: { cookie },
      payload: { password: 'password-123456' }
    });
    expect(deleted.statusCode).toBe(204);

    const remaining = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM search_documents WHERE user_id = ${user.id}::uuid`;
    expect(Number(remaining[0]!.count)).toBe(0);
  }, 60_000);

  it('exposes rebuild lifecycle over HTTP and guards against duplicates', async () => {
    const cookie = await directUser('g@example.com');
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/search/rebuild',
      headers: { cookie }
    });
    // 上一次重建可能刚结束；允许 202 或 409，但状态接口必须自洽
    expect([202, 409]).toContain(started.statusCode);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const statusResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/search/status',
        headers: { cookie }
      });
      expect(statusResponse.statusCode).toBe(200);
      const status = statusResponse.json();
      expect(status.active).not.toBeNull();
      if (!status.building) {
        expect(status.lastRebuildAt).not.toBeNull();
        break;
      }
      if (Date.now() > deadline) throw new Error('rebuild timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 150_000);
});
