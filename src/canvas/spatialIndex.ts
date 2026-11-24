import RBush, { type BBox } from "rbush";
import type { NodeDto } from "../ipc/types";

export const COLLAPSED_NODE_HEIGHT = 44;

export interface SpatialItem extends BBox {
  id: string;
}

export function getEffectiveNodeHeight(node: NodeDto): number {
  return node.layout.collapsed ? COLLAPSED_NODE_HEIGHT : node.layout.height;
}

function toSpatialItem(node: NodeDto): SpatialItem {
  const height = getEffectiveNodeHeight(node);
  return {
    minX: node.layout.x,
    minY: node.layout.y,
    maxX: node.layout.x + node.layout.width,
    maxY: node.layout.y + height,
    id: node.id,
  };
}

export class ViewportSpatialIndex {
  private readonly tree = new RBush<SpatialItem>();
  private readonly itemsById = new Map<string, SpatialItem>();

  bulkLoad(nodes: Iterable<NodeDto>): void {
    this.tree.clear();
    this.itemsById.clear();
    const items: SpatialItem[] = [];
    for (const node of nodes) {
      const item = toSpatialItem(node);
      this.itemsById.set(node.id, item);
      items.push(item);
    }
    if (items.length > 0) {
      this.tree.load(items);
    }
  }

  upsert(node: NodeDto): void {
    const existing = this.itemsById.get(node.id);
    if (existing) {
      this.tree.remove(existing, (a, b) => a.id === b.id);
    }
    const next = toSpatialItem(node);
    this.itemsById.set(node.id, next);
    this.tree.insert(next);
  }

  remove(id: string): void {
    const existing = this.itemsById.get(id);
    if (existing) {
      this.tree.remove(existing, (a, b) => a.id === b.id);
      this.itemsById.delete(id);
    }
  }

  queryViewport(bounds: BBox, margin = 200): string[] {
    const expanded: BBox = {
      minX: bounds.minX - margin,
      minY: bounds.minY - margin,
      maxX: bounds.maxX + margin,
      maxY: bounds.maxY + margin,
    };
    return this.tree.search(expanded).map((item) => item.id);
  }

  queryRect(rect: BBox): string[] {
    return this.tree.search(rect).map((item) => item.id);
  }

  clear(): void {
    this.tree.clear();
    this.itemsById.clear();
  }
}
