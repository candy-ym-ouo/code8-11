import { Prisma, type Annotation, type DogEar, type RereadMark, type SearchEntityType } from '@prisma/client';
import { buildTraceDocument, type DocumentPlan, type TraceSnapshot } from './document.js';

/**
 * 增量索引写入层。
 *
 * 所有函数都接收调用方的事务客户端（tx），与业务写入在同一事务提交，
 * 保证「业务表」与「检索索引」要么同时可见、要么同时回滚。
 *
 * 一致性关键设计：
 * - 每个文档行携带 source_version（业务实体 version），upsert/墓碑都带
 *   `source_version <= 新值` 的守卫，乱序到达的旧版本写入永远落败；
 * - 删除采用墓碑（deleted_at 软删 + 清空内容），而不是直接删行，
 *   用于抵挡全量重建扫描与增量双写之间的竞态；
 * - 写入目标为当前 ACTIVE 与 BUILDING（若存在）两个代际（双写），
 *   使重建期间的新写入不会丢失。
 */

type Tx = Prisma.TransactionClient;

export interface WritableGenerations {
  activeId: number | null;
  buildingId: number | null;
}

export async function getWritableGenerations(tx: Tx): Promise<WritableGenerations> {
  const rows = await tx.$queryRaw<Array<{ id: number; status: string }>>`
    SELECT id, status::text AS status
    FROM search_generations
    WHERE status IN ('ACTIVE', 'BUILDING')`;
  let activeId: number | null = null;
  let buildingId: number | null = null;
  for (const row of rows) {
    if (row.status === 'ACTIVE') activeId = row.id;
    if (row.status === 'BUILDING') buildingId = row.id;
  }
  return { activeId, buildingId };
}

function writableIds(generations: WritableGenerations): number[] {
  return [generations.activeId, generations.buildingId].filter((id): id is number => id !== null);
}

const POSTING_INSERT_CHUNK = 5000;

/**
 * 批量 upsert 文档计划（增量路径传入 1 条，重建路径传入一批）。
 * 版本守卫：只有新版本的 source_version >= 行内版本时才覆盖；
 * 落败的行（含墓碑）保持原样，其 postings 也不被触碰。
 */
export async function upsertDocumentPlans(tx: Tx, generationId: number, plans: DocumentPlan[]): Promise<void> {
  if (plans.length === 0) return;
  const valueRows = plans.map(
    (plan) => Prisma.sql`(
      ${plan.userId}::uuid,
      ${plan.bookId}::uuid,
      ${plan.entityType}::"SearchEntityType",
      ${plan.entityId}::uuid,
      ${plan.sourceVersion},
      ${plan.pageStart},
      ${plan.pageEnd},
      ${plan.content},
      ${plan.termCount},
      ${plan.sourceCreatedAt}
    )`
  );
  const upserted = await tx.$queryRaw<Array<{ id: string; entity_id: string }>>(Prisma.sql`
    INSERT INTO search_documents (
      id, generation_id, user_id, book_id, entity_type, entity_id,
      source_version, page_start, page_end, content, term_count,
      source_created_at, deleted_at, updated_at
    )
    SELECT
      gen_random_uuid(), ${generationId}, v.user_id, v.book_id, v.entity_type, v.entity_id,
      v.source_version, v.page_start, v.page_end, v.content, v.term_count,
      v.source_created_at, NULL, now()
    FROM (VALUES ${Prisma.join(valueRows)}) AS v(
      user_id, book_id, entity_type, entity_id,
      source_version, page_start, page_end, content, term_count, source_created_at
    )
    ON CONFLICT (generation_id, entity_type, entity_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      book_id = EXCLUDED.book_id,
      source_version = EXCLUDED.source_version,
      page_start = EXCLUDED.page_start,
      page_end = EXCLUDED.page_end,
      content = EXCLUDED.content,
      term_count = EXCLUDED.term_count,
      source_created_at = EXCLUDED.source_created_at,
      deleted_at = NULL,
      updated_at = now()
    WHERE search_documents.source_version <= EXCLUDED.source_version
    RETURNING id, entity_id`);

  if (upserted.length === 0) return;

  const upsertedIds = upserted.map((row) => row.id);
  await tx.$executeRaw`
    DELETE FROM search_postings
    WHERE document_id = ANY(${upsertedIds}::uuid[])`;

  const planByEntity = new Map(plans.map((plan) => [plan.entityId.toLowerCase(), plan]));
  const postingRows: Prisma.Sql[] = [];
  for (const row of upserted) {
    const plan = planByEntity.get(row.entity_id.toLowerCase());
    if (!plan) continue;
    for (const posting of plan.postings) {
      postingRows.push(Prisma.sql`(${row.id}::uuid, ${generationId}, ${posting.term}, ${posting.tf})`);
    }
  }
  for (let offset = 0; offset < postingRows.length; offset += POSTING_INSERT_CHUNK) {
    const chunk = postingRows.slice(offset, offset + POSTING_INSERT_CHUNK);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO search_postings (document_id, generation_id, term, tf)
      VALUES ${Prisma.join(chunk)}`);
  }
}

export interface TombstoneKey {
  entityType: SearchEntityType;
  entityId: string;
  sourceVersion: number;
}

/**
 * 批量写入墓碑：标记删除、清空内容与词项，但保留行与版本号，
 * 使全量重建中乱序到达的旧版本 upsert 无法将其复活。
 */
export async function tombstoneDocuments(tx: Tx, generationId: number, keys: TombstoneKey[]): Promise<void> {
  if (keys.length === 0) return;
  const valueRows = keys.map(
    (key) => Prisma.sql`(${key.entityType}::"SearchEntityType", ${key.entityId}::uuid, ${key.sourceVersion})`
  );
  const tombstoned = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE search_documents AS d
    SET deleted_at = now(),
        source_version = v.source_version,
        content = '',
        term_count = 0,
        page_start = 0,
        page_end = 0,
        updated_at = now()
    FROM (VALUES ${Prisma.join(valueRows)}) AS v(entity_type, entity_id, source_version)
    WHERE d.generation_id = ${generationId}
      AND d.entity_type = v.entity_type
      AND d.entity_id = v.entity_id
      AND d.source_version <= v.source_version
    RETURNING d.id`);

  if (tombstoned.length === 0) return;
  const tombstonedIds = tombstoned.map((row) => row.id);
  await tx.$executeRaw`
    DELETE FROM search_postings
    WHERE document_id = ANY(${tombstonedIds}::uuid[])`;
}

