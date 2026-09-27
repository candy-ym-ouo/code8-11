import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../lib/prisma.js';
import {
  annotationSnapshot,
  dogEarSnapshot,
  rereadMarkSnapshot,
  upsertDocumentPlans
} from './indexer.js';
import { buildTraceDocument, type DocumentPlan, type TraceSnapshot } from './document.js';

/**
 * 全量重建：在 BUILDING 代际上离线重建整个倒排索引，完成后原子切换。
 *
 * 不阻塞现有写入的保证：
 * - 源表扫描使用键集分页的短只读事务，不持有任何长事务或表锁；
 * - 重建期间业务写入照常提交，并通过双写同时落到 ACTIVE 与 BUILDING 代际；
 * - 扫描与双写之间的乱序由文档行的 source_version 守卫与墓碑行裁决；
 * - 代际切换是一条短事务内的两次 UPDATE；旧代际数据在切换后分批清理。
 */

const SCAN_BATCH = 300;
const CLEANUP_BATCH = 5000;

let running = false;

export interface RebuildRequestResult {
  started: boolean;
  generationId?: number;
}

type Client = PrismaClient | Prisma.TransactionClient;

async function purgeFailedGenerations(client: Client): Promise<void> {
  for (;;) {
    const removed = await client.$executeRaw`
      DELETE FROM search_documents WHERE id IN (
        SELECT d.id FROM search_documents d
        JOIN search_generations g ON g.id = d.generation_id
        WHERE g.status = 'FAILED'
        LIMIT ${CLEANUP_BATCH}
      )`;
    if (removed === 0) break;
  }
  await client.$executeRaw`DELETE FROM search_generations WHERE status = 'FAILED'`;
}

/** 请求一次全量重建。已在进行时不重复启动（进程内守卫 + 数据库部分唯一索引双保险）。 */
export async function requestRebuild(client: PrismaClient = defaultPrisma): Promise<RebuildRequestResult> {
  if (running) return { started: false };
  running = true;
  try {
    await purgeFailedGenerations(client);
    let generationId: number;
    try {
      const generation = await client.searchGeneration.create({ data: { status: 'BUILDING' } });
      generationId = generation.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { started: false };
      }
      throw error;
    }
    void executeRebuild(client, generationId)
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
    return { started: true, generationId };
  } catch (error) {
    running = false;
    throw error;
  }
}

async function scanBatch(
  client: PrismaClient,
  generationId: number,
  plans: DocumentPlan[]
): Promise<number> {
  if (plans.length === 0) return 0;
  await client.$transaction(async (tx) => {
    await upsertDocumentPlans(tx, generationId, plans);
  });
  return plans.length;
}

const UUID_FLOOR = '00000000-0000-0000-0000-000000000000';

