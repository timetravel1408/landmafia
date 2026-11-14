// On-disk formats produced by tools/build-graph.ts.
// Coordinates are flat [lng, lat, lng, lat, ...] arrays rounded to 6 decimals.

/** data/graph.json.gz — the drivable road graph (server only). */
export interface GraphFile {
  version: 1;
  /** Flat node coords; node i = [nodes[2i], nodes[2i+1]]. Nodes are intersections / dead ends. */
  nodes: number[];
  /** Edge i joins a[i] -> b[i]; pts[i] is its flat polyline from a to b. */
  a: number[];
  b: number[];
  /** Length in metres. */
  len: number[];
  /** Block on the left / right of the edge travelling a -> b (-1 = none). */
  l: number[];
  r: number[];
  pts: number[][];
}

/** data/blocks.json.gz — city blocks, faces of the planar road graph. */
export interface BlocksFile {
  version: 1;
  /** Flat outer ring of each block. */
  ring: number[][];
  /** Area in m². */
  area: number[];
  /** Locality index into LOCALITIES (-1 = outskirts). */
  loc: number[];
  /** Interior point (used for loop-closure tests and labels). */
  cx: number[];
  cy: number[];
}

/** data/tiles/<tx>_<ty>.json.gz — client geometry tile. */
export interface TileFile {
  key: string;
  /** [blockId, ...flatRing] */
  blocks: number[][];
  /** [edgeId, a, b, l, r, ...flatPts] */
  edges: number[][];
  /** [nodeId, lng, lat] */
  nodes: number[][];
}

/** data/index.json.gz — lightweight per-block info for the minimap & tooltips (client). */
export interface BlockIndexFile {
  version: 1;
  count: number;
  /** Interior point, quantised: round(lng*1e5), round(lat*1e5). */
  cx: number[];
  cy: number[];
  /** Area in m², rounded. */
  area: number[];
  loc: number[];
  /** Tile keys that exist. */
  tiles: string[];
}