export function dogEarSnapshot(row: DogEar): TraceSnapshot {
  return {
    userId: row.userId,
    bookId: row.bookId,
    entityType: 'DOG_EAR',
    entityId: row.id,
    sourceVersion: row.version,
    pageStart: row.pageNumber,
    pageEnd: row.pageNumber,
    text: row.reason,
    sourceCreatedAt: row.createdAt,
    deleted: row.deletedAt !== null
  };
}

export function annotationSnapshot(row: Annotation): TraceSnapshot {
  return {
    userId: row.userId,
    bookId: row.bookId,
    entityType: 'ANNOTATION',
    entityId: row.id,
    sourceVersion: row.version,
    pageStart: row.startPage,
    pageEnd: row.endPage,
    text: row.content,
    sourceCreatedAt: row.createdAt,
    deleted: row.deletedAt !== null
  };
}

export function rereadMarkSnapshot(row: RereadMark): TraceSnapshot {
  return {
    userId: row.userId,
    bookId: row.bookId,
    entityType: 'REREAD_MARK',
    entityId: row.id,
    sourceVersion: row.version,
    pageStart: row.pageNumber,
    pageEnd: row.pageNumber,
    text: row.reason,
    sourceCreatedAt: row.createdAt,
    deleted: row.deletedAt !== null
  };
}

/** 单条痕迹的增量索引：create / update / restore 后在同一事务内调用。 */
export async function indexTrace(tx: Tx, snapshot: TraceSnapshot): Promise<void> {
  const targets = writableIds(await getWritableGenerations(tx));
  if (targets.length === 0) return;
  const plan = buildTraceDocument(snapshot);
  for (const generationId of targets) {
    if (plan) {
      await upsertDocumentPlans(tx, generationId, [plan]);
    } else {
      // 无文本或已删除的活体实体：索引中不应有文档，写墓碑抵挡重建乱序。
      await tombstoneDocuments(tx, generationId, [
        { entityType: snapshot.entityType, entityId: snapshot.entityId, sourceVersion: snapshot.sourceVersion }
      ]);
    }
  }
}

/** 单条痕迹删除：在同一事务内调用，sourceVersion 为删除后的新版本。 */
export async function removeTrace(
  tx: Tx,
  entityType: SearchEntityType,
  entityId: string,
  sourceVersion: number
): Promise<void> {
  await removeTraces(tx, [{ entityType, entityId, sourceVersion }]);
}

/** 批量痕迹删除（删书级联）：在同一事务内调用。 */
export async function removeTraces(tx: Tx, keys: TombstoneKey[]): Promise<void> {
  if (keys.length === 0) return;
  const targets = writableIds(await getWritableGenerations(tx));
  for (const generationId of targets) {
    await tombstoneDocuments(tx, generationId, keys);
  }
}

/** 账号删除：物理清除该用户在所有代际中的索引数据（隐私边界）。 */
export async function removeUserDocuments(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`DELETE FROM search_documents WHERE user_id = ${userId}::uuid`;
}
