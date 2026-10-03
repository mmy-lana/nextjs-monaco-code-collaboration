'use client';

import { useEffect, useState, useCallback } from 'react';
import { getDB } from '@/db/schema';
import type { VFSNode, WorkspaceMetadata } from '@/types/workspace';

export function useVFS(workspaceId: string) {
  const [workspace, setWorkspace] = useState<WorkspaceMetadata | null>(null);
  const [nodes, setNodes] = useState<VFSNode[]>([]);
  const [loading, setLoading] = useState(true);

  const reconcileWorkspaceTabs = useCallback(
    async (ws: WorkspaceMetadata, currentNodes: VFSNode[]): Promise<WorkspaceMetadata> => {
      const activeNodeIds = new Set(
        currentNodes.filter((node) => !node.deletedAt).map((node) => node.id)
      );

      const reconciledOpenFileIds = ws.openFileIds.filter((id) => activeNodeIds.has(id));
      const reconciledActiveFileId =
        ws.activeFileId && activeNodeIds.has(ws.activeFileId)
          ? ws.activeFileId
          : reconciledOpenFileIds[0] ?? null;

      const hasChanged =
        reconciledOpenFileIds.length !== ws.openFileIds.length ||
        reconciledActiveFileId !== ws.activeFileId;

      if (hasChanged) {
        const updated: WorkspaceMetadata = {
          ...ws,
          openFileIds: reconciledOpenFileIds,
          activeFileId: reconciledActiveFileId,
          updatedAt: Date.now()
        };
        const db = getDB();
        await db.workspaces.put(updated);
        return updated;
      }

      return ws;
    },
    []
  );

  useEffect(() => {
    let mounted = true;

    const loadWorkspace = async () => {
      try {
        const db = getDB();
        const ws = await db.workspaces.get(workspaceId);
        const workspaceNodes = await db.nodes
          .where('workspaceId')
          .equals(workspaceId)
          .toArray();
        const nonDeletedNodes = workspaceNodes.filter((node) => !node.deletedAt);

        if (!mounted) return;

        if (ws) {
          const reconciled = await reconcileWorkspaceTabs(ws, nonDeletedNodes);
          if (mounted) {
            setWorkspace(reconciled);
            setNodes(nonDeletedNodes);
          }
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadWorkspace();

    return () => {
      mounted = false;
    };
  }, [workspaceId, reconcileWorkspaceTabs]);

  return {
    workspace,
    nodes,
    loading
  };
}
