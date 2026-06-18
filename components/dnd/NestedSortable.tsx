"use client";

/**
 * Two-level drag-and-drop in ONE DndContext (the standard dnd-kit "multiple
 * containers" pattern):
 *   • Containers (parents) can be reordered among themselves.
 *   • Items (children) can be reordered within a container AND dragged into
 *     another container — Google-Tasks style.
 *
 * Container ids and item ids must all be globally unique and disjoint. Item ids
 * just need to be stable for the duration of a drag; the caller maps them back
 * to data on commit.
 *
 * `onReorderContainers(ids)` fires when a container is dropped in a new spot.
 * `onMoveItems(map)` fires when an item is dropped, with the full new
 * container -> ordered item-ids arrangement (diff + persist on your side).
 */
import { ReactNode, useEffect, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  useDroppable,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DragHandle } from "./SortableList";

export type Container = { id: string; itemIds: string[] };

function handleFrom(s: ReturnType<typeof useSortable>): DragHandle {
  return {
    setNodeRef: s.setNodeRef,
    style: {
      transform: CSS.Transform.toString(s.transform),
      transition: s.transition,
      opacity: s.isDragging ? 0.45 : 1,
      zIndex: s.isDragging ? 30 : undefined,
      position: "relative",
    },
    isDragging: s.isDragging,
    handleProps: { ...s.attributes, ...s.listeners, style: { touchAction: "none", cursor: "grab" } },
  };
}

function SortableContainer({ id, children }: { id: string; children: (h: DragHandle) => ReactNode }) {
  const s = useSortable({ id, data: { type: "container" } });
  return <>{children(handleFrom(s))}</>;
}

function SortableItem({ id, children }: { id: string; children: (h: DragHandle) => ReactNode }) {
  const s = useSortable({ id, data: { type: "item" } });
  return <>{children(handleFrom(s))}</>;
}

function Zone({ id, itemIds, className, children }: { id: string; itemIds: string[]; className?: string; children: ReactNode }) {
  // Extra droppable so an empty list (or the gap below the last item) still
  // accepts a drop into this container.
  const { setNodeRef } = useDroppable({ id: `zone:${id}`, data: { type: "zone", container: id } });
  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className={className} data-zone={id}>
        {children}
      </div>
    </SortableContext>
  );
}

export function NestedSortable({
  containers,
  onReorderContainers,
  onMoveItems,
  renderContainer,
  renderItem,
  containerClassName,
  zoneClassName,
  containerGrid = false,
}: {
  containers: Container[];
  onReorderContainers: (ids: string[]) => void;
  onMoveItems: (map: Record<string, string[]>) => void;
  // Render a container's chrome; drop the (drag-wired) item list `body` inside it.
  renderContainer: (containerId: string, handle: DragHandle, body: ReactNode) => ReactNode;
  renderItem: (itemId: string, containerId: string, handle: DragHandle) => ReactNode;
  containerClassName?: string;
  zoneClassName?: string;
  containerGrid?: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Optimistic working copy, synced from props (so cross-list moves preview live).
  const [order, setOrder] = useState<string[]>([]);
  const [items, setItems] = useState<Record<string, string[]>>({});
  const propsKey = JSON.stringify(containers.map((c) => [c.id, c.itemIds]));
  useEffect(() => {
    setOrder(containers.map((c) => c.id));
    const m: Record<string, string[]> = {};
    for (const c of containers) m[c.id] = c.itemIds;
    setItems(m);
  }, [propsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const isContainer = (id: string) => id in items;
  const containerOf = (id: string): string | null => {
    if (id.startsWith("zone:")) return id.slice(5);
    if (id in items) return id;
    return order.find((k) => (items[k] ?? []).includes(id)) ?? null;
  };

  function onDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (isContainer(activeId)) return; // container drag — not an item move
    const from = containerOf(activeId);
    const to = containerOf(overId);
    if (!from || !to || from === to) return;
    setItems((prev) => {
      const fromIds = (prev[from] ?? []).filter((x) => x !== activeId);
      const toIds = (prev[to] ?? []).slice();
      const overIdx = overId.startsWith("zone:") || overId in prev ? toIds.length : toIds.indexOf(overId);
      toIds.splice(overIdx < 0 ? toIds.length : overIdx, 0, activeId);
      return { ...prev, [from]: fromIds, [to]: toIds };
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    const activeId = String(active.id);
    if (!over) {
      onMoveItems(items);
      return;
    }
    const overId = String(over.id);

    if (isContainer(activeId)) {
      const overContainer = isContainer(overId) ? overId : containerOf(overId);
      if (overContainer && overContainer !== activeId) {
        const next = arrayMove(order, order.indexOf(activeId), order.indexOf(overContainer));
        setOrder(next);
        onReorderContainers(next);
      }
      return;
    }

    // item drag: finalize order within the destination container
    const from = containerOf(activeId);
    const to = containerOf(overId);
    let next = items;
    if (from && to && from === to && !overId.startsWith("zone:") && !(overId in items) && activeId !== overId) {
      const ids = items[from] ?? [];
      next = { ...items, [from]: arrayMove(ids, ids.indexOf(activeId), ids.indexOf(overId)) };
      setItems(next);
    }
    onMoveItems(next);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(_e: DragStartEvent) => {}}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={order} strategy={containerGrid ? rectSortingStrategy : verticalListSortingStrategy}>
        <div className={containerClassName}>
          {order.map((cid) => {
            const ids = items[cid] ?? [];
            const body = (
              <Zone id={cid} itemIds={ids} className={zoneClassName}>
                {ids.map((itemId) => (
                  <SortableItem key={itemId} id={itemId}>
                    {(h) => renderItem(itemId, cid, h)}
                  </SortableItem>
                ))}
              </Zone>
            );
            return (
              <SortableContainer key={cid} id={cid}>
                {(h) => renderContainer(cid, h, body)}
              </SortableContainer>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