async function executeRebuild(client: PrismaClient, generationId: number): Promise<void> {
  try {
    // 键集分页扫描三类痕迹；只索引未删除且属主账号有效的数据。
    const sources: Array<{
      fetch: (lastId: string) => Promise<TraceSnapshot[]>;
    }> = [
      {
        fetch: async (lastId) =>
          (
            await client.dogEar.findMany({
              where: { deletedAt: null, id: { gt: lastId }, user: { status: 'ACTIVE', deletedAt: null } },
              orderBy: { id: 'asc' },
              take: SCAN_BATCH
            })
          ).map(dogEarSnapshot)
      },
      {
        fetch: async (lastId) =>
          (
            await client.annotation.findMany({
              where: { deletedAt: null, id: { gt: lastId }, user: { status: 'ACTIVE', deletedAt: null } },
              orderBy: { id: 'asc' },
              take: SCAN_BATCH
            })
          ).map(annotationSnapshot)
      },
      {
        fetch: async (lastId) =>
          (
            await client.rereadMark.findMany({
              where: { deletedAt: null, id: { gt: lastId }, user: { status: 'ACTIVE', deletedAt: null } },
              orderBy: { id: 'asc' },
              take: SCAN_BATCH
            })
          ).map(rereadMarkSnapshot)
      }
    ];

    for (const source of sources) {
      let lastId = UUID_FLOOR;
      for (;;) {
        const snapshots = await source.fetch(lastId);
        if (snapshots.length === 0) break;
        const plans = snapshots
          .map((snapshot) => buildTraceDocument(snapshot))
          .filter((plan): plan is DocumentPlan => plan !== null);
        await scanBatch(client, generationId, plans);
        lastId = snapshots[snapshots.length - 1]!.entityId;
      }
    }

    // 原子切换代际：旧 ACTIVE 退役，BUILDING 转正。
    await client.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE search_generations SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`;
      const activated = await tx.$executeRaw`
        UPDATE search_generations SET status = 'ACTIVE', activated_at = now()
        WHERE id = ${generationId} AND status = 'BUILDING'`;
      if (activated !== 1) {
        throw new Error(`search generation ${generationId} failed to activate`);
      }
    });

    // 切换后清理：新 ACTIVE 代际中的墓碑已失去裁决意义；旧代际分批删除。
    await client.$executeRaw`
      DELETE FROM search_documents WHERE generation_id = ${generationId} AND deleted_at IS NOT NULL`;
    for (;;) {
      const removed = await client.$executeRaw`
        DELETE FROM search_documents WHERE id IN (
          SELECT d.id FROM search_documents d
          JOIN search_generations g ON g.id = d.generation_id
          WHERE g.status = 'RETIRED'
          LIMIT ${CLEANUP_BATCH}
        )`;
      if (removed === 0) break;
    }
    await client.$executeRaw`DELETE FROM search_generations WHERE status = 'RETIRED'`;
  } catch (error) {
    await client.$executeRaw`
      UPDATE search_generations SET status = 'FAILED', retired_at = now()
      WHERE id = ${generationId} AND status = 'BUILDING'`.catch(() => undefined);
    throw error;
  }
}

export interface IndexStatus {
  active: { id: number; documentCount: number; builtAt: Date | null } | null;
  building: { id: number; startedAt: Date } | null;
  lastRebuildAt: Date | null;
  lastRebuildFailedAt: Date | null;
}

export async function getIndexStatus(client: PrismaClient = defaultPrisma): Promise<IndexStatus> {
  const generations = await client.searchGeneration.findMany({ orderBy: { id: 'desc' } });
  const active = generations.find((generation) => generation.status === 'ACTIVE') ?? null;
  const building = generations.find((generation) => generation.status === 'BUILDING') ?? null;
  const lastRebuild = generations.find((generation) => generation.activatedAt !== null) ?? null;
  const lastFailed = generations.find((generation) => generation.status === 'FAILED') ?? null;

  let documentCount = 0;
  if (active) {
    const rows = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM search_documents
      WHERE generation_id = ${active.id} AND deleted_at IS NULL`;
    documentCount = Number(rows[0]?.count ?? 0);
  }

  return {
    active: active ? { id: active.id, documentCount, builtAt: active.activatedAt } : null,
    building: building ? { id: building.id, startedAt: building.createdAt } : null,
    lastRebuildAt: lastRebuild?.activatedAt ?? null,
    lastRebuildFailedAt: lastFailed?.retiredAt ?? null
  };
}

/**
 * 启动引导：保证存在 ACTIVE 代际；若当前代际从未完整构建过
 * （例如全新部署后索引为空而业务数据已存在），后台触发一次重建。
 */
export async function ensureSearchIndex(client: PrismaClient = defaultPrisma): Promise<void> {
  const active = await client.searchGeneration.findFirst({ where: { status: 'ACTIVE' } });
  if (!active) {
    try {
      await client.searchGeneration.create({ data: { status: 'ACTIVE' } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
  }
  const current = await client.searchGeneration.findFirst({ where: { status: 'ACTIVE' } });
  const building = await client.searchGeneration.findFirst({ where: { status: 'BUILDING' } });
  if (current && !current.activatedAt && !building) {
    await requestRebuild(client);
  }
}
