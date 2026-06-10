import { Plus, Server } from 'lucide-react';
import NodeForm from './NodeForm';

// NodeList renders the "Nodes" header, one NodeForm per node, and the Add Node
// button. Per-node and per-function mutations are delegated to the parent
// (EnvironmentNew) so all form state stays in one place.
export default function NodeList({
  nodes,
  onUpdateNode,
  onAddNode,
  onRemoveNode,
  onAddFunction,
  onRemoveFunction,
  onUpdateFunction,
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-surface-300 uppercase tracking-wider flex items-center gap-2">
          <Server className="w-4 h-4" />Nodes ({nodes.length})
        </h2>
      </div>

      {nodes.map((node, i) => (
        <NodeForm
          key={i}
          node={node}
          index={i}
          canRemove={nodes.length > 1}
          onUpdate={(patch) => onUpdateNode(i, patch)}
          onRemove={() => onRemoveNode(i)}
          onAddFunction={() => onAddFunction(i)}
          onRemoveFunction={(fIdx) => onRemoveFunction(i, fIdx)}
          onUpdateFunction={(fIdx, patch) => onUpdateFunction(i, fIdx, patch)}
        />
      ))}
      <div className="flex justify-end">
        <button type="button" onClick={onAddNode} className="btn-secondary text-xs px-3 py-1.5">
          <Plus className="w-3.5 h-3.5" />Add Node
        </button>
      </div>
    </>
  );
}
