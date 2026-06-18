"use client";

/**
 * Reusable single-list drag-to-reorder built on @dnd-kit. Touch-friendly: the
 * drag is armed by a small movement on a dedicated handle (so taps / text-select
 * / scrolling elsewhere in a row still work on mobile). `onReorder` gets the new
 * id order after a drop; persist it however you like.
 */
import { ReactNode, useEffect, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type DragHandle = {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  isDragging: boolean;
  // Spread onto the element that should grab the drag (the ≡ handle).
  handleProps: Record<string, any>;
};

function Item({
  id,
  children,
}: {
  id: string;
  children: (h: DragHandle) => ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
    zIndex: isDragging ? 30 : undefined,
    position: "relative",
  };
  return (
    <>
      {children({
        setNodeRef,
        style,
        isDragging,
        handleProps: { ...attributes, ...listeners, style: { touchAction: "none", cursor: "grab" } },
      })}
    </>
  );
}

export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  renderItem,
  className,
  grid = false,
}: {
  items: T[];
  onReorder: (ids: string[]) => void;
  renderItem: (item: T, handle: DragHandle) => ReactNode;
  className?: string;
  grid?: boolean;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // Optimistic local order so the row doesn't snap back to the prop order while
  // the reorder request + refetch are in flight. Re-synced whenever props change.
  const byId = new Map(items.map((i) => [i.id, i]));
  const [order, setOrder] = useState<string[]>(items.map((i) => i.id));
  useEffect(() => {
    setOrder(items.map((i) => i.id));
  }, [items.map((i) => i.id).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(order, from, to);
    setOrder(next);
    onReorder(next);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={grid ? rectSortingStrategy : verticalListSortingStrategy}>
        <div className={className}>
          {order.map((id) => {
            const it = byId.get(id);
            return it ? (
              <Item key={id} id={id}>
                {(h) => renderItem(it, h)}
              </Item>
            ) : null;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
