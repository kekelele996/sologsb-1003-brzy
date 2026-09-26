import type { Segment } from './types'

export interface SyncUpdate {
  segmentId: string
  before: string
  after: string
}

export interface SyncMergeResult {
  segments: Segment[]
  addedCount: number
  updated: SyncUpdate[]
  removedIds: string[]
}

type AlignOp =
  | { type: 'keep'; current: Segment; upstream: Segment }
  | { type: 'update'; current: Segment; upstream: Segment }
  | { type: 'add'; upstream: Segment }
  | { type: 'remove'; current: Segment }

/**
 * 按原文内容对齐当前片段与上游片段：先求 sourceText 的最长公共子序列，
 * 未匹配的缺口内按顺序两两配对视为“原文变更”，配不上的记为新增或移除。
 */
const alignSegments = (current: Segment[], upstream: Segment[]): AlignOp[] => {
  const n = current.length
  const m = upstream.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = current[i].sourceText === upstream[j].sourceText
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: AlignOp[] = []
  let pendingRemoved: Segment[] = []
  let pendingAdded: Segment[] = []
  const flushPending = () => {
    const pairCount = Math.min(pendingRemoved.length, pendingAdded.length)
    for (let k = 0; k < pairCount; k += 1) ops.push({ type: 'update', current: pendingRemoved[k], upstream: pendingAdded[k] })
    for (let k = pairCount; k < pendingRemoved.length; k += 1) ops.push({ type: 'remove', current: pendingRemoved[k] })
    for (let k = pairCount; k < pendingAdded.length; k += 1) ops.push({ type: 'add', upstream: pendingAdded[k] })
    pendingRemoved = []
    pendingAdded = []
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (current[i].sourceText === upstream[j].sourceText) {
      flushPending()
      ops.push({ type: 'keep', current: current[i], upstream: upstream[j] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pendingRemoved.push(current[i])
      i += 1
    } else {
      pendingAdded.push(upstream[j])
      j += 1
    }
  }
  while (i < n) { pendingRemoved.push(current[i]); i += 1 }
  while (j < m) { pendingAdded.push(upstream[j]); j += 1 }
  flushPending()
  return ops
}

/**
 * 将上游新版源文合并进工作区：
 * - 原文未变：保留译文、确认状态与讨论（片段 id 不变）。
 * - 原文变更：保留片段 id（讨论得以保留），清空译文并转为待处理，调用方负责写历史。
 * - 上游新增：以空译文进入草稿。
 * - 上游移除：从工作区移出，调用方负责清理其讨论等关联数据。
 */
export const mergeUpstreamSegments = (current: Segment[], upstream: Segment[]): SyncMergeResult => {
  const ops = alignSegments(current, upstream)
  const segments: Segment[] = []
  const updated: SyncUpdate[] = []
  const removedIds: string[] = []
  let addedCount = 0
  const stamp = Date.now()
  for (const op of ops) {
    if (op.type === 'keep') {
      segments.push({ ...op.current, kind: op.upstream.kind, protectedTokens: op.upstream.protectedTokens })
    } else if (op.type === 'update') {
      updated.push({ segmentId: op.current.id, before: op.current.sourceText, after: op.upstream.sourceText })
      segments.push({ ...op.current, sourceText: op.upstream.sourceText, kind: op.upstream.kind, protectedTokens: op.upstream.protectedTokens, targetText: '', status: 'needs-work' })
    } else if (op.type === 'add') {
      addedCount += 1
      segments.push({ ...op.upstream, id: `segment-sync-${stamp}-${addedCount}`, targetText: '', status: 'draft', note: '' })
    } else {
      removedIds.push(op.current.id)
    }
  }
  segments.forEach((segment, index) => { segment.index = index + 1 })
  return { segments, addedCount, updated, removedIds }
}
