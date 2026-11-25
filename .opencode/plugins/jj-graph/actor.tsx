// Solid bindings for the XState actors the views run (source.machine.ts,
// view.machine.ts). @xstate/solid's v6 line targets Solid 2, and OpenCode
// shares Solid 1.9 with its plugins, so this is the few lines it would be.
// It is a .tsx file although it holds no JSX: OpenCode hands its shared Solid
// only to .tsx modules, and a .ts one fails with "Cannot find package 'solid-js'".
import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { AnyActorRef, SnapshotFrom } from "xstate"

/** An accessor for an actor's snapshot, live until `dispose`. */
export function snapshotOf<T extends AnyActorRef>(actor: T): { snapshot: Accessor<SnapshotFrom<T>>; dispose(): void } {
  // Snapshots are new objects on every change; compare by identity.
  const [snapshot, setSnapshot] = createSignal<SnapshotFrom<T>>(actor.getSnapshot(), { equals: false })
  const subscription = actor.subscribe((next: SnapshotFrom<T>) => setSnapshot(() => next))
  return { snapshot, dispose: () => subscription.unsubscribe() }
}

/** An actor's snapshot inside a component: unsubscribed when the component goes away. */
export function useSnapshot<T extends AnyActorRef>(actor: T): Accessor<SnapshotFrom<T>> {
  const { snapshot, dispose } = snapshotOf(actor)
  onCleanup(dispose)
  return snapshot
}
