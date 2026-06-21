"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { CommitState, PhysicalObject } from "@/types/topo";
import {
  classifyObjectDiff,
  findMissingObjects,
} from "@/utils/metrics";

const DIFF_COLORS = {
  new: "#22c55e",
  moved: "#eab308",
  unchanged: "#9ca3af",
  missing: "#ef4444",
} as const;

function ObjectMesh({
  obj,
  diffType,
  faded,
}: {
  obj: PhysicalObject;
  diffType: keyof typeof DIFF_COLORS;
  faded?: boolean;
}) {
  const x = obj.x - 5;
  const y = obj.z * 0.3;
  const z = obj.y - 5;

  return (
    <mesh position={[x, y, z]}>
      <boxGeometry args={[0.6, 0.6, 0.6]} />
      <meshStandardMaterial
        color={DIFF_COLORS[diffType]}
        transparent={faded}
        opacity={faded ? 0.4 : 1}
        wireframe={faded}
      />
    </mesh>
  );
}

function Scene({
  current,
  previous,
}: {
  current: CommitState;
  previous: CommitState | null;
}) {
  const missing = findMissingObjects(current, previous);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[5, 8, 5]} intensity={1} />
      <gridHelper args={[12, 12, "#333", "#222"]} />

      {current.objects.map((obj) => (
        <ObjectMesh
          key={obj.id}
          obj={obj}
          diffType={classifyObjectDiff(obj, previous)}
        />
      ))}

      {missing.map((obj) => (
        <ObjectMesh key={`missing-${obj.id}`} obj={obj} diffType="missing" faded />
      ))}

      <OrbitControls makeDefault enableDamping />
    </>
  );
}

/** Stable 2D grid — shown before any commits (no WebGL). */
export function SpatialPlaceholder() {
  return (
    <div
      className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/20"
      style={{ height: 360 }}
    >
      <div
        className="grid size-48 gap-px rounded-lg border border-border/50 p-1"
        style={{
          gridTemplateColumns: "repeat(10, 1fr)",
          gridTemplateRows: "repeat(10, 1fr)",
        }}
      >
        {Array.from({ length: 100 }).map((_, i) => (
          <div key={i} className="rounded-sm bg-primary/8" />
        ))}
      </div>
      <p className="mt-5 max-w-xs text-center text-sm text-muted-foreground">
        Empty workspace. Change your scene, then commit a snapshot.
      </p>
    </div>
  );
}

export default function DiffViewer({
  current,
  previous,
}: {
  current: CommitState;
  previous: CommitState | null;
}) {
  return (
    <div
      className="min-w-0 w-full max-w-full overflow-hidden rounded-xl ring-1 ring-border/60 bg-background/40"
      style={{ height: 360 }}
    >
      <div className="relative min-w-0 overflow-hidden" style={{ height: 320 }}>
        <Canvas
          camera={{ position: [8, 8, 8], fov: 50 }}
          gl={{ antialias: true }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          resize={{ scroll: false, debounce: { scroll: 50, resize: 0 } }}
        >
          <Scene current={current} previous={previous} />
        </Canvas>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
        {current.objects.map((obj) => (
          <span key={obj.id} className="topo-terminal rounded bg-muted/50 px-1.5 py-0.5">
            {obj.label}
          </span>
        ))}
      </div>
    </div>
  );
}
