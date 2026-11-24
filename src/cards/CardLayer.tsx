import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import {
  cameraControllerRef,
  graphVersion,
  isBirdsEye,
  nodesMap,
  visibleNodeIds,
} from "../store/graphStore";
import { NodeCard } from "./NodeCard";

export function CardLayer() {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const birdsEye = isBirdsEye.value;
  const visibleIds = visibleNodeIds.value;
  // Subscribe to graphVersion so card mutations re-render visible cards cleanly.
  const version = graphVersion.value;

  useLayoutEffect(() => {
    if (birdsEye) {
      cameraControllerRef.current?.setCardLayerEl(null);
    } else {
      cameraControllerRef.current?.setCardLayerEl(layerRef.current);
    }
  }, [birdsEye, visibleIds.length, version]);

  useEffect(() => {
    return () => {
      cameraControllerRef.current?.setCardLayerEl(null);
    };
  }, []);

  if (birdsEye) {
    return null;
  }

  return (
    <div ref={layerRef} class="card-layer" data-graph-version={version}>
      {visibleIds.map((id) => {
        const node = nodesMap.get(id);
        return node ? <NodeCard key={id} node={node} /> : null;
      })}
    </div>
  );
}
