// Map adapters. GoogleMap: satellite + deck.gl GoogleMapsOverlay (production).
// PlainMap: deck.gl only, used when no Maps API key is configured (local dev / tests).
import { Deck, MapView, WebMercatorViewport, type Layer, type PickingInfo } from '@deck.gl/core';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { Loader } from '@googlemaps/js-api-loader';
import { WORLD, type LngLat, type ViewBox } from '@landmafia/shared';

export interface MapAdapter {
  readonly kind: 'google' | 'plain';
  setLayers(layers: Layer[]): void;
  getView(): ViewBox | null;
  getZoom(): number;
  panTo(p: LngLat): void;
  /** screen pixel of a coordinate (relative to the map container) */
  project(p: LngLat): [number, number] | null;
  size(): [number, number];
  onViewChange(cb: () => void): void;
  onUserDrag(cb: () => void): void;
  onClick(cb: (info: PickingInfo) => void): void;
  onHover(cb: (info: PickingInfo) => void): void;
  zoomBy(d: number): void;
}

const B = WORLD.bounds;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

function projectInBounds(view: ViewBox, size: [number, number], p: LngLat): [number, number] {
  const [w, s, e, n] = view;
  const x = ((p[0] - w) / (e - w)) * size[0];
  const y = ((mercY(n) - mercY(p[1])) / (mercY(n) - mercY(s))) * size[1];
  return [x, y];
}

export async function createGoogleMap(el: HTMLElement, apiKey: string, mapId: string): Promise<MapAdapter> {
  const loader = new Loader({ apiKey, version: 'weekly' });
  const { Map } = (await loader.importLibrary('maps')) as google.maps.MapsLibrary;
  const map = new Map(el, {
    center: WORLD.center,
    zoom: WORLD.defaultZoom,
    minZoom: WORLD.minZoom,
    maxZoom: WORLD.maxZoom,
    mapTypeId: 'satellite',
    ...(mapId ? { mapId } : {}),
    tilt: 0,
    heading: 0,
    disableDefaultUI: true,
    zoomControl: true,
    clickableIcons: false,
    keyboardShortcuts: false,
    gestureHandling: 'greedy',
    restriction: { latLngBounds: B, strictBounds: false },
    backgroundColor: '#20170e',
  });
  const overlay = new GoogleMapsOverlay({ layers: [] });
  overlay.setMap(map);
  let clickCb: ((i: PickingInfo) => void) | null = null;
  let hoverCb: ((i: PickingInfo) => void) | null = null;
  overlay.setProps({
    onClick: (i: PickingInfo) => clickCb?.(i),
    onHover: (i: PickingInfo) => hoverCb?.(i),
    getCursor: ({ isHovering }: { isHovering: boolean }) => (isHovering ? 'pointer' : 'grab'),
  });
  const getView = (): ViewBox | null => {
    const b = map.getBounds();
    if (!b) return null;
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    return [sw.lng(), sw.lat(), ne.lng(), ne.lat()];
  };
  const size = (): [number, number] => [el.clientWidth, el.clientHeight];
  return {
    kind: 'google',
    setLayers: (layers) => overlay.setProps({ layers }),
    getView,
    getZoom: () => map.getZoom() ?? WORLD.defaultZoom,
    panTo: (p) => map.setCenter({ lng: p[0], lat: p[1] }),
    project: (p) => {
      const v = getView();
      return v ? projectInBounds(v, size(), p) : null;
    },
    size,
    onViewChange: (cb) => map.addListener('idle', cb),
    onUserDrag: (cb) => map.addListener('dragstart', cb),
    onClick: (cb) => (clickCb = cb),
    onHover: (cb) => (hoverCb = cb),
    zoomBy: (d) => map.setZoom((map.getZoom() ?? WORLD.defaultZoom) + d),
  };
}

export function createPlainMap(el: HTMLElement): MapAdapter {
  let viewState: { longitude: number; latitude: number; zoom: number; pitch: number; bearing: number } = {
    longitude: WORLD.center.lng,
    latitude: WORLD.center.lat,
    zoom: WORLD.defaultZoom,
    pitch: 0,
    bearing: 0,
  };
  const viewCbs: (() => void)[] = [];
  const dragCbs: (() => void)[] = [];
  let clickCb: ((i: PickingInfo) => void) | null = null;
  let hoverCb: ((i: PickingInfo) => void) | null = null;
  let viewTimer = 0;
  const fireView = () => {
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => viewCbs.forEach((c) => c()), 120);
  };
  el.style.background =
    'radial-gradient(ellipse at center, #3b4a2c, #26301d 70%), repeating-linear-gradient(45deg, #2f3b24 0 6px, #2b3621 6px 12px)';
  const deck = new Deck({
    parent: el as HTMLDivElement,
    views: new MapView({ repeat: false }),
    viewState,
    controller: { dragRotate: false, touchRotate: false, keyboard: false, doubleClickZoom: true },
    onViewStateChange: ({ viewState: vs, interactionState }: any) => {
      viewState = {
        ...vs,
        longitude: clamp(vs.longitude, B.west, B.east),
        latitude: clamp(vs.latitude, B.south, B.north),
        zoom: clamp(vs.zoom, WORLD.minZoom, WORLD.maxZoom),
        pitch: 0,
        bearing: 0,
      };
      deck.setProps({ viewState });
      if (interactionState?.isDragging) dragCbs.forEach((c) => c());
      fireView();
    },
    onClick: (i: PickingInfo) => clickCb?.(i),
    onHover: (i: PickingInfo) => hoverCb?.(i),
    getCursor: ({ isHovering, isDragging }: any) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    layers: [],
  });
  const size = (): [number, number] => [el.clientWidth, el.clientHeight];
  const vp = () => new WebMercatorViewport({ ...viewState, width: el.clientWidth || 1, height: el.clientHeight || 1 });
  return {
    kind: 'plain',
    setLayers: (layers) => deck.setProps({ layers }),
    getView: () => {
      const [w, s, e, n] = vp().getBounds();
      return [w, s, e, n];
    },
    getZoom: () => viewState.zoom,
    panTo: (p) => {
      viewState = { ...viewState, longitude: p[0], latitude: p[1] };
      deck.setProps({ viewState });
      fireView();
    },
    project: (p) => {
      const [x, y] = vp().project(p);
      return [x, y];
    },
    size,
    onViewChange: (cb) => viewCbs.push(cb),
    onUserDrag: (cb) => dragCbs.push(cb),
    onClick: (cb) => (clickCb = cb),
    onHover: (cb) => (hoverCb = cb),
    zoomBy: (d) => {
      viewState = { ...viewState, zoom: clamp(viewState.zoom + d, WORLD.minZoom, WORLD.maxZoom) };
      deck.setProps({ viewState });
      fireView();
    },
  };
}
