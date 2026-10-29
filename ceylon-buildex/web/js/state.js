// Tiny event bus + shared state, so view modules never import each other.
export const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, fn);
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, {detail}));
export const S = {status: null};
