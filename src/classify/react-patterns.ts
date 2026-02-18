/**
 * React hook classification rules.
 *
 * Determines whether a hook's callback is a PureComputation candidate
 * or must stay on the client.
 */

/** Hooks whose callbacks are PureComputation candidates if the body is pure */
export const EXTRACTABLE_HOOKS = new Set([
  'useMemo',
  'useCallback',
]);

/** Hooks whose callbacks must always stay on client (side effects) */
export const CLIENT_ONLY_HOOKS = new Set([
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
]);

/** Hooks that are neutral — they don't indicate server or client */
export const NEUTRAL_HOOKS = new Set([
  'useState',
  'useReducer',
  'useRef',
  'useContext',
  'useId',
  'useSyncExternalStore',
  'useTransition',
  'useDeferredValue',
  'useImperativeHandle',
  'useDebugValue',
]);

/** JSX event handler prop names (callbacks that receive browser events) */
export const EVENT_HANDLER_PROPS = new Set([
  'onClick',
  'onChange',
  'onSubmit',
  'onInput',
  'onFocus',
  'onBlur',
  'onKeyDown',
  'onKeyUp',
  'onKeyPress',
  'onMouseDown',
  'onMouseUp',
  'onMouseMove',
  'onMouseEnter',
  'onMouseLeave',
  'onMouseOver',
  'onMouseOut',
  'onTouchStart',
  'onTouchEnd',
  'onTouchMove',
  'onDrag',
  'onDragStart',
  'onDragEnd',
  'onDragOver',
  'onDragEnter',
  'onDragLeave',
  'onDrop',
  'onScroll',
  'onWheel',
  'onResize',
  'onLoad',
  'onError',
  'onContextMenu',
  'onDoubleClick',
  'onCopy',
  'onCut',
  'onPaste',
  'onSelect',
  'onAnimationStart',
  'onAnimationEnd',
  'onAnimationIteration',
  'onTransitionEnd',
  'onPointerDown',
  'onPointerUp',
  'onPointerMove',
  'onPointerEnter',
  'onPointerLeave',
  'onPointerOver',
  'onPointerOut',
]);
